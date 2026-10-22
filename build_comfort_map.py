"""建置台灣鄉鎮代表點的 1991–2020 日資料與月氣候統計。

NASA POWER 的 MERRA-2（約 0.5°）搭配 Open-Meteo 地形高度，
將氣溫與露點修正到鄉鎮代表點；雨量、風速與估計日照留在粗網格。
--weather-details-from-cache 只讀取既有資料與原始 JSON，不下載或重建日資料。
"""

from __future__ import annotations

import argparse
import calendar
import json
import math
import os
import shutil
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path
from typing import TypedDict

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'data'
CACHE = Path(os.environ['TEMP']) / '台灣舒適度地圖'
GEOJSON_URL = (
    'https://github.com/plotdb/pdmaptw/releases/download/v2.4.0/town-2025-03-18.geojson'
)
START = date(1991, 1, 1)
END = date(2020, 12, 31)
YEARS = 30
# 本島、澎湖、金門、馬祖。排除旗津所轄東沙／太平島，以及頭城所轄釣魚臺。
NEAR_LON = (118.0, 122.35)
NEAR_LAT = (21.8, 26.55)
TEMP_LAPSE = 6.5
DEW_LAPSE = 1.8
RANGES = (
    ('19910101', '20001231'),
    ('20010101', '20101231'),
    ('20110101', '20201231'),
)
POWER_PARAMS = (
    'T2M_MAX',
    'T2M_MIN',
    'T2MDEW',
    'PRECTOTCORR',
    'ALLSKY_SFC_SW_DWN',
    'CLRSKY_SFC_SW_DWN',
    'WS10M_MAX',
)


class MonthlyWeather(TypedDict):
    tmax: float | None
    tmin: float | None
    precip: float | None
    validYears: dict[str, int]


class GridWeather(TypedDict):
    lat: float
    lon: float
    rain: list[float | None]


class TownWeather(TypedDict):
    code: str
    cell: int
    monthly: list[MonthlyWeather]


class WeatherDetails(TypedDict):
    version: int
    start: str
    end: str
    days: int
    years: int
    grids: list[GridWeather]
    cellGrid: list[int]
    towns: list[TownWeather]


def expected_dates() -> list[date]:
    days: list[date] = []
    cursor = START
    while cursor <= END:
        days.append(cursor)
        cursor += timedelta(days=1)
    return days


def ring_area(ring: list[list[float]]) -> float:
    area = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        area += x1 * y2 - x2 * y1
    return area / 2.0


def ring_centroid(ring: list[list[float]]) -> tuple[float, float]:
    area = ring_area(ring)
    if abs(area) < 1e-12:
        return ring[0][0], ring[0][1]
    cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        cross = x1 * y2 - x2 * y1
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    return cx / (6.0 * area), cy / (6.0 * area)


def point_in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    inside = False
    j = len(ring) - 1
    for i, (xi, yi) in enumerate(ring):
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat):
            x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_cross:
                inside = not inside
        j = i
    return inside


def point_in_polygon(lon: float, lat: float, rings: list[list[list[float]]]) -> bool:
    if not point_in_ring(lon, lat, rings[0]):
        return False
    return all(not point_in_ring(lon, lat, hole) for hole in rings[1:])


def interior_point(rings: list[list[list[float]]]) -> tuple[float, float]:
    outer = rings[0]
    lon, lat = ring_centroid(outer)
    if point_in_polygon(lon, lat, rings):
        return lon, lat
    lons = [point[0] for point in outer]
    lats = [point[1] for point in outer]
    min_lon, max_lon = min(lons), max(lons)
    min_lat, max_lat = min(lats), max(lats)
    best: tuple[float, float, float] | None = None
    for iy in range(1, 8):
        for ix in range(1, 8):
            x = min_lon + (max_lon - min_lon) * ix / 8
            y = min_lat + (max_lat - min_lat) * iy / 8
            if not point_in_polygon(x, y, rings):
                continue
            dist = (x - lon) ** 2 + (y - lat) ** 2
            if best is None or dist < best[0]:
                best = (dist, x, y)
    if best is not None:
        return best[1], best[2]
    return lon, lat


