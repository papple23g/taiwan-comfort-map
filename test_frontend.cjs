const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
const scope = vm.createContext({Event, document: {getElementById: () => ({})}});
vm.runInContext(script.slice(0, script.indexOf('\nload().then(')), scope);
const controls = {tempLo: 20, tempHi: 28, rainMode: 'wet', rainLo: 0, rainHi: 4, useSun: false, sunMin: 6, sunMax: 12, useWind: false, windMin: 5, windMax: 30};

test('sunlight and wind ranges include both bounds, allow equality and ignore inactive ranges', () => {
  const active = {...controls, useSun: true, useWind: true, sunMin: 6.5, sunMax: 8, windMin: 10, windMax: 30};
  const matches = (sun, wind, settings = active) => scope.matchesDay(28, 20, 1, sun, wind, settings);
  for (const sun of [6.5, 8]) for (const wind of [10, 30]) assert.equal(matches(sun, wind), true);
  for (const sun of [6, 8.5, null, NaN]) assert.equal(matches(sun, 20), false);
  for (const wind of [9, 31, null, NaN]) assert.equal(matches(7, wind), false);
  assert.equal(matches(7, 20, {...active, sunMin: 7, sunMax: 7, windMin: 20, windMax: 20}), true);
  assert.equal(matches(null, null, {...active, useSun: false, useWind: false}), true);
});

function touchHarness() {
  const handlers = {};
  const view = {x: 20, y: 30, scale: 2};
  let moves = 0, cancellations = 0;
  const selected = [];
  scope.bindTouchMap({addEventListener: (name, handler) => { handlers[name] = handler; }}, {
    point: (x, y) => ({x: x / 2, y: y / 2}), readView: () => ({...view}),
    move: (next) => { Object.assign(view, next); moves++; },
    cancel: () => { cancellations++; }, choose: (code) => selected.push(code)
  });
  return {view, selected, get moves() { return moves; }, get cancellations() { return cancellations; },
    fire(name, points) {
      let prevented = false;
      handlers[name]({touches: points.map(([clientX, clientY]) => ({clientX, clientY})), target: {closest: () => ({dataset: {code: 'town'}})}, preventDefault() { prevented = true; }});
      return prevented;
    }};
}

test('one finger scrolls without moving the map; taps select but drags do not', () => {
  const touch = touchHarness();
  assert.equal(touch.fire('touchstart', [[100, 100]]), false);
  assert.equal(touch.fire('touchmove', [[100, 200]]), false);
  touch.fire('touchend', []);
  assert.equal(touch.moves, 0);
  assert.equal(touch.selected.length, 0);
  touch.fire('touchstart', [[100, 100]]);
  touch.fire('touchend', []);
  assert.deepEqual(touch.selected, ['town']);
});

test('two fingers pan and pinch around their midpoint with scale limits and no residual one-finger drag', () => {
  const touch = touchHarness();
  assert.equal(touch.fire('touchstart', [[100, 100], [200, 100]]), true);
  assert.equal(touch.cancellations, 1);
  assert.equal(touch.fire('touchmove', [[120, 140], [220, 140]]), true);
  assert.deepEqual(touch.view, {x: 30, y: 50, scale: 2});
  touch.fire('touchmove', [[100, 100], [300, 100]]);
  assert.deepEqual(touch.view, {x: -10, y: 10, scale: 4});
  touch.fire('touchmove', [[-1000, 100], [1000, 100]]);
  assert.equal(touch.view.scale, 14);
  touch.fire('touchend', [[100, 100]]);
  const moves = touch.moves;
  touch.fire('touchmove', [[100, 200]]);
  assert.equal(touch.moves, moves);
  touch.fire('touchend', []);
  assert.equal(touch.selected.length, 0);
  touch.fire('touchstart', [[100, 100], [200, 100]]);
  touch.fire('touchmove', [[150, 100], [150, 100]]);
  assert.equal(touch.view.scale, 1);
  touch.fire('touchcancel', []);
  touch.fire('touchmove', [[100, 100]]);
  assert.equal(touch.view.scale, 1);
});

