const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
const scope = vm.createContext({document: {getElementById: () => ({})}});
vm.runInContext(script.slice(0, script.indexOf('\nload().then(')), scope);
const controls = {tempLo: 20, tempHi: 28, rainMode: 'wet', rainLo: 1, rainHi: 100, useSun: false, sunMin: 6, useWind: false, windMax: 30};

test('rain modes use exact decimals, inclusive finite bounds and an unlimited 100+ endpoint', () => {
  for (const [rain, dry, wet, finite] of [[0.99, true, false, false], [1, false, true, true], [99, false, true, true], [100, false, true, false], [331.05, false, true, false]]) {
    assert.equal(scope.rainMatches(rain, 'dry', 1, 100), dry);
    assert.equal(scope.rainMatches(rain, 'wet', 1, 100), wet);
    assert.equal(scope.rainMatches(rain, 'wet', 1, 99), finite);
  }
  assert.equal(scope.rainMatches(99, 'wet', 99, 99), true);
  assert.equal(scope.rainMatches(100, 'wet', 100, 100), true);
  assert.equal(scope.rainMatches(331.05, 'wet', 100, 100), true);
});

test('inactive weather restrictions accept missing values; active ones reject them', () => {
  for (const value of [null, undefined, NaN, -1]) {
    assert.equal(scope.rainMatches(value, 'any', 1, 100), true);
    assert.equal(scope.rainMatches(value, 'dry', 1, 100), false);
    assert.equal(scope.rainMatches(value, 'wet', 1, 100), false);
  }
  const any = {...controls, rainMode: 'any'};
  assert.equal(scope.matchesDay(28, 20, null, null, null, any), true);
  assert.equal(scope.matchesDay(28, 20, null, null, null, {...any, useSun: true}), false);
  assert.equal(scope.matchesDay(28, 20, null, null, null, {...any, useWind: true}), false);
  assert.equal(scope.matchesDay(null, 20, 0, 6, 20, any), false);
  assert.equal(scope.matchesDay(28.5, 20, 1, 6, 20, controls), false);
  assert.equal(scope.matchesDay(28, 20, 1, 6, 30, {...controls, useSun: true, useWind: true}), true);
});

test('dual ranges stop the moving handle at the other endpoint and allow equality', () => {
  const lo = {value: '35'}, hi = {value: '28'};
  scope.clampRange(lo, hi, lo);
  assert.equal(lo.value, '28');
  hi.value = '-5';
  scope.clampRange(lo, hi, hi);
  assert.equal(hi.value, '28');
  lo.value = '-5'; hi.value = '35';
  scope.clampRange(lo, hi, lo);
  assert.equal(lo.value, '-5');
  assert.equal(hi.value, '35');
});

test('monthly matching chart has a fixed 31 day axis, labels above bars and true zero height', () => {
  const markup = scope.matchingChart([0, 31, 1.2, ...Array(9).fill(0)]);
  const bars = [...markup.matchAll(/<rect class="month-bar"[^>]*y="([\d.]+)"[^>]*height="([\d.]+)"/g)];
  const labels = [...markup.matchAll(/class="bar-value"[^>]*y="([\d.]+)"[^>]*>([\d.]+)</g)];
  assert.equal(bars.length, 12);
  assert.equal(Number(bars[0][2]), 0);
  assert.equal(Number(bars[1][2]), 184);
  assert.equal(labels[0][2], '0.0');
  labels.forEach((label, index) => assert.ok(Number(label[1]) < Number(bars[index][1])));
  assert.match(markup, /平均舒適天數（天）/);
  assert.match(markup, /月份/);
});

test('supplemental data dates and mappings are checked before use', () => {
  const meta = JSON.parse(fs.readFileSync(`${__dirname}/data/meta.json`, 'utf8'));
  const details = JSON.parse(fs.readFileSync(`${__dirname}/data/weather-details.json`, 'utf8'));
  assert.equal(scope.validateWeather(details, meta), details);
  assert.throws(() => scope.validateWeather({...details, start: '1992-01-01'}, meta));
  assert.throws(() => scope.validateWeather({...details, cellGrid: [999]}, meta));
  const altered = structuredClone(details);
  altered.grids[0].rain[0] = -1;
  assert.throws(() => scope.validateWeather(altered, meta));
});

test('region filters cover every township exactly once and support unions and no selection', () => {
  const towns = JSON.parse(fs.readFileSync(`${__dirname}/data/meta.json`, 'utf8')).towns;
  const regions = ['北部', '中部', '南部', '東部', '離島'];
  const rows = towns.map((town, index) => ({...town, days: index / 10}));
  const groups = regions.map((region) => scope.rankTowns(rows, new Set([region]), 'days', 'descending'));
  assert.equal(groups.flat().length, towns.length);
  assert.equal(new Set(groups.flat().map((town) => town.code)).size, towns.length);
  assert.equal(scope.rankTowns(rows, new Set(regions), 'days', 'descending').length, towns.length);
  assert.equal(scope.rankTowns(rows, new Set(), 'days', 'descending').length, 0);
  assert.equal(scope.rankTowns(rows, new Set(['北部', '離島']), 'days', 'descending').length, groups[0].length + groups[4].length);
  assert.ok(groups[4].every((town) => ['澎湖縣', '金門縣', '連江縣'].includes(town.county)));
});

