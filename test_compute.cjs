const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {Worker: NodeWorker} = require('node:worker_threads');
const compute = require('./climate-compute.js');

// 保留整合前 index.html 的規則快照作為獨立基準，避免 wrapper 與核心互相比較。
const legacySource = `
const RAIN_LEVELS = [
  {name: '微量降雨', min: 1, max: 10},
  {name: '小雨', min: 10, max: 25},
  {name: '中雨', min: 25, max: 80},
  {name: '大雨', min: 80, max: 200},
  {name: '豪雨以上', min: 200, max: Infinity},
];
function rainMatches(rain, mode, lo, hi) {
  if (mode === 'any') return true;
  if (!Number.isFinite(rain) || rain < 0) return false;
  if (mode === 'dry') return rain < 1;
  return rain >= RAIN_LEVELS[lo].min && rain < RAIN_LEVELS[hi].max;
}
function matchesDay(high, low, rain, sun, wind, controls) {
  if (!Number.isFinite(high) || !Number.isFinite(low)) return false;
  if (high < controls.tempLo || high > controls.tempHi || low < controls.tempLo || low > controls.tempHi) return false;
  if (!rainMatches(rain, controls.rainMode, controls.rainLo, controls.rainHi)) return false;
  if (controls.useSun && (!Number.isFinite(sun) || sun < controls.sunMin || sun > controls.sunMax)) return false;
  if (controls.useWind && (!Number.isFinite(wind) || wind < controls.windMin || wind > controls.windMax)) return false;
  return true;
}
globalThis.levels = RAIN_LEVELS;
`;
const legacy = vm.createContext({});
vm.runInContext(legacySource, legacy);
const levels = Array.from(legacy.levels, (level) => ({...level}));
const defaults = {tempLo: 20, tempHi: 28, rainMode: 'dry', rainLo: 0, rainHi: 4, useSun: true, sunMin: 6, sunMax: 12, useWind: false, windMin: 5, windMax: 30};
const moduleSource = fs.readFileSync(path.join(__dirname, 'climate-compute.js'), 'utf8');

function realData() {
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/meta.json'), 'utf8'));
  const bytes = fs.readFileSync(path.join(__dirname, 'data/climate.bin'));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const header = new DataView(buffer), nCells = header.getUint16(6, true), nDays = header.getUint16(8, true);
  const size = nCells * nDays;
  return {
    data: {planes: Array.from({length: header.getUint16(10, true)}, (_, index) => new Uint8Array(buffer, 16 + index * size, size)), nCells, nDays, months: meta.months, years: meta.years, rainLevels: levels},
    weather: JSON.parse(fs.readFileSync(path.join(__dirname, 'data/weather-details.json'), 'utf8')),
  };
}

function tinyData(days = 768) {
  const planes = Array.from({length: 6}, () => new Uint8Array(days));
  planes[0].fill(130);
  planes[1].fill(124);
  planes[4].fill(14);
  planes[5].fill(20);
  return {planes, nCells: 1, nDays: days, months: Array.from({length: days}, (_, day) => day % 12 + 1), years: 1, rainLevels: levels};
}

function legacyCalculate(data, weather, controls) {
  const scores = [], monthScores = [];
  for (let cell = 0; cell < data.nCells; cell++) {
    let matched = 0;
    const monthly = new Uint16Array(12);
    for (let day = controls.startDay ?? 0; day < (controls.endDay ?? data.nDays); day++) {
      const index = cell * data.nDays + day;
      const temp = (plane) => data.planes[plane][index] === 255 ? null : data.planes[plane][index] / 2 - 40;
      const sun = data.planes[4][index] === 255 ? null : data.planes[4][index] / 2;
      const wind = data.planes[5][index] === 255 ? null : data.planes[5][index];
      const rain = controls.rainMode === 'any' ? null : weather.grids[weather.cellGrid[cell]].rain[day];
      if (!legacy.matchesDay(temp(0), temp(1), rain, sun, wind, controls)) continue;
      matched++;
      monthly[data.months[day] - 1]++;
    }
    scores.push(matched / (controls.years ?? data.years));
    monthScores.push(Array.from(monthly, (count) => count / (controls.years ?? data.years)));
  }
  return {scores, monthScores};
}