def iter_polygons(geometry: dict) -> list[list[list[list[float]]]]:
    if geometry['type'] == 'Polygon':
        return [geometry['coordinates']]
    if geometry['type'] == 'MultiPolygon':
        return geometry['coordinates']
    raise ValueError(geometry['type'])


def in_near(lon: float, lat: float) -> bool:
    return NEAR_LON[0] <= lon <= NEAR_LON[1] and NEAR_LAT[0] <= lat <= NEAR_LAT[1]


def representative_point(geometry: dict) -> tuple[float, float]:
    polygons = iter_polygons(geometry)
    near = []
    for polygon in polygons:
        lon, lat = ring_centroid(polygon[0])
        if in_near(lon, lat):
            near.append(polygon)
    chosen = max(near or polygons, key=lambda polygon: abs(ring_area(polygon[0])))
    return interior_point(chosen)


def snap_power(lat: float, lon: float) -> tuple[float, float]:
    snapped_lat = round(lat * 2) / 2
    snapped_lon = round(lon / 0.625) * 0.625
    return round(snapped_lat, 4), round(snapped_lon, 4)


def half_up(value: float) -> int:
    if value >= 0:
        return int(math.floor(value + 0.5))
    return int(math.ceil(value - 0.5))


def enc_temp(value: float | None) -> int:
    if value is None:
        return 255
    return max(0, min(254, half_up((value + 40.0) * 2.0)))


def enc_precip(value: float | None) -> int:
    if value is None:
        return 255
    if value < 1:
        return 0
    return max(1, min(254, half_up(value)))


def enc_sun(seconds: float | None) -> int:
    if seconds is None:
        return 255
    return max(0, min(254, half_up(seconds / 1800.0)))


def enc_wind(value: float | None) -> int:
    if value is None:
        return 255
    return max(0, min(254, half_up(value)))


def dec_temp(quantum: int) -> float | None:
    if quantum == 255:
        return None
    return quantum / 2 - 40


def daylight_hours(lat: float, when: date) -> float:
    decl = math.radians(23.45 * math.sin(math.radians(360.0 * (284 + when.timetuple().tm_yday) / 365.0)))
    cos_hour = -math.tan(math.radians(lat)) * math.tan(decl)
    cos_hour = min(1.0, max(-1.0, cos_hour))
    return 24.0 * math.acos(cos_hour) / math.pi


def clean(value: object) -> float | None:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    if value <= -900:
        return None
    return float(value)


def ensure_geojson(source: Path) -> dict:
    CACHE.mkdir(parents=True, exist_ok=True)
    if not source.exists():
        print(f'下載界線 {GEOJSON_URL}', flush=True)
        urllib.request.urlretrieve(GEOJSON_URL, source)
    return json.loads(source.read_text(encoding='utf-8'))


def request_json(url: str) -> dict:
    last_error: Exception | None = None
    for _attempt in range(6):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'taiwan-comfort-map/1.0'})
            with urllib.request.urlopen(request, timeout=180) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            body = error.read().decode('utf-8', 'replace')
            error.close()
            last_error = error
            print(f'HTTP {error.code} {body[:160]}', flush=True)
            time.sleep(20)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            print(f'{error}，8 秒後重試', flush=True)
            time.sleep(8)
    raise RuntimeError(last_error)


def fetch_elevations(points: list[tuple[float, float]]) -> list[float]:
    found: list[float] = []
    for offset in range(0, len(points), 40):
        batch = points[offset:offset + 40]
        query = urllib.parse.urlencode({
            'latitude': ','.join(f'{lat:.4f}' for _lon, lat in batch),
            'longitude': ','.join(f'{lon:.4f}' for lon, _lat in batch),
        })
        payload = request_json(f'https://api.open-meteo.com/v1/elevation?{query}')
        values = payload['elevation']
        if len(values) != len(batch):
            raise RuntimeError('地形高度筆數不合')
        for value in values:
            found.append(0.0 if value is None else float(value))
    return found