test('ranking sorts exact numeric days and Chinese names in both directions without mutating data', () => {
  const rows = [
    {code: '3', county: '臺北市', name: '臺北市中正區', days: 9.91},
    {code: '2', county: '臺北市', name: '臺北市中山區', days: 100},
    {code: '1', county: '臺北市', name: '臺北市大安區', days: 9.94}
  ];
  const regions = new Set(['北部']);
  const codes = (result) => Array.from(result, (town) => town.code);
  assert.deepEqual(codes(scope.rankTowns(rows, regions, 'days', 'descending')), ['2', '1', '3']);
  assert.deepEqual(codes(scope.rankTowns(rows, regions, 'days', 'ascending')), ['3', '1', '2']);
  const alphabetical = [...rows].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  assert.deepEqual(codes(scope.rankTowns(rows, regions, 'name', 'ascending')), codes(alphabetical));
  assert.deepEqual(codes(scope.rankTowns(rows, regions, 'name', 'descending')), codes(alphabetical.reverse()));
  const tied = rows.map((row) => ({...row, days: 0}));
  assert.deepEqual(codes(scope.rankTowns(tied, regions, 'days', 'descending')), codes([...rows].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))));
  assert.deepEqual(codes(rows), ['3', '2', '1']);
});

test('climate chart leaves missing data gaps and retains both labelled axes', () => {
  const monthly = Array.from({length: 12}, () => ({tmax: null, tmin: null, precip: null}));
  monthly[0] = {tmax: 30, tmin: 20, precip: 0};
  monthly[2] = {tmax: 32, tmin: 22, precip: 200};
  const markup = scope.climateChart(monthly);
  assert.match(markup, /氣溫（°C）/);
  assert.match(markup, /平均月累積雨量（毫米）/);
  assert.match(markup, /stroke-dasharray="6 4"/);
  assert.doesNotMatch(markup, /NaN|undefined/);
  assert.match(markup, /d="M[^L"]+ M/);
});

test('temperature range and accessible values stay synchronized for decimals, extremes and equality', () => {
  const input = () => ({value: '', min: '-5', max: '35', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }});
  const elements = {'tmax-lo': input(), 'tmax-hi': input(), 'tmax-read': {}, 'tmax-dual': {querySelector: () => ({style: {}})}};
  scope.document.getElementById = (id) => elements[id];
  for (const [lo, hi] of [['-5', '35'], ['19.5', '23'], ['20', '20']]) {
    elements['tmax-lo'].value = lo;
    elements['tmax-hi'].value = hi;
    scope.paintTemperature();
    assert.equal(elements['tmax-read'].textContent, `${lo}~${hi}℃`);
    assert.equal(elements['tmax-lo'].attributes['aria-valuetext'], `${lo}°C`);
    assert.equal(elements['tmax-hi'].attributes['aria-valuetext'], `${hi}°C`);
  }
});

test('town centering places rendered bounds in the viewport center at every existing scale', () => {
  const view = {x: 10, y: -20, w: 800, h: 1200};
  for (const box of [{x: 150, y: 200, width: 20, height: 40}, {x: -300, y: 900, width: 5, height: 2}]) {
    for (const scale of [1, 1.25, 4, 14]) {
      const result = scope.centeredTranslation(box, view, scale);
      assert.equal((box.x + box.width / 2) * scale + result.x, view.x + view.w / 2);
      assert.equal((box.y + box.height / 2) * scale + result.y, view.y + view.h / 2);
    }
  }
});

test('camera movement eases toward its target and stops exactly at 350 milliseconds', () => {
  const from = {x: 40, y: -100}, to = {x: -200, y: 300};
  assert.equal(scope.cameraPosition(from, to, 0).x, from.x);
  const middle = scope.cameraPosition(from, to, 175);
  assert.ok(middle.x < -80 && middle.x > to.x);
  assert.ok(middle.y > 100 && middle.y < to.y);
  for (const elapsed of [350, 700]) {
    const end = scope.cameraPosition(from, to, elapsed);
    assert.equal(end.x, to.x);
    assert.equal(end.y, to.y);
  }
});