test('rain levels use exact decimals, half-open intervals and an unlimited highest level', () => {
  const cases = [[0.99, -1], [1, 0], [9.99, 0], [10, 1], [24.99, 1], [25, 2], [79.99, 2], [80, 3], [199.99, 3], [200, 4], [331.05, 4]];
  for (const [rain, level] of cases) {
    assert.equal(scope.rainMatches(rain, 'dry', 0, 4), rain < 1);
    assert.equal(scope.rainMatches(rain, 'wet', 0, 4), rain >= 1);
    for (let index = 0; index < 5; index++) assert.equal(scope.rainMatches(rain, 'wet', index, index), level === index);
    assert.equal(scope.rainMatches(rain, 'wet', 1, 3), rain >= 10 && rain < 200);
  }
  assert.equal(scope.rainMatches(10000, 'wet', 4, 4), true);
  assert.equal(scope.rainDescription(1, 3).name, '小雨～大雨');
  assert.equal(scope.rainDescription(1, 3).exact, '10 毫米 ≤ 日雨量 < 200 毫米');
  assert.equal(scope.rainDescription(4, 4).name, '豪雨以上');
  assert.equal(scope.rainDescription(4, 4).exact, '日雨量 ≥ 200 毫米，不設上限');
});

test('inactive weather restrictions accept missing values; active ones reject them', () => {
  for (const value of [null, undefined, NaN, -1]) {
    assert.equal(scope.rainMatches(value, 'any', 0, 4), true);
    assert.equal(scope.rainMatches(value, 'dry', 0, 4), false);
    assert.equal(scope.rainMatches(value, 'wet', 0, 4), false);
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
  const elements = {'tmax-lo': input(), 'tmax-hi': input(), 'tmax-read': {}, 'tmax-dual': controlElement()};
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

test('temperature modes retain independent selections from their first use', () => {
  const state = scope.createTemperatureState();
  assert.equal(state.mode, 'basic');
  assert.equal(state.min, 15);
  assert.equal(state.max, 35);
  state.basic.lo = 19;
  state.basic.hi = 23;
  scope.switchTemperatureMode(state, 'advanced');
  assert.equal(state.advanced.lo, 20);
  assert.equal(state.advanced.hi, 28);
  assert.equal(state.min, -5);
  assert.equal(state.max, 40);
  scope.commitTemperature(state, '-10', '45');
  scope.switchTemperatureMode(state, 'basic');
  assert.equal(state.basic.lo, 19);
  assert.equal(state.basic.hi, 23);
  state.basic.lo = 15;
  state.basic.hi = 15;
  scope.switchTemperatureMode(state, 'advanced');
  assert.equal(state.advanced.lo, -10);
  assert.equal(state.advanced.hi, 45);
  assert.equal(state.min, -10);
  assert.equal(state.max, 45);
  scope.switchTemperatureMode(state, 'basic');
  assert.equal(state.basic.lo, 15);
  assert.equal(state.basic.hi, 15);
});

test('advanced temperature commits preserve arbitrary finite decimals and expand without shrinking until mode exit', () => {
  const state = scope.createTemperatureState();
  scope.switchTemperatureMode(state, 'advanced');
  for (const [lo, hi] of [['-10', '45'], ['20.3', '28.27'], ['22.125', '22.125']]) {
    const result = scope.commitTemperature(state, lo, hi);
    assert.equal(result.lo, '');
    assert.equal(result.hi, '');
    assert.equal(state.advanced.lo, Number(lo));
    assert.equal(state.advanced.hi, Number(hi));
    assert.equal(state.min, -10);
    assert.equal(state.max, 45);
  }
  scope.switchTemperatureMode(state, 'basic');
  assert.equal(state.basic.lo, 20);
  assert.equal(state.basic.hi, 28);
  scope.switchTemperatureMode(state, 'advanced');
  assert.equal(state.min, -5);
  assert.equal(state.max, 40);
  assert.equal(state.advanced.lo, 22.125);
  assert.equal(state.advanced.hi, 22.125);
});

test('invalid temperature drafts leave all effective values and bounds unchanged', () => {
  const state = scope.createTemperatureState();
  scope.switchTemperatureMode(state, 'advanced');
  const baseline = JSON.stringify(state);
  for (const [lo, hi] of [['', '30'], ['20', ''], [' ', '30'], ['NaN', '30'], ['20', 'Infinity'], ['-1e309', '30'], ['31', '30']]) {
    const result = scope.commitTemperature(state, lo, hi);
    assert.ok(result.lo || result.hi);
    assert.equal(JSON.stringify(state), baseline);
  }
  const broad = {...controls, rainMode: 'any', tempLo: -1000, tempHi: 1000};
  assert.equal(scope.matchesDay(-10, -20, null, null, null, broad), true);
  assert.equal(scope.matchesDay(28.5, 20.5, null, null, null, {...broad, tempLo: 20.3, tempHi: 28.27}), false);
});

function controlElement(value = '') {
  const captured = new Set();
  const classes = new Set();
  return {value, style: {}, attributes: {}, listeners: {},
    classList: {add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }, toggle(name, active) { if (active) classes.add(name); else classes.delete(name); }},
    setAttribute(name, val) { this.attributes[name] = val; },
    getAttribute(name) { return this.attributes[name] || null; },
    addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); },
    querySelector() { return {style: {}}; },
    getBoundingClientRect() { return {left: 100, width: 222}; },
    setPointerCapture(id) { captured.add(id); },
    hasPointerCapture(id) { return captured.has(id); },
    releasePointerCapture(id) { captured.delete(id); },
    focus() { this.focused = true; },
    dispatchEvent(event) { this.fire(event.type); },
    fire(name, detail = {}) {
      let prevented = false;
      const event = {target: this, pointerId: 1, button: 0, isPrimary: true, clientY: 50,
        ...(typeof detail === 'string' ? {key: detail} : detail),
        preventDefault() { prevented = true; }, stopPropagation() {}};
      this.listeners[name]?.forEach((handler) => handler(event));
      return prevented;
    }
  };
}