class LoopbackWorker {
  static instances = [];
  constructor() {
    this.messages = [];
    this.stopped = false;
    LoopbackWorker.instances.push(this);
    const owner = this;
    const scope = vm.createContext({
      setTimeout, clearTimeout, performance,
      addEventListener(_name, listener) { owner.receive = listener; },
      postMessage(message) { queueMicrotask(() => { if (!owner.stopped) owner.onmessage?.({data: structuredClone(message)}); }); },
    });
    vm.runInContext(moduleSource, scope);
  }
  postMessage(message, transfer) {
    assert.equal(transfer, undefined);
    this.messages.push(message);
    const copy = structuredClone(message);
    queueMicrotask(() => { if (!this.stopped) this.receive({data: copy}); });
  }
  terminate() { this.stopped = true; }
}

class NodeWorkerAdapter {
  constructor(url) {
    this.worker = new NodeWorker(`
      const {parentPort, workerData} = require('node:worker_threads');
      require(workerData).installWorker({
        addEventListener: (_name, handler) => parentPort.on('message', (data) => handler({data})),
        postMessage: (message) => parentPort.postMessage(message),
      });
    `, {eval: true, workerData: path.resolve(__dirname, url)});
    this.worker.on('message', (data) => this.onmessage?.({data}));
    this.worker.on('error', (error) => this.onerror?.(error));
    this.worker.on('messageerror', (error) => this.onmessageerror?.(error));
  }
  postMessage(message) { this.worker.postMessage(message); }
  terminate() { this.worker.terminate(); }
}

test('matching rules preserve legacy bounds, decimal precipitation, missing values and inactive conditions', () => {
  const rainfall = [null, NaN, Infinity, -1, 0, 0.99, 1, 9.99, 10, 24.99, 25, 79.99, 80, 199.99, 200, 331.05];
  for (const mode of ['any', 'dry', 'wet']) for (let lo = 0; lo < 5; lo++) for (let hi = lo; hi < 5; hi++) {
    for (const rain of rainfall) assert.equal(compute.rainMatches(rain, mode, lo, hi, levels), legacy.rainMatches(rain, mode, lo, hi));
    for (const tempLo of [19.5, 20, 20.5]) for (const high of [null, NaN, 20, 27.5, 28, 28.5]) {
      for (const low of [null, 19.5, 20, 20.5]) for (const sun of [null, 5.5, 6, 12, 12.5]) for (const wind of [null, 4, 5, 30, 31]) {
        const controls = {...defaults, tempLo, rainMode: mode, rainLo: lo, rainHi: hi, useWind: true};
        assert.equal(compute.matchesDay(high, low, 10, sun, wind, controls, levels), legacy.matchesDay(high, low, 10, sun, wind, controls));
      }
    }
  }
  const inactive = {...defaults, rainMode: 'any', useSun: false, useWind: false};
  assert.equal(compute.matchesDay(28, 20, null, null, null, inactive, levels), true);
});

test('full real-data fallback and real worker produce identical legacy scores and monthly counts', async () => {
  const {data, weather} = realData();
  const expected = legacyCalculate(data, weather, defaults);
  for (const Worker of [null, NodeWorkerAdapter]) {
    const client = compute.createClient(data, {Worker});
    try {
      client.setWeather(weather);
      assert.deepEqual(await client.calculate(defaults), expected);
      assert.ok(data.planes.every((plane) => plane.byteLength > 0));
    } finally { client.dispose(); }
  }
});

test('date bounds exclude both neighboring periods across bit boundaries and use selected years', async () => {
  const data = {...tinyData(161), years: 5};
  const client = compute.createClient(data, {Worker: null});
  try {
    for (const [startDay, endDay, years] of [[0, 32, 1], [1, 129, 3], [31, 33, 1], [32, 64, 1], [64, 161, 5], [160, 161, 1]]) {
      const controls = {...defaults, rainMode: 'any', startDay, endDay, years};
      assert.deepEqual(await client.calculate(controls), legacyCalculate(data, null, controls));
      assert.equal((await client.calculate(controls)).scores[0], (endDay - startDay) / years);
    }
    for (const range of [{startDay: -1}, {endDay: 162}, {startDay: 32, endDay: 32}, {years: 0}, {years: 6}]) {
      assert.equal(await client.calculate({...defaults, rainMode: 'any', ...range}), null);
    }
  } finally { client.dispose(); }
});