def fetch_power_cell(lat: float, lon: float, cache_dir: Path) -> tuple[float, dict[str, dict[str, float]]]:
    merged = {name: {} for name in POWER_PARAMS}
    cell_elev = 0.0
    for start, end in RANGES:
        path = cache_dir / f'{lat:.4f}_{lon:.4f}_{start}.json'
        if path.exists():
            try:
                payload = json.loads(path.read_text(encoding='utf-8'))
            except json.JSONDecodeError:
                payload = None
        else:
            payload = None
        if payload is None:
            query = urllib.parse.urlencode({
                'parameters': ','.join(POWER_PARAMS),
                'community': 'RE',
                'longitude': f'{lon:.4f}',
                'latitude': f'{lat:.4f}',
                'start': start,
                'end': end,
                'format': 'JSON',
                'time-standard': 'LST',
            })
            payload = request_json('https://power.larc.nasa.gov/api/temporal/daily/point?' + query)
            path.write_text(json.dumps(payload), encoding='utf-8')
            time.sleep(0.3)
        cell_elev = float(payload['geometry']['coordinates'][2])
        parameter = payload['properties']['parameter']
        for name in POWER_PARAMS:
            merged[name].update(parameter[name])
    return cell_elev, merged


def sunshine_seconds(allsky: float | None, clearsky: float | None, lat: float, when: date) -> float | None:
    if allsky is None or clearsky is None or clearsky <= 0.2:
        return None
    ratio = min(1.0, max(0.0, allsky / clearsky))
    return daylight_hours(lat, when) * ratio * 3600.0


def pack_town(
    merged: dict[str, dict[str, float]],
    dates: list[date],
    power_elev: float,
    local_elev: float,
    lat: float,
) -> bytes:
    temp_delta = (power_elev - local_elev) / 1000.0 * TEMP_LAPSE
    dew_delta = (power_elev - local_elev) / 1000.0 * DEW_LAPSE
    count = len(dates)
    out = bytearray(count * 6)
    for index, when in enumerate(dates):
        key = when.strftime('%Y%m%d')
        tmax = clean(merged['T2M_MAX'].get(key))
        tmin = clean(merged['T2M_MIN'].get(key))
        dew = clean(merged['T2MDEW'].get(key))
        rain = clean(merged['PRECTOTCORR'].get(key))
        sun = sunshine_seconds(
            clean(merged['ALLSKY_SFC_SW_DWN'].get(key)),
            clean(merged['CLRSKY_SFC_SW_DWN'].get(key)),
            lat,
            when,
        )
        wind = clean(merged['WS10M_MAX'].get(key))
        out[index] = enc_temp(None if tmax is None else tmax + temp_delta)
        out[count + index] = enc_temp(None if tmin is None else tmin + temp_delta)
        out[2 * count + index] = enc_temp(None if dew is None else dew + dew_delta)
        out[3 * count + index] = enc_precip(rain)
        out[4 * count + index] = enc_sun(sun)
        out[5 * count + index] = enc_wind(None if wind is None else wind * 3.6)
    return bytes(out)


def annual_days(series: bytes, days: int, lo: float, hi: float, months: list[int], month: int | None) -> float:
    matched = 0
    for day in range(days):
        if month is not None and months[day] != month:
            continue
        temp = dec_temp(series[day])
        if temp is None or temp < lo or temp > hi:
            continue
        matched += 1
    return matched / YEARS


def read_json_object(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f'無法讀取 JSON：{path}：{error}') from error
    if not isinstance(payload, dict):
        raise ValueError(f'JSON 必須是物件：{path}')
    return payload