function temperatureHarness() {
  const elements = Object.fromEntries(['tmax-lo', 'tmax-hi', 'tmax-read', 'tmax-dual', 'temperature-lo-number', 'temperature-hi-number', 'temperature-lo-error', 'temperature-hi-error', 'temperature-numbers'].map((id) => [id, controlElement()]));
  const radios = [controlElement('basic'), controlElement('advanced')];
  const context = vm.createContext({Event, document: {getElementById: (id) => elements[id], querySelectorAll: () => radios}});
  vm.runInContext(script.slice(0, script.indexOf('\nload().then(')), context);
  const updates = [];
  const state = context.bindTemperatureControls((announce) => updates.push(announce));
  return {elements, radios, state, updates};
}

test('temperature inputs apply on commit, retain invalid drafts and stay synchronized with sliders', () => {
  const {elements: el, radios, state, updates} = temperatureHarness();
  assert.equal(el['temperature-lo-number'].disabled, true);
  assert.equal(el['temperature-numbers'].hidden, true);
  radios[1].fire('change');
  assert.equal(el['temperature-lo-number'].disabled, false);
  el['temperature-lo-number'].value = '-10.3';
  el['temperature-hi-number'].value = '45.27';
  assert.equal(state.advanced.lo, 20);
  assert.equal(el['temperature-lo-number'].fire('keydown', 'Enter'), true);
  assert.equal(el['tmax-lo'].value, '-10.3');
  assert.equal(el['tmax-hi'].value, '45.27');
  assert.equal(el['tmax-read'].textContent, '-10.3~45.27℃');
  assert.equal(el['tmax-lo'].attributes['aria-valuetext'], '-10.3°C');
  const count = updates.length;
  el['temperature-lo-number'].value = '';
  el['temperature-lo-number'].fire('blur');
  assert.equal(updates.length, count);
  assert.equal(state.advanced.lo, -10.3);
  assert.equal(el['temperature-lo-number'].attributes['aria-invalid'], 'true');
  assert.ok(el['temperature-lo-error'].textContent);
  assert.equal(el['tmax-lo'].fire('keydown', 'ArrowRight'), true);
  assert.equal(state.advanced.lo, -9.8);
  assert.equal(el['temperature-lo-number'].value, '-9.8');
  assert.equal(el['temperature-lo-number'].attributes['aria-invalid'], 'false');
  el['tmax-hi'].value = '20.21';
  el['tmax-hi'].fire('input');
  assert.equal(state.advanced.hi, 20);
  assert.equal(el['temperature-hi-number'].value, '20');
  el['tmax-lo'].fire('keydown', 'End');
  assert.equal(state.advanced.lo, 20);
  assert.equal(state.advanced.hi, 20);
  radios[0].fire('change');
  assert.equal(el['temperature-numbers'].hidden, true);
  assert.equal(el['temperature-hi-number'].disabled, true);
});

test('switching temperature controls restores each mode without overwriting the other', () => {
  const {elements: el, radios, state} = temperatureHarness();
  el['tmax-lo'].value = '15'; el['tmax-lo'].fire('input');
  el['tmax-hi'].value = '15'; el['tmax-hi'].fire('input');
  radios[1].fire('change');
  assert.equal(el['tmax-read'].textContent, '20~28℃');
  el['temperature-lo-number'].value = '-12.3';
  el['temperature-hi-number'].value = '42.7';
  el['temperature-lo-number'].fire('keydown', 'Enter');
  radios[0].fire('change');
  assert.equal(el['tmax-read'].textContent, '15~15℃');
  const root = el['tmax-dual'];
  root.fire('pointerdown', {clientX: 111});
  root.fire('pointermove', {clientX: 161});
  root.fire('pointerup');
  assert.equal(el['tmax-read'].textContent, '15~20℃');
  assert.equal(state.basic.hi, 20);
  radios[1].fire('change');
  assert.equal(el['tmax-read'].textContent, '-12.3~42.7℃');
  assert.equal(el['temperature-lo-number'].value, '-12.3');
  assert.equal(el['temperature-hi-number'].value, '42.7');
});