test('all five calendar periods match independent daily counting, including leap days and rainfall', async () => {
  const {data, weather} = realData();
  const sample = {...data, nCells: 16};
  const client = compute.createClient(sample, {Worker: NodeWorkerAdapter});
  client.setWeather(weather);
  try {
    for (const [first, last] of [[2023, 2025], [2021, 2025], [2016, 2025], [1991, 2020], [1991, 2025]]) {
      const startDay = (Date.UTC(first, 0, 1) - Date.UTC(1991, 0, 1)) / 86400000;
      const endDay = (Date.UTC(last + 1, 0, 1) - Date.UTC(1991, 0, 1)) / 86400000;
      const controls = {...defaults, startDay, endDay, years: last - first + 1};
      assert.deepEqual(await client.calculate(controls), legacyCalculate(sample, weather, controls));
    }
  } finally { client.dispose(); }
});

test('real-data temperature, all rainfall categories and sunlight/wind combinations match the previous implementation', async () => {
  const {data, weather} = realData();
  const sample = {...data, nCells: 16};
  const client = compute.createClient(sample, {Worker: null});
  client.setWeather(weather);
  try {
    const combinations = [
      {...defaults, rainMode: 'any', tempLo: -20, tempHi: 50, useSun: false},
      {...defaults, tempLo: 18.5, tempHi: 29.5, useSun: false, useWind: true, windMin: 5, windMax: 30},
      ...levels.map((_level, index) => ({...defaults, rainMode: 'wet', rainLo: index, rainHi: index, tempLo: -20, tempHi: 50, useSun: index % 2 === 0, sunMin: 0, sunMax: 10.5})),
    ];
    for (const controls of combinations) assert.deepEqual(await client.calculate(controls), legacyCalculate(sample, weather, controls));
  } finally { client.dispose(); }
});

test('worker keeps one active request and only the newest pending request, initializes once and never transfers source buffers', async () => {
  const data = tinyData(10000);
  const client = compute.createClient(data, {Worker: LoopbackWorker});
  try {
    const any = {...defaults, rainMode: 'any'};
    const first = client.calculate(any);
    await new Promise(setImmediate);
    const pending = [];
    for (let index = 0; index < 20; index++) pending.push(client.calculate({...any, tempHi: 24 + index / 10}));
    assert.equal(await first, null);
    const results = await Promise.all(pending);
    assert.ok(results.slice(0, -1).every((result) => result === null));
    assert.equal(results.at(-1).scores[0], data.nDays);
    const worker = LoopbackWorker.instances.at(-1);
    assert.equal(worker.messages.filter((message) => message.type === 'init').length, 1);
    assert.equal(worker.messages.filter((message) => message.type === 'calculate').length, 2);
    assert.ok(data.planes.every((plane) => plane.byteLength === data.nDays));
    const later = client.calculate(any);
    client.cancel();
    assert.equal(await later, null);
    assert.equal((await client.calculate(any)).scores[0], data.nDays);
  } finally { client.dispose(); }
});

