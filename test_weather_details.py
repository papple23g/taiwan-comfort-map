from __future__ import annotations

import json
import struct
from datetime import date, timedelta
from pathlib import Path

import pytest

import build_comfort_map as builder


def dates_between(start: date, end: date) -> list[date]:
    return [start + timedelta(days=index) for index in range((end - start).days + 1)]


@pytest.fixture(autouse=True)
def block_downloads(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*args: object, **kwargs: object) -> None:
        pytest.fail('cache-only 入口不應執行下載或原始 main')

    for name in ('main', 'fetch_power_cell', 'fetch_elevations', 'request_json'):
        monkeypatch.setattr(builder, name, forbidden)
    monkeypatch.setattr(builder.urllib.request, 'urlopen', forbidden)
    monkeypatch.setattr(builder.urllib.request, 'urlretrieve', forbidden)


@pytest.fixture
def cached_inputs(tmp_path: Path) -> tuple[Path, Path]:
    data_dir, cache_dir = tmp_path / 'data', tmp_path / 'power'
    data_dir.mkdir()
    cache_dir.mkdir()
    dates = builder.expected_dates()
    day_count = len(dates)
    meta = {
        'start': '1991-01-01', 'end': '2020-12-31',
        'days': day_count, 'years': 30,
        'months': [when.month for when in dates],
        'variables': ['tmax', 'tmin', 'dewpoint', 'precip', 'sunshine', 'wind'],
        'cells': [{'lat': 23.0, 'lon': 120.625, 'elev': 2000, 'power_elev': 0}],
        'towns': [{'code': 'town-code', 'cell': 0}],
    }
    (data_dir / 'meta.json').write_text(json.dumps(meta), encoding='utf-8')
    header = bytearray(16)
    header[:4] = b'CWCM'
    header[4] = 1
    struct.pack_into('<HHH', header, 6, 1, day_count, 6)
    climate = bytes(header) + bytes([120]) * day_count + bytes([100]) * day_count
    climate += bytes([255]) * day_count * 4
    (data_dir / 'climate.bin').write_bytes(climate)
    for start, end in builder.RANGES:
        rain = {
            when.strftime('%Y%m%d'): 0.4
            for when in dates if start <= when.strftime('%Y%m%d') <= end
        }
        if '20071006' in rain:
            rain['20071006'] = 331.05
        payload = {
            'geometry': {'coordinates': [120.625, 23.0, 0]},
            'header': {'start': start, 'end': end},
            'parameters': {'PRECTOTCORR': {'units': 'mm/day'}},
            'properties': {'parameter': {'PRECTOTCORR': rain}},
        }
        (cache_dir / f'23.0000_120.6250_{start}.json').write_text(
            json.dumps(payload), encoding='utf-8',
        )
    return data_dir, cache_dir


def test_monthly_normals_weight_years_equally_and_include_leap_day() -> None:
    dates = dates_between(date(1999, 1, 1), date(2000, 12, 31))
    temperatures = [10.0 if when.year == 1999 else 30.0 for when in dates]
    averages, valid_years = builder.monthly_climatology(dates, temperatures)
    rain, rain_years = builder.monthly_climatology(dates, [1.0] * len(dates), cumulative=True)
    assert averages == [20.0] * 12
    assert valid_years == rain_years == [2] * 12
    assert rain[1] == 28.5
    assert rain[0] == 31.0


def test_missing_values_exclude_whole_year_month_without_zero_fill() -> None:
    dates = dates_between(date(1999, 1, 1), date(2000, 12, 31))
    temperatures: list[float | None] = [10.0 if when.year == 1999 else 30.0 for when in dates]
    temperatures[dates.index(date(1999, 2, 1))] = None
    averages, years = builder.monthly_climatology(dates, temperatures)
    assert averages[1] == 30.0
    assert years[1] == 1
    assert years[0] == 2
    missing, no_years = builder.monthly_climatology(dates, [None] * len(dates), cumulative=True)
    assert missing == [None] * 12
    assert no_years == [0] * 12
    partial, partial_years = builder.monthly_climatology(dates[:15], [1.0] * 15, cumulative=True)
    assert partial == [None] * 12
    assert partial_years == [0] * 12