function overlapHarness(min, max, step, low, high = low) {
  const lo = Object.assign(controlElement(String(low)), {min: String(min), max: String(max), step: String(step)});
  const hi = Object.assign(controlElement(String(high)), {min: String(min), max: String(max), step: String(step)});
  const root = controlElement();
  const updates = [];
  for (const input of [lo, hi]) {
    input.addEventListener('input', () => { scope.clampRange(lo, hi, input); updates.push('input'); });
    input.addEventListener('change', () => updates.push('change'));
  }
  scope.bindDualPointer(lo, hi, root);
  const position = (value) => 111 + (value - min) / (max - min) * 200;
  return {lo, hi, root, updates, position};
}

test('overlapping endpoints separate by drag direction at the minimum, middle and maximum of all ranges', () => {
  for (const [min, max, step] of [[15, 35, 0.5], [-5, 40, 0.5], [0, 4, 1], [1, 12, 0.5], [5, 70, 1]]) {
    const middle = min + Math.floor((max - min) / step / 2) * step;
    for (const [value, direction] of [[min, 1], [middle, -1], [middle, 1], [max, -1]]) {
      const {lo, hi, root, updates, position} = overlapHarness(min, max, step, value);
      const start = position(value);
      assert.equal(root.fire('pointerdown', {clientX: start}), true);
      assert.equal(root.hasPointerCapture(1), true);
      root.fire('pointermove', {clientX: start + direction * 50});
      assert.ok(Number(lo.value) < Number(hi.value));
      assert.equal(direction > 0 ? Number(lo.value) : Number(hi.value), value);
      const moving = Number(direction > 0 ? hi.value : lo.value);
      assert.ok(Math.abs((moving - min) / step - Math.round((moving - min) / step)) < 1e-10);
      root.fire('pointerup');
      root.fire('lostpointercapture');
      assert.equal(root.hasPointerCapture(1), false);
      assert.deepEqual(updates, ['input', 'change']);
    }
  }
});

test('overlap dragging respects crossing limits and cancels without blocking vertical scrolling', () => {
  const {lo, hi, root, updates} = overlapHarness(15, 35, 0.5, 25);
  root.fire('pointerdown', {clientX: 211});
  assert.equal(root.fire('pointermove', {clientX: 212, clientY: 100}), false);
  root.fire('pointercancel');
  assert.equal(root.hasPointerCapture(1), false);
  assert.deepEqual(updates, []);
  root.fire('pointerdown', {clientX: 211});
  root.fire('pointermove', {clientX: 261});
  root.fire('pointermove', {clientX: 111});
  assert.equal(lo.value, '25');
  assert.equal(hi.value, '25');
  root.fire('pointercancel');
  const count = updates.length;
  root.fire('pointermove', {clientX: 311});
  assert.equal(updates.length, count);
  assert.equal(updates.at(-1), 'change');
});

test('nearby endpoints use the closest handle; separated, disabled and secondary pointers keep native behavior', () => {
  for (const endpoint of ['lo', 'hi']) {
    const {lo, hi, root, position} = overlapHarness(15, 35, 0.5, 25, 26);
    const start = position(endpoint === 'lo' ? 25 : 26);
    root.fire('pointerdown', {clientX: start});
    root.fire('pointermove', {clientX: start + (endpoint === 'lo' ? -50 : 50)});
    root.fire('pointerup');
    assert.ok(endpoint === 'lo' ? Number(lo.value) < 25 : Number(hi.value) > 26);
    assert.equal(endpoint === 'lo' ? Number(hi.value) : Number(lo.value), endpoint === 'lo' ? 26 : 25);
  }
  const {lo, root} = overlapHarness(15, 35, 0.5, 15, 35);
  assert.equal(root.fire('pointerdown', {clientX: 111}), false);
  const near = overlapHarness(15, 35, 0.5, 25);
  assert.equal(near.root.fire('pointerdown', {clientX: 111}), false);
  assert.equal(near.root.fire('pointerdown', {clientX: 211, isPrimary: false}), false);
  assert.equal(near.root.fire('pointerdown', {clientX: 211, button: 2}), false);
  near.lo.disabled = true;
  assert.equal(near.root.fire('pointerdown', {clientX: 211}), false);
  assert.equal(lo.value, '15');
});