test('bitset counts preserve every byte value, partial words, decimal bounds and cell/month boundaries', async () => {
  for (const days of [31, 32, 33, 65, 517]) {
    const data = tinyData(days);
    data.nCells = 3;
    data.planes = Array.from({length: 6}, () => new Uint8Array(days * data.nCells));
    for (let cell = 0; cell < data.nCells; cell++) for (let day = 0; day < days; day++) {
      const i = cell * days + day;
      data.planes[0][i] = day % 256;
      data.planes[1][i] = cell === 0 ? day % 256 : (day * 7 + cell * 31) % 256;
      data.planes[4][i] = (day * 13 + cell * 17) % 256;
      data.planes[5][i] = (day * 37 + cell * 7) % 256;
    }
    const rainfall = [null, -1, 0, 0.99, 1, 9.99, 10, 24.99, 25, 79.99, 80, 199.99, 200, 331.05];
    const weather = {cellGrid: [0, 1, 0], grids: [0, 1].map((grid) => ({rain: Array.from({length: days}, (_, day) => rainfall[(day + grid) % rainfall.length])}))};
    const client = compute.createClient(data, {Worker: null});
    client.setWeather(weather);
    try {
      const any = {...defaults, rainMode: 'any', useSun: false, useWind: false, tempLo: -1e308, tempHi: 1e308};
      const settings = [any, {...any, tempLo: -40, tempHi: -40}, {...any, tempLo: 87, tempHi: 87},
        {...any, tempLo: 87.5, tempHi: 90}, {...any, tempLo: 20.000000000000004, tempHi: 28},
        {...any, tempLo: 20, tempHi: 27.999999999999996}];
      for (let value = 0; value < 255; value += days < 100 ? 31 : 1) {
        settings.push({...any, tempLo: value / 2 - 40, tempHi: value / 2 - 40});
      }
      for (let seed = 0; seed < 32; seed++) settings.push({...any,
        tempLo: seed - 40.1, tempHi: seed + 31.3, rainMode: seed % 3 === 0 ? 'any' : seed % 3 === 1 ? 'dry' : 'wet',
        rainLo: seed % 5, rainHi: 4, useSun: seed % 2 === 0, sunMin: seed / 2, sunMax: seed / 2 + 16,
        useWind: seed % 4 !== 0, windMin: seed, windMax: seed + 70});
      for (const controls of settings) assert.deepEqual(await client.calculate(controls), legacyCalculate(data, weather, controls), `days=${days} ${JSON.stringify(controls)}`);
    } finally { client.dispose(); }
  }
});

test('cached indexes reuse work without retaining stale rain masks or mutable result arrays', async () => {
  const data = tinyData(65), client = compute.createClient(data, {Worker: null});
  const wet = {grids: [{rain: Array(65).fill(331.05)}], cellGrid: [0]};
  const dry = {grids: [{rain: Array(65).fill(0.99)}], cellGrid: [0]};
  try {
    client.setWeather(dry);
    const first = await client.calculate(defaults);
    first.scores[0] = -1;
    first.monthScores[0][0] = -1;
    assert.deepEqual(await client.calculate(defaults), legacyCalculate(data, dry, defaults));
    for (const weather of [wet, null, dry]) {
      client.setWeather(weather);
      for (const controls of [defaults, {...defaults, rainMode: 'any'}, {...defaults, rainMode: 'wet', rainLo: 4, rainHi: 4}, defaults]) {
        const expectedWeather = weather || {grids: [{rain: Array(65).fill(null)}], cellGrid: [0]};
        assert.deepEqual(await client.calculate(controls), legacyCalculate(data, expectedWeather, controls));
      }
    }
  } finally { client.dispose(); }
});

test('worker weather updates cancel outstanding work and only retain precipitation fields', async () => {
  const data = tinyData();
  const client = compute.createClient(data, {Worker: LoopbackWorker});
  const weather = (rain) => ({grids: [{rain: Array(data.nDays).fill(rain), unused: 'excluded'}], cellGrid: [0], towns: ['excluded']});
  try {
    client.setWeather(weather(0.99));
    assert.equal((await client.calculate(defaults)).scores[0], data.nDays);
    const old = client.calculate(defaults);
    client.setWeather(weather(1));
    assert.equal(await old, null);
    assert.equal((await client.calculate(defaults)).scores[0], 0);
    assert.equal((await client.calculate({...defaults, rainMode: 'wet', rainLo: 0, rainHi: 0})).scores[0], data.nDays);
    client.setWeather(null);
    assert.equal((await client.calculate({...defaults, rainMode: 'any'})).scores[0], data.nDays);
    const worker = LoopbackWorker.instances.at(-1);
    for (const message of worker.messages.filter((item) => item.type === 'weather' && item.weather)) {
      assert.deepEqual(Object.keys(message.weather).sort(), ['cellGrid', 'grids']);
      assert.deepEqual(Object.keys(message.weather.grids[0]), ['rain']);
    }
  } finally { client.dispose(); }
});

test('fallback yields before and during calculation and can be cancelled between chunks', async () => {
  let yields = 0, clock = 0, cancelled = false;
  const client = compute.createClient(tinyData(100000), {
    Worker: null, now: () => clock += 5,
    setTimeout(callback, delay) {
      yields++;
      return setTimeout(() => { if (yields === 3 && !cancelled) { cancelled = true; client.cancel(); } callback(); }, delay);
    }, clearTimeout,
  });
  try {
    const result = client.calculate({...defaults, rainMode: 'any'});
    assert.equal(yields, 1);
    assert.equal(await result, null);
    assert.ok(yields >= 3);
    assert.equal(cancelled, true);
    client.dispose();
    assert.equal(await client.calculate(defaults), null);
  } finally { client.dispose(); }
});