def test_generated_contract_preserves_raw_rain_and_existing_temperature_correction(
    cached_inputs: tuple[Path, Path],
) -> None:
    data_dir, cache_dir = cached_inputs
    source_paths = [data_dir / 'meta.json', data_dir / 'climate.bin', *cache_dir.glob('*.json')]
    before = {path: path.read_bytes() for path in source_paths}
    output = builder.build_weather_details_from_cache(data_dir, cache_dir)
    details = json.loads(output.read_text(encoding='utf-8'))
    assert details['version'] == 1
    assert details['days'] == 10958
    assert details['cellGrid'] == [0]
    assert len(details['grids']) == 1
    assert details['grids'][0]['rain'][0] == 0.4
    storm_index = (date(2007, 10, 6) - date(1991, 1, 1)).days
    assert details['grids'][0]['rain'][storm_index] == 331.05
    assert len(details['towns'][0]['monthly']) == 12
    january = details['towns'][0]['monthly'][0]
    assert january == {
        'tmax': 20.0, 'tmin': 10.0, 'precip': pytest.approx(12.4),
        'validYears': {'tmax': 30, 'tmin': 30, 'precip': 30},
    }
    assert details['towns'][0]['monthly'][1]['precip'] == pytest.approx(848 * 0.4 / 30)
    assert details['towns'][0]['monthly'][9]['precip'] == pytest.approx(12.4 + (331.05 - 0.4) / 30)
    assert {path: path.read_bytes() for path in source_paths} == before


def test_raw_sentinel_excludes_only_rain_year_month(
    cached_inputs: tuple[Path, Path],
) -> None:
    data_dir, cache_dir = cached_inputs
    path = cache_dir / '23.0000_120.6250_19910101.json'
    payload = json.loads(path.read_text(encoding='utf-8'))
    payload['properties']['parameter']['PRECTOTCORR']['19910101'] = -999
    path.write_text(json.dumps(payload), encoding='utf-8')
    details = json.loads(builder.build_weather_details_from_cache(data_dir, cache_dir).read_text(encoding='utf-8'))
    assert details['grids'][0]['rain'][0] is None
    january = details['towns'][0]['monthly'][0]
    assert january['validYears'] == {'tmax': 30, 'tmin': 30, 'precip': 29}
    assert january['precip'] == pytest.approx(12.4)


@pytest.mark.parametrize('corruption', ['missing', 'broken', 'dates', 'header', 'units', 'negative'])
def test_bad_cache_fails_without_network_or_replacing_output(
    cached_inputs: tuple[Path, Path],
    corruption: str,
) -> None:
    data_dir, cache_dir = cached_inputs
    destination = data_dir / 'weather-details.json'
    destination.write_text('previous-output', encoding='utf-8')
    path = cache_dir / '23.0000_120.6250_19910101.json'
    payload = json.loads(path.read_text(encoding='utf-8'))
    if corruption == 'missing':
        path.unlink()
    elif corruption == 'broken':
        path.write_text('{', encoding='utf-8')
    else:
        if corruption == 'dates':
            del payload['properties']['parameter']['PRECTOTCORR']['19910101']
        elif corruption == 'header':
            payload['header']['end'] = '19991231'
        elif corruption == 'units':
            payload['parameters']['PRECTOTCORR']['units'] = 'inches/day'
        else:
            payload['properties']['parameter']['PRECTOTCORR']['19910101'] = -1
        path.write_text(json.dumps(payload), encoding='utf-8')
    with pytest.raises(ValueError):
        builder.build_weather_details_from_cache(data_dir, cache_dir)
    assert destination.read_text(encoding='utf-8') == 'previous-output'


@pytest.mark.parametrize('corruption', ['magic', 'version', 'dimensions', 'length', 'meta-dates'])
def test_bad_climate_input_fails_before_output(
    cached_inputs: tuple[Path, Path],
    corruption: str,
) -> None:
    data_dir, cache_dir = cached_inputs
    path = data_dir / 'climate.bin'
    climate = bytearray(path.read_bytes())
    if corruption == 'meta-dates':
        meta_path = data_dir / 'meta.json'
        meta = json.loads(meta_path.read_text(encoding='utf-8'))
        meta['start'] = '1990-01-01'
        meta_path.write_text(json.dumps(meta), encoding='utf-8')
    else:
        if corruption == 'magic':
            climate[:4] = b'NOPE'
        elif corruption == 'version':
            climate[4] = 2
        elif corruption == 'dimensions':
            struct.pack_into('<H', climate, 6, 2)
        else:
            climate.pop()
        path.write_bytes(climate)
    with pytest.raises(ValueError):
        builder.build_weather_details_from_cache(data_dir, cache_dir)
    assert not (data_dir / 'weather-details.json').exists()


def test_cli_cache_only_never_runs_main(
    cached_inputs: tuple[Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data_dir, cache_dir = cached_inputs
    build = builder.build_weather_details_from_cache

    def build_fixture() -> Path:
        return build(data_dir, cache_dir)

    monkeypatch.setattr(builder, 'build_weather_details_from_cache', build_fixture)
    builder.run_cli(['--weather-details-from-cache'])
    assert (data_dir / 'weather-details.json').is_file()