function rangeHarness(min, max, step, lower, upper) {
  const result = overlapHarness(min, max, step, lower, upper);
  // 使用獨立根節點，讓每個事件只經過一個共用控制器。
  result.root = controlElement();
  result.rangeUpdates = [];
  result.controller = scope.bindDualPointer(result.lo, result.hi, result.root, {step,
    onRange(lo, hi, confirm) {
      result.lo.value = String(lo);
      result.hi.value = String(hi);
      result.rangeUpdates.push({lo, hi, confirm});
    }});
  result.start = result.position((lower + upper) / 2);
  return result;
}

test('all four selected ranges translate from the original pair with one atomic update per effective movement', () => {
  for (const [min, max, step, low, high] of [[15, 35, 0.5, 20, 28], [0, 4, 1, 1, 3], [1, 12, 0.5, 4, 8], [5, 70, 1, 20, 40]]) {
    const {lo, hi, root, rangeUpdates, updates, start} = rangeHarness(min, max, step, low, high);
    const dx = step / (max - min) * 200;
    root.fire('pointerdown', {clientX: start});
    root.fire('pointermove', {clientX: start + Math.max(4, dx)});
    const moved = Math.round(Math.max(4, dx) / 200 * (max - min) / step) * step;
    assert.equal(Number(lo.value), low + moved);
    assert.equal(Number(hi.value), high + moved);
    assert.equal(root.classList.contains('is-shifting'), true);
    root.fire('pointermove', {clientX: start + Math.max(4, dx)});
    assert.equal(rangeUpdates.length, 1);
    root.fire('pointermove', {clientX: start - Math.max(4, dx)});
    assert.equal(Number(lo.value), low - moved);
    assert.equal(Number(hi.value), high - moved);
    root.fire('pointerup');
    root.fire('lostpointercapture');
    assert.deepEqual(rangeUpdates.map((update) => update.confirm), [false, false, true]);
    assert.equal(root.hasPointerCapture(1), false);
    assert.equal(root.classList.contains('is-shifting'), false);
    assert.deepEqual(updates, []);
  }
});

test('range translation stops at both bounds without narrowing, re-accumulating or moving a full interval', () => {
  for (const [min, max, step, low, high] of [[15, 35, 0.5, 20, 28], [0, 4, 1, 1, 3], [1, 12, 0.5, 4, 8], [5, 70, 1, 20, 40]]) {
    const {lo, hi, root, rangeUpdates, start} = rangeHarness(min, max, step, low, high);
    root.fire('pointerdown', {clientX: start});
    root.fire('pointermove', {clientX: start - 1000});
    assert.equal(Number(lo.value), min);
    assert.equal(Number(hi.value) - Number(lo.value), high - low);
    root.fire('pointermove', {clientX: start + 1000});
    assert.equal(Number(hi.value), max);
    assert.equal(Number(hi.value) - Number(lo.value), high - low);
    root.fire('pointermove', {clientX: start});
    assert.equal(Number(lo.value), low);
    assert.equal(Number(hi.value), high);
    root.fire('pointerup');
    assert.equal(rangeUpdates.filter((update) => update.confirm).length, 1);
    const full = rangeHarness(min, max, step, min, max);
    assert.equal(full.root.fire('pointerdown', {clientX: full.start}), false);
    full.root.fire('pointermove', {clientX: full.start + 100});
    full.lo.fire('keydown', {key: 'ArrowRight', shiftKey: true});
    assert.deepEqual(full.rangeUpdates, []);
  }
});