def validate_weather_inputs(data_dir: Path) -> tuple[dict, bytes, list[date]]:
    meta = read_json_object(data_dir / 'meta.json')
    dates = expected_dates()
    expected = {
        'start': START.isoformat(),
        'end': END.isoformat(),
        'days': len(dates),
        'years': YEARS,
        'months': [when.month for when in dates],
        'variables': ['tmax', 'tmin', 'dewpoint', 'precip', 'sunshine', 'wind'],
    }
    for name, value in expected.items():
        if meta.get(name) != value:
            raise ValueError(f'meta.json 的 {name} 與 1991–2020 資料格式不符')
    cells, towns = meta.get('cells'), meta.get('towns')
    if not isinstance(cells, list) or not cells:
        raise ValueError('meta.json 缺少 cells')
    if not isinstance(towns, list) or len(towns) != len(cells):
        raise ValueError('meta.json 的 towns 與 cells 筆數不符')
    for cell in cells:
        if not isinstance(cell, dict) or any(
            not isinstance(cell.get(name), (int, float))
            or isinstance(cell.get(name), bool)
            or not math.isfinite(cell[name])
            for name in ('lat', 'lon')
        ):
            raise ValueError('meta.json 的鄉鎮座標無效')
    town_cells: set[int] = set()
    town_codes: set[str] = set()
    for town in towns:
        if not isinstance(town, dict):
            raise ValueError('meta.json 的鄉鎮格式無效')
        cell, code = town.get('cell'), town.get('code')
        if type(cell) is not int or not 0 <= cell < len(cells):
            raise ValueError('meta.json 的鄉鎮 cell 索引無效')
        if not isinstance(code, str) or not code or code in town_codes or cell in town_cells:
            raise ValueError('meta.json 的鄉鎮 code/cell 缺失或重複')
        town_cells.add(cell)
        town_codes.add(code)
    climate = (data_dir / 'climate.bin').read_bytes()
    if len(climate) < 16 or climate[:4] != b'CWCM' or climate[4] != 1:
        raise ValueError('climate.bin 的 magic 或版本無效')
    cell_count, day_count, var_count = struct.unpack_from('<HHH', climate, 6)
    if (cell_count, day_count, var_count) != (len(cells), len(dates), 6):
        raise ValueError('climate.bin 檔頭與 meta.json 的維度不符')
    if len(climate) != 16 + cell_count * day_count * var_count:
        raise ValueError('climate.bin 的檔案長度與檔頭不符')
    return meta, climate, dates


def read_cached_grid_rain(
    grid: tuple[float, float],
    dates: list[date],
    cache_dir: Path,
) -> list[float | None]:
    lat, lon = grid
    rain_by_date: dict[str, float | None] = {}
    date_keys = [when.strftime('%Y%m%d') for when in dates]
    for start, end in RANGES:
        path = cache_dir / f'{lat:.4f}_{lon:.4f}_{start}.json'
        payload = read_json_object(path)
        try:
            coordinates = payload['geometry']['coordinates']
            header = payload['header']
            units = payload['parameters']['PRECTOTCORR']['units']
            raw_rain = payload['properties']['parameter']['PRECTOTCORR']
        except (KeyError, TypeError) as error:
            raise ValueError(f'POWER cache 缺少必要欄位：{path}') from error
        if (
            not isinstance(coordinates, list)
            or len(coordinates) < 2
            or coordinates[:2] != [lon, lat]
            or not isinstance(header, dict)
            or str(header.get('start')) != start
            or str(header.get('end')) != end
            or units != 'mm/day'
        ):
            raise ValueError(f'POWER cache 座標、期間或雨量單位不符：{path}')
        expected_keys = {key for key in date_keys if start <= key <= end}
        if not isinstance(raw_rain, dict) or set(raw_rain) != expected_keys:
            raise ValueError(f'POWER cache 日期缺漏或超出期間：{path}')
        for key, value in raw_rain.items():
            if (
                not isinstance(value, (int, float))
                or isinstance(value, bool)
                or not math.isfinite(value)
                or -900 < value < 0
            ):
                raise ValueError(f'POWER cache 雨量無效：{path}：{key}')
            rain_by_date[key] = clean(value)
    if set(rain_by_date) != set(date_keys):
        raise ValueError(f'POWER cache 合併後日期不符：{grid}')
    return [rain_by_date[key] for key in date_keys]