function cameraHarness(reduced = false) {
  const frames = new Map();
  let id = 0, now = 0;
  const attributes = {};
  const state = vm.createContext({
    centeredTranslation: scope.centeredTranslation, cameraPosition: scope.cameraPosition,
    svg: {setAttribute(name, value) { attributes[name] = value; }},
    viewport: {setAttribute(name, value) { attributes[name] = value; }},
    window: {matchMedia: () => ({matches: reduced})},
    performance: {now: () => now},
    requestAnimationFrame(callback) { frames.set(++id, callback); return id; },
    cancelAnimationFrame(frame) { frames.delete(frame); },
    path: {getBBox: () => ({x: 100, y: 200, width: 20, height: 40})},
  });
  const cameraBlock = script.slice(script.indexOf('  let view ='), script.indexOf("  const select = $('town-select');"));
  vm.runInContext(`const vbW = 800, vbH = 1200; ${cameraBlock}`, state);
  return {state, frames, attributes, advance(time) {
    now = time;
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(time));
  }};
}

test('camera animations preserve scale, restart from current position and cancel for manual navigation', () => {
  const camera = cameraHarness();
  const run = (code) => vm.runInContext(code, camera.state);
  run('scale = 4; centerTown(path)');
  camera.advance(100);
  assert.equal(run('scale'), 4);
  const current = run('tx');
  run('centerTown(path)');
  camera.advance(100);
  assert.equal(run('tx'), current);
  camera.advance(450);
  assert.equal(run('tx'), 400 - 110 * 4);
  assert.equal(run('ty'), 600 - 220 * 4);
  assert.equal(camera.frames.size, 0);
  run('centerTown(path); zoomAt(1.25, 400, 600)');
  assert.equal(run('scale'), 5);
  assert.equal(camera.frames.size, 0);
  run('centerTown(path); cancelCamera()');
  assert.equal(camera.frames.size, 0);
  run('centerTown(path); showAll()');
  assert.equal(camera.frames.size, 0);
  assert.equal(camera.attributes.transform, 'translate(0 0) scale(1)');
});

test('reduced motion centers immediately without scheduling animation frames', () => {
  const camera = cameraHarness(true);
  vm.runInContext('scale = 2; centerTown(path)', camera.state);
  assert.equal(camera.frames.size, 0);
  assert.equal(camera.attributes.transform, 'translate(180 160) scale(2)');
});

test('responsive charts keep all months and bars inside narrow and wide canvases', () => {
  const monthly = Array.from({length: 12}, () => ({tmax: 30, tmin: 20, precip: 200}));
  for (const width of [243, 280, 298, 350, 400, 540, 720]) {
    const matching = scope.matchingChart(Array(12).fill(31), width);
    const climate = scope.climateChart(monthly, width);
    for (const markup of [matching, climate]) {
      const bars = [...markup.matchAll(/<rect[^>]*x="([\d.]+)"[^>]*width="([\d.]+)"/g)];
      assert.equal(bars.length, 12);
      bars.forEach((bar) => {
        assert.ok(Number(bar[1]) >= 0);
        assert.ok(Number(bar[1]) + Number(bar[2]) <= width);
      });
      assert.doesNotMatch(markup, /NaN|undefined/);
      assert.match(markup, />12<\/text>/);
    }
    assert.equal([...matching.matchAll(/class="bar-value"/g)].length, 12);
    assert.match(climate, new RegExp(`x="${width - 4}" y="17"`));
  }
});

test('compact matching charts stagger equal values above bars without colliding with axis titles', () => {
  for (const width of [243, 280, 298, 350]) {
    for (const value of [0, 20.5, 31]) {
      const markup = scope.matchingChart(Array(12).fill(value), width);
      const labels = [...markup.matchAll(/class="bar-value" x="([\d.]+)" y="([\d.]+)"/g)];
      assert.equal(labels.length, 12);
      labels.forEach((label, index) => {
        assert.ok(Number(label[1]) >= 11 && Number(label[1]) <= width - 11);
        assert.ok(Number(label[2]) >= 36);
        if (index) assert.equal(Math.abs(Number(label[2]) - Number(labels[index - 1][2])), 18);
      });
    }
  }
});

test('chart rendering uses the measured container width on phones and desktops', () => {
  const block = script.slice(script.indexOf('  function drawChart('), script.indexOf('  function redrawCharts('));
  for (const width of [243, 298, 403, 720]) {
    const attributes = {};
    const scroll = {clientWidth: width, getBoundingClientRect: () => ({width}), setAttribute(name, value) { attributes[name] = value; }};
    const chart = {parentElement: scroll, scrollWidth: width, setAttribute(name, value) { attributes[name] = value; }};
    const state = vm.createContext({$: () => chart});
    vm.runInContext(`${block}\ndrawChart('months', 270, (width) => String(width));`, state);
    assert.equal(attributes.viewBox, `0 0 ${width} 270`);
    assert.equal(chart.innerHTML, String(width));
    assert.equal(attributes['aria-label'], '每月舒適天數圖');
    assert.equal(scroll.tabIndex, -1);
  }
});