test('whole-range gestures require horizontal intent and clean up touch cancellation, capture loss and collapse', () => {
  for (const end of ['pointerup', 'pointercancel', 'lostpointercapture', 'collapse']) {
    const {lo, hi, root, rangeUpdates, controller, start} = rangeHarness(15, 35, 0.5, 20, 28);
    root.fire('pointerdown', {clientX: start, pointerType: 'touch'});
    assert.equal(root.fire('pointermove', {clientX: start + 3, pointerType: 'touch'}), false);
    assert.deepEqual(rangeUpdates, []);
    root.fire('pointermove', {clientX: start + 20, pointerType: 'touch'});
    assert.equal(lo.value, '22');
    assert.equal(hi.value, '30');
    if (end === 'collapse') { lo.disabled = true; hi.disabled = true; controller.cancel(); }
    else root.fire(end);
    assert.equal(root.hasPointerCapture(1), false);
    assert.equal(root.classList.contains('is-shifting'), false);
    const count = rangeUpdates.length;
    root.fire('pointermove', {clientX: start + 50});
    root.fire('pointerup');
    assert.equal(rangeUpdates.length, count);
    assert.equal(rangeUpdates.filter((update) => update.confirm).length, end === 'collapse' ? 0 : 1);
  }
  const vertical = rangeHarness(15, 35, 0.5, 20, 28);
  vertical.root.fire('pointerdown', {clientX: vertical.start, pointerType: 'touch'});
  assert.equal(vertical.root.fire('pointermove', {clientX: vertical.start + 4, clientY: 70, pointerType: 'touch'}), false);
  assert.equal(vertical.root.hasPointerCapture(1), false);
  vertical.root.fire('pointermove', {clientX: vertical.start + 30, clientY: 70});
  assert.deepEqual(vertical.rangeUpdates, []);
});

test('narrow ranges and equality keep endpoint priority; separated endpoint hit boxes do not start whole dragging', () => {
  for (const [low, high] of [[25, 25], [25, 26]]) {
    const result = rangeHarness(15, 35, 0.5, low, high);
    result.root.fire('pointerdown', {clientX: result.position(high)});
    result.root.fire('pointermove', {clientX: result.position(high) + 50});
    result.root.fire('pointerup');
    assert.equal(result.lo.value, String(low));
    assert.ok(Number(result.hi.value) > high);
    assert.deepEqual(result.rangeUpdates, []);
  }
  const result = rangeHarness(15, 35, 0.5, 20, 28);
  for (const point of [result.position(20) + 10.9, result.position(28) - 10.9]) {
    assert.equal(result.root.fire('pointerdown', {clientX: point}), false);
    assert.equal(result.root.hasPointerCapture(1), false);
  }
});

test('Shift keys translate all ranges, reach exact boundaries and leave ordinary endpoint keys untouched', () => {
  for (const [min, max, step, low, high] of [[15, 35, 0.5, 20, 28], [0, 4, 1, 1, 3], [1, 12, 0.5, 4, 8], [5, 70, 1, 20, 40]]) {
    const {lo, hi, rangeUpdates} = rangeHarness(min, max, step, low, high);
    assert.equal(lo.fire('keydown', {key: 'ArrowRight'}), false);
    assert.equal(lo.fire('keydown', {key: 'ArrowRight', shiftKey: true}), true);
    assert.equal(Number(lo.value), low + step);
    assert.equal(Number(hi.value), high + step);
    hi.fire('keydown', {key: 'ArrowDown', shiftKey: true});
    assert.equal(Number(lo.value), low);
    assert.equal(Number(hi.value), high);
    hi.fire('keydown', {key: 'End', shiftKey: true});
    assert.equal(Number(hi.value), max);
    lo.fire('keydown', {key: 'Home', shiftKey: true});
    assert.equal(Number(lo.value), min);
    assert.equal(Number(hi.value), min + high - low);
    const count = rangeUpdates.length;
    lo.fire('keydown', {key: 'Home', shiftKey: true});
    lo.disabled = true;
    hi.fire('keydown', {key: 'ArrowRight', shiftKey: true});
    assert.equal(rangeUpdates.length, count);
    assert.ok(rangeUpdates.every((update) => update.confirm));
    assert.match(hi.attributes['aria-describedby'], /range-help/);
  }
});