def monthly_climatology(
    dates: list[date],
    values: list[float | None],
    cumulative: bool = False,
) -> tuple[list[float | None], list[int]]:
    by_year_month: dict[tuple[int, int], list[float | None]] = {}
    for when, value in zip(dates, values, strict=True):
        by_year_month.setdefault((when.year, when.month), []).append(value)
    monthly_values: list[list[float]] = [[] for _ in range(12)]
    for (year, month), year_values in by_year_month.items():
        if len(year_values) != calendar.monthrange(year, month)[1]:
            continue
        if any(value is None for value in year_values):
            continue
        total = math.fsum(value for value in year_values if value is not None)
        monthly_values[month - 1].append(total if cumulative else total / len(year_values))
    averages = [math.fsum(values) / len(values) if values else None for values in monthly_values]
    return averages, [len(values) for values in monthly_values]


def build_weather_details_from_cache(
    data_dir: Path = DATA,
    cache_dir: Path = CACHE / 'power',
) -> Path:
    meta, climate, dates = validate_weather_inputs(data_dir)
    cell_grids = [snap_power(cell['lat'], cell['lon']) for cell in meta['cells']]
    grid_keys = sorted(set(cell_grids))
    grid_indices = {key: index for index, key in enumerate(grid_keys)}
    grids: list[GridWeather] = [
        {'lat': lat, 'lon': lon, 'rain': read_cached_grid_rain((lat, lon), dates, cache_dir)}
        for lat, lon in grid_keys
    ]
    rain_monthly = [monthly_climatology(dates, grid['rain'], cumulative=True) for grid in grids]
    cell_grid_indices = [grid_indices[key] for key in cell_grids]
    day_count, cell_count = len(dates), len(meta['cells'])
    towns: list[TownWeather] = []
    for town in meta['towns']:
        cell = town['cell']
        high_start = 16 + cell * day_count
        low_start = 16 + (cell_count + cell) * day_count
        highs, high_years = monthly_climatology(
            dates, [dec_temp(value) for value in climate[high_start:high_start + day_count]],
        )
        lows, low_years = monthly_climatology(
            dates, [dec_temp(value) for value in climate[low_start:low_start + day_count]],
        )
        rain, rain_years = rain_monthly[cell_grid_indices[cell]]
        towns.append({
            'code': town['code'],
            'cell': cell,
            'monthly': [
                {
                    'tmax': highs[month],
                    'tmin': lows[month],
                    'precip': rain[month],
                    'validYears': {
                        'tmax': high_years[month],
                        'tmin': low_years[month],
                        'precip': rain_years[month],
                    },
                }
                for month in range(12)
            ],
        })
    details: WeatherDetails = {
        'version': 1,
        'start': meta['start'],
        'end': meta['end'],
        'days': day_count,
        'years': meta['years'],
        'grids': grids,
        'cellGrid': cell_grid_indices,
        'towns': towns,
    }
    serialized = json.dumps(details, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    destination = data_dir / 'weather-details.json'
    destination.write_text(serialized, encoding='utf-8')
    return destination


def main() -> None:
    dates = expected_dates()
    source = CACHE / 'town-2025-03-18.geojson'
    collection = ensure_geojson(source)
    features = collection['features']
    points = [representative_point(feature['geometry']) for feature in features]
    elevations = fetch_elevations(points)
    print(f'鄉鎮 {len(features)} 個，日數 {len(dates)}', flush=True)

    groups: dict[tuple[float, float], list[int]] = {}
    for index, (lon, lat) in enumerate(points):
        groups.setdefault(snap_power(lat, lon), []).append(index)
    print(f'POWER 網格 {len(groups)}', flush=True)

    cell_dir = CACHE / 'power'
    cell_dir.mkdir(parents=True, exist_ok=True)
    downloaded: dict[tuple[float, float], tuple[float, dict[str, dict[str, float]]]] = {}

    def job(key: tuple[float, float]) -> tuple[tuple[float, float], tuple[float, dict]]:
        return key, fetch_power_cell(key[0], key[1], cell_dir)

    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(job, key) for key in groups]
        done = 0
        for future in as_completed(futures):
            key, payload = future.result()
            downloaded[key] = payload
            done += 1
            if done % 5 == 0 or done == len(groups):
                print(f'已取得 {done}/{len(groups)}', flush=True)

    days = len(dates)
    variables = 6
    series_parts: list[bytes] = []
    cells = []
    for feature_index, feature in enumerate(features):
        lon, lat = points[feature_index]
        power_elev, merged = downloaded[snap_power(lat, lon)]
        local_elev = elevations[feature_index]
        series_parts.append(pack_town(merged, dates, power_elev, local_elev, lat))
        cells.append({
            'lat': round(lat, 4),
            'lon': round(lon, 4),
            'elev': round(local_elev),
            'power_elev': round(power_elev),
        })

    header = bytearray(16)
    header[0:4] = b'CWCM'
    header[4] = 1
    struct.pack_into('<HHH', header, 6, len(cells), days, variables)
    plane = bytearray(len(cells) * days * variables)
    for cell_index, packed in enumerate(series_parts):
        for var in range(variables):
            src = var * days
            dst = (var * len(cells) + cell_index) * days
            plane[dst:dst + days] = packed[src:src + days]

    months = [item.month for item in dates]
    towns = []
    for feature_index, feature in enumerate(features):
        props = feature['properties']
        lon, lat = points[feature_index]
        towns.append({
            'code': props['code'],
            'name': props['name'],
            'county': props['county'],
            'town': props['town'],
            'cell': feature_index,
            'lat': round(lat, 4),
            'lon': round(lon, 4),
        })

    meta = {
        'start': START.isoformat(),
        'end': END.isoformat(),
        'years': YEARS,
        'days': days,
        'months': months,
        'variables': ['tmax', 'tmin', 'dewpoint', 'precip', 'sunshine', 'wind'],
        'encoding': {
            'temp': 'uint8 = round((celsius + 40) * 2)，255 缺值；氣溫與露點已做高度修正',
            'precip': '毫米四捨五入；小於 1 記 0，255 缺值',
            'sunshine': '估計日照時數的兩倍，255 缺值',
            'wind': '公里/小時四捨五入，255 缺值',
        },
        'model': 'NASA POWER MERRA-2，氣溫每公里 -6.5°C、露點每公里 -1.8°C 修正到 Open-Meteo 地形高度',
        'cells': cells,
        'towns': towns,
    }

    DATA.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, DATA / 'towns.geojson')
    (DATA / 'climate.bin').write_bytes(bytes(header) + plane)
    (DATA / 'meta.json').write_text(json.dumps(meta, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'網格 {len(cells)}，climate.bin {(DATA / "climate.bin").stat().st_size} bytes', flush=True)

    watch = ('阿里山鄉', '仁愛鄉', '和平區', '魚池鄉', '屏東市', '恆春鎮', '前鎮區', '旗津區')
    print('20–28°C 每年天數（全年 / 7月）', flush=True)
    scored = []
    for town in towns:
        tmax = series_parts[town['cell']][0:days]
        year_days = annual_days(tmax, days, 20, 28, months, None)
        july_days = annual_days(tmax, days, 20, 28, months, 7)
        scored.append((year_days, town['name'], july_days, cells[town['cell']]['elev']))
        if town['town'] in watch:
            print(
                f"  {town['name']} 全年 {year_days:.1f}  7月 {july_days:.1f}  "
                f"海拔 {cells[town['cell']]['elev']} m",
                flush=True,
            )
    scored.sort(reverse=True)
    print('最多', ', '.join(f'{name} {value:.1f}' for value, name, _, _ in scored[:8]), flush=True)
    print('最少', ', '.join(f'{name} {value:.1f}' for value, name, _, _ in scored[-8:]), flush=True)


def run_cli(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--weather-details-from-cache',
        action='store_true',
        help='只讀既有 POWER cache 與地圖資料，產生 weather-details.json；不下載或重建原資料',
    )
    args = parser.parse_args(argv)
    if args.weather_details_from_cache:
        try:
            output = build_weather_details_from_cache()
        except (ValueError, OSError) as error:
            parser.error(str(error))
        print(f'已產生 {output}，{output.stat().st_size} bytes', flush=True)
    else:
        main()


if __name__ == '__main__':
    run_cli()
