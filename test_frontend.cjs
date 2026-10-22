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
  assert.match(markup, /平均符合天數（天）/);
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