test('advanced range movement preserves decimal pairs and mode memory, allows substep boundary stops and cancels mode changes', () => {
  const {elements: el, radios, state, updates} = temperatureHarness();
  radios[1].fire('change');
  el['temperature-lo-number'].value = '20.3'; el['temperature-hi-number'].value = '28.27';
  el['temperature-lo-number'].fire('keydown', 'Enter');
  updates.length = 0;
  el['tmax-lo'].fire('keydown', {key: 'ArrowRight', shiftKey: true});
  assert.equal(state.advanced.lo, 20.8);
  assert.equal(state.advanced.hi, 28.77);
  assert.equal(el['temperature-lo-number'].value, '20.8');
  assert.equal(el['temperature-hi-number'].value, '28.77');
  assert.deepEqual(updates, [true]);
  el['tmax-hi'].fire('keydown', {key: 'End', shiftKey: true});
  assert.equal(state.advanced.lo, 32.03);
  assert.equal(state.advanced.hi, 40);
  el['tmax-lo'].fire('keydown', {key: 'Home', shiftKey: true});
  assert.equal(state.advanced.lo, -5);
  assert.equal(state.advanced.hi, 2.97);
  el['tmax-lo'].fire('keydown', {key: 'ArrowRight', shiftKey: true});
  const saved = JSON.stringify(state.advanced);
  const root = el['tmax-dual'];
  root.fire('pointerdown', {clientX: 111 + ((-4.5 + 3.47) / 2 + 5) / 45 * 200});
  root.fire('pointermove', {clientX: 160});
  const moved = JSON.stringify(state.advanced);
  assert.notEqual(moved, saved);
  const count = updates.length;
  radios[0].fire('change');
  root.fire('pointermove', {clientX: 300});
  root.fire('pointerup');
  assert.equal(updates.length, count + 1);
  assert.equal(el['tmax-read'].textContent, '20~28℃');
  radios[1].fire('change');
  assert.equal(JSON.stringify(state.advanced), moved);
  assert.equal(state.min, -5);
  assert.equal(state.max, 40);
  const close = scope.shiftRange(31.8, 39.77, -5, 40, 0.5, 0.5);
  assert.equal(close.lo, 32.03);
  assert.equal(close.hi, 40);
});

function weatherPairHarness() {
  const elements = {};
  const specs = [['rain', 'rain-lo', 'rain-hi', 0, 4, 1, 0, 1], ['sun', 'sun-min', 'sun-max', 1, 12, 0.5, 1, 3], ['wind', 'wind-min', 'wind-max', 5, 70, 1, 10, 20]];
  for (const [name, lowId, highId, min, max, step, lower, upper] of specs) {
    const root = elements[`${name}-dual`] = controlElement();
    const pair = [lower, upper].map((value) => Object.assign(controlElement(String(value)), {min: String(min), max: String(max), step: String(step), parentElement: root}));
    elements[lowId] = pair[0]; elements[highId] = pair[1];
    elements[`${name}-extra`] = {querySelectorAll: () => pair};
  }
  const paints = [], updates = [];
  const controls = {rainMode: 'wet', useSun: true, useWind: true};
  const context = vm.createContext({
    $: (id) => elements[id], clampRange: scope.clampRange, bindDualPointer: scope.bindDualPointer, weather: {},
    paintReads() { paints.push(specs.map(([, low, high]) => [Number(elements[low].value), Number(elements[high].value)])); },
    schedule(announce) { updates.push(['schedule', announce]); }, render(announce, best) { updates.push(['render', announce, best]); },
    readControls: () => controls,
  });
  vm.runInContext(script.slice(script.indexOf('  const pairControllers = []'), script.indexOf('  for (const radio of document.querySelectorAll(\'.segments input:not(')), context);
  return {elements, specs, paints, updates, controls, context};
}

test('weather pair wiring paints both new values before scheduling once and cancels collapsed controls', () => {
  const result = weatherPairHarness(), {elements, specs, paints, updates, controls, context} = result;
  for (let index = 0; index < specs.length; index++) {
    const [name, lowId, highId, min, max, , lower, upper] = specs[index];
    const root = elements[`${name}-dual`];
    const start = 111 + ((lower + upper) / 2 - min) / (max - min) * 200;
    const shift = name === 'rain' ? 2 : name === 'sun' ? 5 : 30;
    root.fire('pointerdown', {clientX: start});
    root.fire('pointermove', {clientX: start + shift / (max - min) * 200});
    assert.deepEqual(paints.at(-1)[index], [lower + shift, upper + shift]);
    assert.deepEqual(updates.at(-1), ['schedule', false]);
    root.fire('pointerup');
    assert.deepEqual(updates.at(-1), ['render', true, true]);
    assert.equal(paints.length, index * 2 + 2);
    assert.equal(updates.length, index * 2 + 2);
    assert.equal(Number(elements[lowId].value), lower + shift);
    assert.equal(Number(elements[highId].value), upper + shift);
  }
  const root = elements['sun-dual'];
  root.fire('pointerdown', {clientX: 111 + (7 - 1) / 11 * 200});
  root.fire('pointermove', {clientX: 200});
  assert.equal(root.hasPointerCapture(1), true);
  controls.useSun = false;
  context.syncModes();
  assert.equal(root.hasPointerCapture(1), false);
  assert.equal(elements['sun-extra'].hidden, true);
  assert.equal(elements['sun-min'].disabled, true);
  assert.equal(elements['sun-max'].disabled, true);
  const count = updates.length;
  root.fire('pointerup');
  root.fire('pointermove', {clientX: 300});
  assert.equal(updates.length, count);
  controls.useSun = true;
  context.syncModes();
  assert.equal(elements['sun-min'].disabled, false);
  assert.equal(elements['sun-extra'].hidden, false);
});