test('fallback replaces pending requests and applies weather changes before the newest calculation', async () => {
  let clock = 0;
  const data = tinyData(10000);
  const client = compute.createClient(data, {Worker: null, now: () => clock += 5});
  const weather = (rain) => ({grids: [{rain: Array(data.nDays).fill(rain)}], cellGrid: [0]});
  try {
    client.setWeather(weather(0));
    const first = client.calculate(defaults);
    await new Promise(setImmediate);
    const replaced = client.calculate({...defaults, tempHi: 24});
    client.setWeather(weather(25));
    const discarded = client.calculate(defaults);
    const newest = client.calculate({...defaults, rainMode: 'wet', rainLo: 2, rainHi: 2});
    assert.equal(await first, null);
    assert.equal(await replaced, null);
    assert.equal(await discarded, null);
    assert.equal((await newest).scores[0], data.nDays);
  } finally { client.dispose(); }
});

test('worker constructor, initialization, execution, serialization errors and timeouts fall back without a synchronous full scan', async () => {
  class ConstructorFailure { constructor() { throw new Error('blocked'); } }
  class InitFailure { postMessage() { throw new Error('clone'); } terminate() {} }
  class SilentWorker { postMessage() {} terminate() {} }
  class ExecutionFailure {
    postMessage(message) {
      if (message.type === 'init') queueMicrotask(() => this.onmessage?.({data: {type: 'ready'}}));
      if (message.type === 'calculate') queueMicrotask(() => this.onerror?.(new Error('stopped')));
    }
    terminate() {}
  }
  class MessageFailure extends ExecutionFailure {
    postMessage(message) {
      if (message.type === 'init') super.postMessage(message);
      else if (message.type === 'calculate') queueMicrotask(() => this.onmessageerror?.(new Error('deserialize')));
    }
  }
  class ActiveTimeout extends ExecutionFailure {
    postMessage(message) { if (message.type === 'init') super.postMessage(message); }
  }
  for (const Worker of [ConstructorFailure, InitFailure, SilentWorker, ExecutionFailure, MessageFailure, ActiveTimeout]) {
    let yields = 0;
    const client = compute.createClient(tinyData(), {Worker, timeoutMs: 10, setTimeout(callback, delay) { yields++; return setTimeout(callback, delay); }, clearTimeout});
    try {
      const result = await client.calculate({...defaults, rainMode: 'any'});
      assert.equal(result.scores[0], 768, Worker.name);
      assert.ok(yields >= 1, Worker.name);
    } finally { client.dispose(); }
  }
});

test('stale worker results cannot settle a newer request, and disposal settles active and pending promises', async () => {
  class ControlledWorker {
    static last;
    constructor() { ControlledWorker.last = this; this.messages = []; }
    postMessage(message) {
      this.messages.push(message);
      if (message.type === 'init') queueMicrotask(() => this.onmessage?.({data: {type: 'ready'}}));
    }
    terminate() { this.stopped = true; }
    reply(id, result) { this.onmessage?.({data: {type: 'result', id, result}}); }
  }
  const client = compute.createClient(tinyData(), {Worker: ControlledWorker});
  const first = client.calculate(defaults);
  await new Promise(setImmediate);
  const second = client.calculate(defaults);
  const worker = ControlledWorker.last;
  const id = worker.messages.find((message) => message.type === 'calculate').id;
  worker.reply(id, {scores: [-1], monthScores: []});
  worker.reply(id, {scores: [-2], monthScores: []});
  const nextId = worker.messages.filter((message) => message.type === 'calculate').at(-1).id;
  worker.reply(nextId, {scores: [42], monthScores: []});
  assert.equal(await first, null);
  assert.equal((await second).scores[0], 42);
  const active = client.calculate(defaults), pending = client.calculate(defaults);
  client.dispose();
  assert.equal(await active, null);
  assert.equal(await pending, null);
  assert.equal(worker.stopped, true);
});