function recommendationHarness() {
  const towns = [
    {code: 'north-low', county: '臺北市', name: '臺北市中正區', cell: 0},
    {code: 'north-high', county: '臺北市', name: '臺北市大安區', cell: 1},
    {code: 'south', county: '高雄市', name: '高雄市楠梓區', cell: 2}
  ];
  const timers = new Map(), shown = [], centered = [], highlights = new Map(), live = {};
  let timerId = 0, cancellations = 0;
  const state = vm.createContext({
    selected: '', timer: null, rankingRows: [], scores: [25, 75, 150], meta: {towns}, weather: {},
    regionInputs: ['北部', '南部'].map((value) => ({value, checked: true})),
    paths: new Map(towns.map((town) => [town.code, {dataset: {code: town.code}, setAttribute() {},
      classList: {toggle(name, active) { highlights.set(town.code, active); }}}])),
    rankTowns: scope.rankTowns, colorFor: scope.colorFor, paintReads() {}, compute() {},
    readControls: () => ({rainMode: 'any'}), $: () => live,
    renderRanking() {}, syncAddress() {}, showTown() { shown.push(state.selected); },
    cancelCamera() { cancellations++; }, centerTown(path) { centered.push(path.dataset.code); },
    window: {clearTimeout(id) { timers.delete(id); }, setTimeout(callback) { timers.set(++timerId, callback); return timerId; }}
  });
  const block = script.slice(script.indexOf('  function render('), script.indexOf('  function bindPair('));
  vm.runInContext(block, state);
  return {state, shown, centered, highlights, timers, live, get cancellations() { return cancellations; }, flush() {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach((callback) => callback());
  }};
}

test('condition changes select the highest score in checked regions and update details and outline without panning', () => {
  const result = recommendationHarness(), {state, shown, highlights, centered} = result;
  state.render(false, true);
  assert.equal(state.selected, 'south');
  assert.equal(shown.at(-1), 'south');
  assert.equal(highlights.get('south'), true);
  state.scores = [25, 175, 150];
  state.schedule(false);
  state.schedule(false);
  assert.equal(result.timers.size, 1);
  result.flush();
  assert.equal(state.selected, 'north-high');
  assert.equal(shown.at(-1), 'north-high');
  assert.equal(highlights.get('south'), false);
  assert.equal(highlights.get('north-high'), true);
  state.regionInputs[0].checked = false;
  state.render(true, true);
  assert.equal(state.selected, 'south');
  assert.match(result.live.textContent, /最多是高雄市楠梓區 150.0 天/);
  assert.deepEqual(centered, []);
  assert.equal(result.cancellations, 3);
});

test('manual township choices survive pending work and redraws until the next condition change', () => {
  const result = recommendationHarness(), {state, centered} = result;
  state.render(false, true);
  state.schedule(false);
  state.choose('north-low');
  assert.equal(result.timers.size, 0);
  result.flush();
  state.render(false);
  assert.equal(state.selected, 'north-low');
  assert.deepEqual(centered, ['north-low']);
  state.schedule(false);
  result.flush();
  assert.equal(state.selected, 'south');
  assert.deepEqual(centered, ['north-low']);
});

test('automatic recommendation resolves zero-score ties consistently and clears when every region is unchecked', () => {
  const {state, shown, highlights, live} = recommendationHarness();
  state.scores = [0, 0, 0];
  const expected = scope.rankTowns(state.meta.towns.map((town) => ({...town, days: 0})), new Set(['北部', '南部']), 'days', 'descending')[0].code;
  state.render(false, true);
  assert.equal(state.selected, expected);
  state.regionInputs.forEach((input) => { input.checked = false; });
  state.render(true, true);
  assert.equal(state.selected, '');
  assert.equal(shown.at(-1), '');
  assert.ok([...highlights.values()].every((active) => !active));
  assert.equal(live.textContent, '目前勾選分區沒有可顯示的鄉鎮。');
});

test('dual track positioning remains finite for extreme finite input bounds', () => {
  const style = {};
  scope.paintDual({min: '-1e308', max: '1e308', value: '-1e308'}, {value: '1e308'}, {...controlElement(), querySelector: () => ({style})});
  assert.equal(style.left, 'calc(11px + (100% - 22px) * 0)');
  assert.equal(style.width, 'calc((100% - 22px) * 1)');
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
