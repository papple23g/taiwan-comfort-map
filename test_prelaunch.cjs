const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const {buildSite} = require('./build_site.cjs');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const definitions = script.slice(0, script.indexOf('\nload().then('));
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/meta.json')));
const geo = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/towns.geojson')));
const weather = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/weather-details.json')));
const binary = fs.readFileSync(path.join(__dirname, 'data/climate.bin'));
const townCodes = new Set(meta.towns.map((town) => town.code));
const plain = (value) => JSON.parse(JSON.stringify(value));

function scope(extra = {}) {
  const context = vm.createContext({URL, URLSearchParams, Response, DecompressionStream, Event, Blob, File,
    console: {warn() {}}, document: {getElementById: () => ({})}, ...extra});
  vm.runInContext(definitions, context);
  return context;
}

test('version 1 preserves both temperature modes, decimals, inactive ranges, empty regions and sorting', () => {
  const api = scope(), state = api.defaultShareState();
  state.town = meta.towns[12].code;
  state.temperature = {mode: 'advanced', basic: {lo: 19.5, hi: 30}, advanced: {lo: -12.3456789, hi: 42.71234567}};
  state.rain = {mode: 'any', lo: 2, hi: 3};
  state.sun = {mode: 'any', lo: 2.5, hi: 4};
  state.wind = {mode: 'any', lo: 19, hi: 44};
  state.regions = [];
  state.sort = 'name';
  state.direction = 'ascending';
  const hash = api.encodeShareState(state), decoded = api.decodeShareState(hash, townCodes);
  assert.match(hash, /^#v=1&/);
  assert.equal(decoded.shared, true);
  assert.equal(decoded.invalid, false);
  assert.deepEqual(plain(decoded.state), plain(state));
  assert.equal(api.encodeShareState(decoded.state), hash);
  state.temperature.advanced = {lo: -1e308, hi: 1e308};
  assert.deepEqual(plain(api.decodeShareState(api.encodeShareState(state), townCodes).state), plain(state));
  for (const mode of ['basic', 'advanced']) {
    state.temperature.mode = mode;
    assert.deepEqual(plain(api.decodeShareState(api.encodeShareState(state), townCodes).state), plain(state));
  }
});

test('invalid or unsupported fragments fall back entirely, with no executable URL content', () => {
  const api = scope(), defaults = api.defaultShareState(), valid = api.encodeShareState(defaults);
  const bad = ['#v=2', '#v=1', '#<script>alert(1)</script>', '#%XX', valid + '&v=1', valid + '&unknown=1'];
  for (const [key, value] of Object.entries({v: '2', town: 'javascript:alert(1)', temperature: 'other',
    basic: '14,28', advanced: 'Infinity,28', rain: 'none', rainRange: '3,2', sunRange: '6.1,12',
    windRange: '5,71', regions: '北部,北部', sort: '__proto__', direction: 'sideways'})) {
    const params = new URLSearchParams(valid.slice(1));
    params.set(key, value);
    bad.push(`#${params}`);
  }
  for (const hash of bad) {
    const decoded = api.decodeShareState(hash, townCodes);
    assert.equal(decoded.invalid, true, hash);
    assert.equal(decoded.shared, false);
    assert.deepEqual(plain(decoded.state), plain(defaults));
  }
  assert.equal(api.decodeShareState('', townCodes).invalid, false);
});

test('native sharing, cancellation, clipboard and manual fallback are distinct outcomes', async () => {
  const api = scope(), url = 'https://example.test/#v=1';
  let payload, copied;
  assert.equal(await api.shareLink(url, {share: async (value) => { payload = value; }}), 'shared');
  assert.equal(payload.url, url);
  assert.equal(payload.title, '台灣舒適度地圖');
  assert.equal(await api.shareLink(url, {share: async () => { throw {name: 'AbortError'}; }, clipboard: {writeText: () => assert.fail('cancel must not copy')}}), 'cancelled');
  assert.equal(await api.shareLink(url, {clipboard: {writeText: async (value) => { copied = value; }}}), 'copied');
  assert.equal(copied, url);
  assert.equal(await api.shareLink(url, {share: async () => { throw new Error('unavailable'); }, clipboard: {writeText: async () => {}}}), 'copied');
  assert.equal(await api.shareLink(url, {}), 'manual');
  assert.equal(await api.shareLink(url, {clipboard: {writeText: async () => { throw new Error('denied'); }}}), 'manual');
});

test('image sharing checks the actual file and distinguishes cancellation, failure and missing support', async () => {
  const api = scope(), file = new File(['PNG'], 'map.png', {type: 'image/png'});
  let payload;
  const browser = {canShare: (value) => value.files[0] === file, share: async (value) => { payload = value; }};
  assert.equal(await api.shareImage(file, browser), 'shared');
  assert.equal(payload.files[0], file);
  assert.equal(payload.url, undefined);
  assert.equal(await api.shareImage(file, {}), 'unavailable');
  assert.equal(await api.shareImage(file, {...browser, canShare: () => false}), 'unavailable');
  assert.equal(api.canShareImage(file, {...browser, canShare: () => { throw new Error('blocked'); }}), false);
  assert.equal(await api.shareImage(file, {...browser, share: async () => { throw {name: 'AbortError'}; }}), 'cancelled');
  assert.equal(await api.shareImage(file, {...browser, share: async () => { throw new Error('denied'); }}), 'failed');
});

test('image condition summaries preserve active decimals, half-open rain bounds and inactive settings', () => {
  const api = scope(), state = api.defaultShareState();
  state.temperature.mode = 'advanced';
  state.temperature.advanced = {lo: 19.12345, hi: 30.75};
  state.rain = {mode: 'wet', lo: 1, hi: 2};
  let lines = plain(api.shareConditionLines(state));
  assert.equal(lines[0][1], '19.12345～30.75℃');
  assert.equal(lines[1][1], '有雨（10 ≤ 日雨量 < 80 毫米）');
  assert.equal(lines[2][1], '6～12 小時');
  assert.equal(lines[3][1], '不限');
  state.rain.hi = 4;
  assert.equal(api.shareConditionLines(state)[1][1], '有雨（日雨量 ≥ 10 毫米）');
  state.rain.mode = 'any'; state.sun.mode = 'any';
  state.wind = {mode: 'wind', lo: 17, hi: 17};
  lines = plain(api.shareConditionLines(state));
  assert.equal(lines[1][1], '不限降雨');
  assert.equal(lines[2][1], '不限');
  assert.equal(lines[3][1], '17～17 km/h');
  assert.equal(state.rain.hi, 4);
});

function canvasFixture() {
  const texts = [], shapes = [], transforms = [], stops = [];
  const context = {
    font: '', textAlign: 'left',
    measureText(value) {
      const size = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 20);
      return {width: [...String(value)].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 1 : 0.55), 0) * size};
    },
    fillText(text, x, y) { texts.push({text, x, y, width: this.measureText(text).width, align: this.textAlign}); },
    fillRect() {}, save() {}, restore() {},
    translate(x, y) { transforms.push(['translate', x, y]); },
    scale(x, y) { transforms.push(['scale', x, y]); },
    fill(shape, rule) { shapes.push({kind: 'fill', d: shape.d, fill: this.fillStyle, rule}); },
    stroke(shape) { shapes.push({kind: 'stroke', d: shape.d, stroke: this.strokeStyle, width: this.lineWidth}); },
    createLinearGradient() { return {addColorStop: (...args) => stops.push(args)}; },
  };
  return {texts, shapes, transforms, stops, getContext: () => context, toBlob: (done) => done(new Blob(['PNG'], {type: 'image/png'}))};
}

test('share card uses full-map coordinates, exact colors and selection, fits text and reports export failure', async () => {
  const api = scope(), canvas = canvasFixture(), state = api.defaultShareState();
  state.temperature.mode = 'advanced';
  state.temperature.advanced = {lo: -1.2345678901234567e308, hi: 1.2345678901234567e308};
  const card = {state, town: {code: 'a', name: '這是一個很長但仍完整顯示的鄉鎮名稱'}, days: 150.7,
    siteUrl: api.cleanSiteUrl(new URL('https://example.test/map/?utm=test#v=1')),
    map: {width: 800, height: 1000, paths: [{code: 'a', d: 'M0 0L800 1000Z', fill: '#123456'}, {code: 'b', d: 'M20 20Z', fill: '#abcdef'}]}};
  const blob = await api.renderShareImage(card, canvas, (d) => ({d}));
  assert.equal(blob.type, 'image/png');
  assert.equal(canvas.width, 1080); assert.equal(canvas.height, 1350);
  assert.deepEqual(canvas.shapes.filter((shape) => shape.kind === 'fill').map(({fill, rule}) => [fill, rule]), [['#123456', 'evenodd'], ['#abcdef', 'evenodd']]);
  assert.equal(canvas.shapes.at(-1).d, card.map.paths[0].d);
  assert.equal(canvas.shapes.at(-1).stroke, '#0F172A');
  assert.ok(canvas.transforms.some(([kind, x, y]) => kind === 'scale' && x === y && x === 0.616));
  assert.ok(canvas.texts.some(({text}) => text === '150.7 天'));
  assert.ok(canvas.texts.some(({text}) => text === 'https://example.test/map/'));
  assert.ok(canvas.texts.some(({text}) => text.includes('1991–2020')));
  for (const text of canvas.texts) {
    const left = text.align === 'right' ? text.x - text.width : text.align === 'center' ? text.x - text.width / 2 : text.x;
    assert.ok(left >= 0 && left + text.width <= 1080.01, text.text);
    assert.ok(text.y < 1350);
  }
  assert.throws(() => api.renderShareImage({...card, days: null}, canvas));
  await assert.rejects(api.renderShareImage(card, {...canvas, toBlob: (done) => done(null)}, (d) => ({d})), /匯出/);
});

test('gzip loading produces byte-identical data and does not request the raw file on success', async () => {
  const requests = [], progress = [], compressed = zlib.gzipSync(binary);
  const api = scope({fetch: async (url) => { requests.push(url); return new Response(compressed); }});
  const result = await api.loadClimate({gzip: 'climate.bin.gz', climate: 'climate.bin'}, meta, (text) => progress.push(text));
  assert.ok(Buffer.from(result).equals(binary));
  assert.deepEqual(requests, ['climate.bin.gz']);
  assert.ok(progress.some((text) => text.includes('解壓')));
});

test('unsupported compression, HTTP, corrupt gzip and wrong payload each use at most one raw fallback', async () => {
  const wrong = zlib.gzipSync(Buffer.from('<html>not climate data</html>'));
  for (const scenario of ['unsupported', 'http', 'gzip', 'payload']) {
    const requests = [];
    const api = scope({fetch: async (url) => {
      requests.push(url);
      if (url === 'raw') return new Response(binary);
      if (scenario === 'http') return new Response('missing', {status: 404});
      return new Response(scenario === 'payload' ? wrong : Buffer.from('corrupt'));
    }});
    const result = await api.loadClimate({gzip: 'gz', climate: 'raw'}, meta, () => {}, scenario === 'unsupported' ? null : DecompressionStream);
    assert.ok(Buffer.from(result).equals(binary), scenario);
    assert.deepEqual(requests, scenario === 'unsupported' ? ['raw'] : ['gz', 'raw']);
  }
});

test('main data failure rejects without zero results, and a fresh retry can recover', async () => {
  let failing = true;
  const requests = [], api = scope({fetch: async (url) => {
    requests.push(url);
    return failing ? new Response('unavailable', {status: 503}) : new Response(binary);
  }});
  await assert.rejects(api.loadClimate({gzip: 'gz', climate: 'raw'}, meta));
  assert.deepEqual(requests, ['gz', 'raw']);
  failing = false;
  assert.ok(Buffer.from(await api.loadClimate({gzip: null, climate: 'raw'}, meta)).equals(binary));
  assert.deepEqual(requests, ['gz', 'raw', 'raw']);
  for (const bytes of [Buffer.alloc(0), binary.subarray(0, binary.length - 1)]) {
    assert.throws(() => api.validateClimate(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), meta));
  }
});

test('historical annual and monthly results match the original implementation for every township', () => {
  const api = scope();
  const planes = Array.from({length: 6}, (_, i) => new Uint8Array(binary.buffer, binary.byteOffset + 16 + i * meta.cells.length * meta.days, meta.cells.length * meta.days));
  function calculator(source) {
    const decTemp = source.slice(source.indexOf('  function decTemp('), source.indexOf('  function readControls('));
    const day = source.slice(source.indexOf('  function dayOk('), source.indexOf('  function compute(')).replace('function dayOk(', 'function originalDayOk(');
    const compute = source.slice(source.indexOf('  function compute('), source.indexOf('  function paintReads('));
    return new Function('planes', 'weather', 'nCells', 'nDays', 'months', 'meta', 'matchesDay', 'effectiveConditions', `
      let settings, computedKey = null, scores, monthScores, evaluated = 0;
      const readControls = () => settings;
      ${decTemp}\n${day}\n${compute}
      const dayOk = (...args) => { evaluated++; return originalDayOk(...args); };
      return (controls) => { settings = controls; compute(); return {scores, monthScores, evaluated}; };
    `)(planes, weather, meta.cells.length, meta.days, meta.months, meta, api.matchesDay, api.effectiveConditions);
  }
  const after = calculator(script);
  // 由加入分享與快取前的版本，對同一批 368 個鄉鎮計算的年、月結果。
  const expectedHashes = [
    'bf990fde4ebed73b85fa44a04f652b9dc9069ccf3b718e40813f34957d2f5ac1',
    '0ac8c7f8d32f42e8b031b80b8df641ea8c1554e23fb4cc1ab9c2f483c98fba23',
    '59a15b5128dd0db9a1b379c495db7afc7e7a182201be4effa236d335211b0f80',
  ];
  const defaults = {tempLo: 20, tempHi: 28, rainMode: 'dry', rainLo: 0, rainHi: 4, useSun: true, sunMin: 6, sunMax: 12, useWind: false, windMin: 5, windMax: 30};
  for (const [index, controls] of [defaults,
    {...defaults, tempLo: 19.12345, tempHi: 30.75, rainMode: 'wet', rainLo: 1, rainHi: 3, useWind: true, windMin: 9, windMax: 35},
    {...defaults, tempLo: -1e308, tempHi: 1e308, rainMode: 'any', useSun: false}].entries()) {
    const actual = after(controls);
    const hash = crypto.createHash('sha256').update(JSON.stringify({scores: actual.scores, monthScores: actual.monthScores})).digest('hex');
    assert.equal(hash, expectedHashes[index]);
    assert.equal(after({...controls}).evaluated, actual.evaluated, 'unchanged conditions must not scan history again');
  }
});

class Element {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = tag;
    this.attrs = {...attrs};
    Object.assign(this, {children: [], style: {}, dataset: {}, value: attrs.value ?? '', checked: 'checked' in attrs,
      disabled: 'disabled' in attrs, hidden: 'hidden' in attrs, min: attrs.min, max: attrs.max, step: attrs.step,
      textContent: '', innerHTML: '', clientWidth: 720, scrollWidth: 720, listeners: new Map()});
    if (attrs['data-sort']) this.dataset.sort = attrs['data-sort'];
    this.classes = new Set((attrs.class ?? '').split(' '));
    this.classList = {add: (name) => this.classes.add(name), remove: (name) => this.classes.delete(name),
      toggle: (name, active) => { active ??= !this.classes.has(name); active ? this.classes.add(name) : this.classes.delete(name); }};
  }
  append(...nodes) { for (const node of nodes) { if (node.parentElement) node.parentElement.children = node.parentElement.children.filter((child) => child !== node); node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...nodes); }
  get lastElementChild() { return this.children.at(-1); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  getBoundingClientRect() { return {x: 100, y: 0, left: 100, top: 0, width: 720, height: 44}; }
  getBBox() { return {x: 100, y: 100, width: 20, height: 40}; }
  hasPointerCapture() { return false; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  showModal() { this.open = true; }
  close() { this.open = false; void this.fire('close'); }
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(callback); }
  async fire(name, event = {}) { for (const callback of this.listeners.get(name) ?? []) await callback({target: this, ...event}); }
  matches(selector) {
    const excluded = selector.match(/:not\(([^)]+)\)/);
    if (excluded && this.matches(excluded[1])) return false;
    selector = selector.replace(/:not\([^)]+\)/g, '');
    if (selector.includes(':checked') && !this.checked) return false;
    const tag = selector.match(/^[\w-]+/), id = selector.match(/#([\w-]+)/);
    if (tag && tag[0] !== this.tagName || id && id[1] !== this.attrs.id) return false;
    if ([...selector.matchAll(/\.([\w-]+)/g)].some((match) => !this.classes.has(match[1]))) return false;
    return [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, key, value]) => key in this.attrs && (value === undefined || this.attrs[key] === value));
  }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
    if (selector === '*') return descendants;
    return descendants.filter((node) => selector.split(',').some((part) => {
      const tokens = part.trim().split(/\s+/), last = tokens.pop();
      if (!node.matches(last)) return false;
      let ancestor = node.parentElement;
      while (tokens.length) {
        const token = tokens.pop();
        while (ancestor && !ancestor.matches(token)) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    }));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function documentFixture() {
  const document = new Element(), stack = [document], ids = new Map();
  for (const match of html.split('<script>')[0].matchAll(/<(\/?)([\w-]+)\b([^>]*)>/g)) {
    const [, close, tag, raw] = match;
    if (close) { if (stack.at(-1).tagName === tag) stack.pop(); continue; }
    const attrs = Object.fromEntries([...raw.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, value ?? '']));
    const node = new Element(tag, attrs);
    stack.at(-1).append(node);
    if (attrs.id) ids.set(attrs.id, node);
    if (!['meta', 'link', 'input', 'br'].includes(tag) && !raw.endsWith('/')) stack.push(node);
  }
  document.getElementById = (id) => ids.get(id);
  document.createElement = (tag) => new Element(tag);
  document.createElementNS = (_, tag) => new Element(tag);
  return {document, ids};
}

async function bootFixture(shared, fetchWeather, browser = {}, options = {}) {
  const {document, ids} = documentFixture();
  if (options.canvas) {
    const create = document.createElement;
    document.createElement = (tag) => tag === 'canvas' ? options.canvas : create(tag);
  }
  let location = new URL(`https://example.test/${shared ?? ''}`);
  const window = {get location() { return location; }, history: {replaceState(_, __, value) { location = new URL(value, location); }},
    events: {}, addEventListener(name, callback) { this.events[name] = callback; },
    clearTimeout() {}, setTimeout() { return 1; }, matchMedia: () => ({matches: true})};
  const api = scope({document, window, navigator: browser, fetch: fetchWeather, ResizeObserver: class { observe() {} },
    cancelAnimationFrame() {}, requestAnimationFrame() { return 1; }, ...options.globals});
  api.boot(meta, geo, binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.length));
  await new Promise((resolve) => setImmediate(resolve));
  return {api, window, ids, document};
}

test('main loading disables unavailable controls, exposes retry after failure and recovers the whole app', async () => {
  const {document, ids} = documentFixture();
  let fail = true;
  const window = {location: new URL('https://example.test/'), history: {replaceState() {}}, addEventListener() {}, clearTimeout() {}, setTimeout() {}, matchMedia: () => ({matches: true})};
  const api = scope({document, window, ResizeObserver: class { observe() {} }, cancelAnimationFrame() {}, requestAnimationFrame() {},
    fetch: async (url) => {
      if (fail) return new Response('offline', {status: 503});
      if (url.endsWith('meta.json')) return new Response(JSON.stringify(meta));
      if (url.endsWith('towns.geojson')) return new Response(JSON.stringify(geo));
      if (url.endsWith('weather-details.json')) return new Response(JSON.stringify(weather));
      return new Response(binary);
    }});
  const loading = api.load();
  assert.equal(ids.get('condition-controls').disabled, true);
  assert.equal(ids.get('town-select').disabled, true);
  assert.equal(ids.get('app').getAttribute('aria-busy'), 'true');
  try { await loading; assert.fail('must reject'); } catch (error) { api.showError(error); }
  assert.equal(ids.get('main-retry').hidden, false);
  assert.equal(ids.get('annual').hidden, true);
  assert.match(ids.get('banner').textContent, /尚無法計算/);
  fail = false;
  const [loadedMeta, loadedGeo, bytes] = await api.load();
  api.boot(loadedMeta, loadedGeo, bytes);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ids.get('condition-controls').disabled, false);
  assert.equal(ids.get('town-select').disabled, false);
  assert.equal(ids.get('main-retry').hidden, true);
  assert.equal(ids.get('app').getAttribute('aria-busy'), 'false');
  assert.equal(ids.get('annual').hidden, false);
});

test('shared township is retained on first calculation; later conditions recommend and selection/sort reuse scores', async () => {
  const api = scope(), state = api.defaultShareState();
  state.town = meta.towns[0].code;
  const fixture = await bootFixture(api.encodeShareState(state), async () => new Response(JSON.stringify(weather)));
  const {ids, document, window} = fixture;
  assert.equal(ids.get('town-select').value, state.town);
  assert.equal(ids.get('annual').hidden, false);
  assert.equal(ids.get('weather-status').hidden, true);
  assert.equal(document.querySelector('input[name="rain-mode"]:checked').value, 'dry');
  const first = ids.get('place-days').textContent;
  await ids.get('town-select').fire('change');
  assert.equal(ids.get('place-days').textContent, first);
  await document.querySelector('[data-sort="name"]').fire('click');
  assert.equal(window.location.hash, '');
  await ids.get('share-conditions').fire('click');
  await ids.get('share-link-option').fire('click');
  assert.equal(new URLSearchParams(new URL(ids.get('share-url').value).hash.slice(1)).get('sort'), 'name');
  assert.equal(window.location.hash, '');
  await ids.get('share-close').fire('click');
  await ids.get('sun-min').fire('change');
  const values = ids.get('ranking-body').children.map((row) => ({code: row.querySelector('button').textContent, days: Number(row.lastElementChild.textContent)}));
  assert.equal(Number(ids.get('place-days').textContent.replace(' 天', '')), Math.max(...values.map((row) => row.days)));
});

test('supplement failure preserves rain and selected town, shows no stale or zero score, and retry restores', async () => {
  const api = scope(), state = api.defaultShareState();
  state.town = meta.towns[20].code;
  state.rain = {mode: 'wet', lo: 1, hi: 3};
  let fail = true;
  const {ids, document} = await bootFixture(api.encodeShareState(state), async () => fail ? new Response('offline', {status: 503}) : new Response(JSON.stringify(weather)));
  assert.equal(document.querySelector('input[name="rain-mode"]:checked').value, 'wet');
  assert.equal(ids.get('rain-lo').value, '1');
  assert.equal(ids.get('town-select').value, state.town);
  assert.equal(ids.get('annual').hidden, true);
  assert.equal(ids.get('place-days').textContent, '');
  assert.equal(ids.get('weather-retry').hidden, false);
  assert.equal(ids.get('matching-section').hidden, true);
  assert.match(ids.get('ranking-body').children[0].lastElementChild.textContent, /尚無法計算/);
  await ids.get('share-conditions').fire('click');
  assert.equal(ids.get('share-image-option').disabled, true);
  assert.match(ids.get('share-image-availability').textContent, /資料/);
  await ids.get('share-link-option').fire('click');
  const linked = new URLSearchParams(new URL(ids.get('share-url').value).hash.slice(1));
  assert.equal(linked.get('rain'), 'wet');
  assert.equal(linked.get('rainRange'), '1,3');
  await ids.get('share-close').fire('click');
  fail = false;
  await ids.get('weather-retry').fire('click');
  assert.equal(ids.get('town-select').value, state.town);
  assert.equal(ids.get('annual').hidden, false);
  assert.equal(ids.get('weather-status').hidden, true);
});

test('user can explicitly remove a failed rain restriction without a later response replacing the choice', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const {ids, document} = await bootFixture('', () => pending);
  const radios = document.querySelectorAll('input[name="rain-mode"]');
  for (const radio of radios) radio.checked = radio.value === 'any';
  await radios.find((radio) => radio.value === 'any').fire('change');
  ids.get('town-select').value = meta.towns[0].code;
  await ids.get('town-select').fire('change');
  release(new Response(JSON.stringify(weather)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.querySelector('input[name="rain-mode"]:checked').value, 'any');
  assert.equal(ids.get('town-select').value, meta.towns[0].code);
});

test('reset restores every condition, mode memory, drafts, regions, ordering, recommendation and full map', async () => {
  const api = scope(), state = api.defaultShareState();
  state.temperature = {mode: 'advanced', basic: {lo: 16, hi: 18}, advanced: {lo: -12.345, hi: 42.7}};
  state.rain = {mode: 'wet', lo: 2, hi: 2};
  state.sun = {mode: 'any', lo: 1.5, hi: 3};
  state.wind = {mode: 'wind', lo: 9, hi: 14};
  state.regions = [];
  state.sort = 'name';
  state.direction = 'ascending';
  const {ids, document, window} = await bootFixture(api.encodeShareState(state), async () => new Response(JSON.stringify(weather)));
  ids.get('temperature-lo-number').value = '';
  await ids.get('temperature-lo-number').fire('blur');
  assert.equal(ids.get('temperature-lo-number').getAttribute('aria-invalid'), 'true');
  await ids.get('share-conditions').fire('click');
  assert.match(ids.get('share-notice').textContent, /先修正氣溫輸入/);
  await ids.get('zoom-in').fire('click');
  await ids.get('reset-conditions').fire('click');
  assert.equal(window.location.hash, '');
  assert.equal(document.querySelector('input[name="temperature-mode"]:checked').value, 'basic');
  assert.equal(ids.get('tmax-lo').value, '20');
  assert.equal(ids.get('tmax-hi').value, '28');
  assert.equal(ids.get('temperature-lo-number').getAttribute('aria-invalid'), 'false');
  assert.equal(ids.get('temperature-lo-number').value, '20');
  assert.equal(ids.get('temperature-hi-number').value, '28');
  assert.equal(ids.get('temperature-numbers').hidden, true);
  for (const [name, mode] of [['rain', 'dry'], ['sun', 'sun'], ['wind', 'any']]) assert.equal(document.querySelector(`input[name="${name}-mode"]:checked`).value, mode);
  for (const [id, value] of Object.entries({'rain-lo': '0', 'rain-hi': '4', 'sun-min': '6', 'sun-max': '12', 'wind-min': '5', 'wind-max': '30'})) assert.equal(ids.get(id).value, value);
  assert.ok(document.querySelectorAll('input[name="region"]').every((input) => input.checked));
  assert.equal(ids.get('sort-days').getAttribute('aria-sort'), 'descending');
  assert.equal(ids.get('map').children[0].getAttribute('transform'), 'translate(0 0) scale(1)');
  assert.equal(ids.get('place-days').textContent, ids.get('ranking-body').children[0].lastElementChild.textContent + ' 天');
  const advanced = document.querySelector('input[name="temperature-mode"][value="advanced"]');
  await advanced.fire('change');
  assert.equal(ids.get('temperature-lo-number').value, '20');
  assert.equal(ids.get('temperature-hi-number').value, '28');
});

test('empty regions and invalid links render their intended states without inventing results', async () => {
  const api = scope(), state = api.defaultShareState();
  state.regions = [];
  let fixture = await bootFixture(api.encodeShareState(state), async () => new Response(JSON.stringify(weather)));
  assert.equal(fixture.ids.get('annual').hidden, true);
  assert.match(fixture.ids.get('ranking-body').children[0].lastElementChild.textContent, /至少勾選/);
  await fixture.ids.get('share-conditions').fire('click');
  assert.equal(fixture.ids.get('share-image-option').disabled, true);
  assert.match(fixture.ids.get('share-image-availability').textContent, /先選擇鄉鎮/);
  await fixture.ids.get('share-link-option').fire('click');
  assert.equal(new URLSearchParams(new URL(fixture.ids.get('share-url').value).hash.slice(1)).get('regions'), '');
  fixture = await bootFixture('#v=999', async () => new Response(JSON.stringify(weather)));
  assert.equal(fixture.window.location.hash, '');
  assert.match(fixture.ids.get('share-notice').textContent, /無效或版本不支援/);
  assert.equal(fixture.ids.get('annual').hidden, false);
});

test('opening another fragment in an existing page restores before calculation and rejects unsupported states', async () => {
  const api = scope(), state = api.defaultShareState();
  state.town = meta.towns[0].code;
  state.temperature.mode = 'advanced';
  state.temperature.advanced = {lo: 19.12345, hi: 30.75};
  const {ids, window} = await bootFixture('', async () => new Response(JSON.stringify(weather)));
  window.history.replaceState(null, '', '/' + api.encodeShareState(state));
  window.events.hashchange();
  assert.equal(ids.get('town-select').value, state.town);
  assert.equal(ids.get('tmax-read').textContent, '19.12345~30.75℃');
  assert.equal(ids.get('annual').hidden, false);
  assert.equal(window.location.hash, '');
  window.history.replaceState(null, '', '/#v=999');
  window.events.hashchange();
  assert.equal(window.location.hash, '');
  assert.match(ids.get('share-notice').textContent, /無效或版本不支援/);
  assert.equal(ids.get('tmax-read').textContent, '20~28℃');
});

test('effective condition cache ignores town, sorting, regions and inactive ranges', () => {
  const api = scope(), controls = {tempLo: 20, tempHi: 28, rainMode: 'any', rainLo: 0, rainHi: 4,
    useSun: false, sunMin: 6, sunMax: 12, useWind: false, windMin: 5, windMax: 30};
  const key = api.effectiveConditions(controls);
  assert.equal(api.effectiveConditions({...controls, rainLo: 3, sunMin: 1, windMax: 50, town: 'other', sort: 'name', regions: []}), key);
  assert.notEqual(api.effectiveConditions({...controls, useSun: true}), key);
  assert.notEqual(api.effectiveConditions({...controls, tempHi: 27.5}), key);
});

test('share button shows a selectable manual URL when copying fails and stays quiet on cancellation', async () => {
  const browser = {};
  const {ids, window} = await bootFixture('', async () => new Response(JSON.stringify(weather)), browser);
  await ids.get('share-conditions').fire('click');
  assert.equal(ids.get('share-dialog').open, true);
  assert.equal(ids.get('manual-share').hidden, true);
  await ids.get('share-link-option').fire('click');
  assert.equal(ids.get('manual-share').hidden, false);
  assert.equal(window.location.href, 'https://example.test/');
  assert.notEqual(ids.get('share-url').value, window.location.href);
  assert.match(ids.get('share-url').value, /#v=1&/);
  assert.equal(ids.get('share-url').focused, true);
  assert.equal(ids.get('share-url').selected, true);
  assert.equal(ids.get('share-conditions').disabled, false);
  browser.share = async () => { throw {name: 'AbortError'}; };
  await ids.get('share-link-option').fire('click');
  assert.equal(ids.get('manual-share').hidden, true);
  assert.equal(ids.get('share-dialog-notice').textContent, '');
  assert.equal(ids.get('share-conditions').disabled, false);
});

test('reset discards a pending share result so an old URL cannot reappear', async () => {
  let rejectCopy;
  const copying = new Promise((_, reject) => { rejectCopy = reject; });
  const browser = {clipboard: {writeText: () => copying}};
  const {ids, window} = await bootFixture('', async () => new Response(JSON.stringify(weather)), browser);
  await ids.get('share-conditions').fire('click');
  const sharing = ids.get('share-link-option').fire('click');
  assert.equal(ids.get('share-link-option').disabled, true);
  await ids.get('reset-conditions').fire('click');
  rejectCopy(new Error('denied'));
  await sharing;
  assert.equal(ids.get('share-conditions').disabled, false);
  assert.equal(ids.get('manual-share').hidden, true);
  assert.equal(ids.get('share-url').value, '');
  assert.equal(window.location.hash, '');
  assert.equal(ids.get('share-notice').textContent, '已恢復預設條件。');
});

test('sharing keeps a fixed state while addresses stay clean and reloading starts with defaults', async () => {
  const api = scope(), state = api.defaultShareState();
  state.town = meta.towns[12].code;
  state.temperature = {mode: 'advanced', basic: {lo: 18, hi: 31}, advanced: {lo: 19.12345, hi: 30.75}};
  state.rain = {mode: 'any', lo: 1, hi: 3};
  state.sun = {mode: 'any', lo: 1.5, hi: 3};
  state.wind = {mode: 'any', lo: 17, hi: 44};
  let copied;
  const fixture = await bootFixture(api.encodeShareState(state), async () => new Response(JSON.stringify(weather)), {clipboard: {writeText: async (url) => { copied = url; }}});
  const {ids, window, document} = fixture;
  assert.equal(window.location.href, 'https://example.test/');
  assert.equal(ids.get('town-select').value, state.town);
  await ids.get('share-conditions').fire('click');
  ids.get('town-select').value = meta.towns[13].code;
  await ids.get('town-select').fire('change');
  await document.querySelector('[data-sort="name"]').fire('click');
  await ids.get('share-link-option').fire('click');
  assert.deepEqual(plain(api.decodeShareState(new URL(copied).hash, townCodes).state), plain(state));
  assert.equal(window.location.href, 'https://example.test/');
  await ids.get('share-close').fire('click');
  assert.equal(ids.get('share-dialog').open, false);
  assert.equal(ids.get('share-conditions').focused, true);
  const reloaded = await bootFixture(new URL(window.location.href).hash, async () => new Response(JSON.stringify(weather)));
  assert.equal(reloaded.ids.get('tmax-read').textContent, '20~28℃');
  assert.equal(reloaded.document.querySelector('input[name="rain-mode"]:checked').value, 'dry');
});

test('image preview enables download and supported file sharing, then revokes replaced and closed previews', async () => {
  const canvas = canvasFixture(), created = [], revoked = [], shared = [];
  const browser = {canShare: ({files}) => files[0].type === 'image/png', share: async (payload) => { shared.push(payload); }};
  const {ids, window} = await bootFixture('', async () => new Response(JSON.stringify(weather)), browser, {canvas,
    globals: {Path2D: class {constructor(d) { this.d = d; }}, URL: {createObjectURL: (blob) => {created.push(blob); return `blob:${created.length}`;}, revokeObjectURL: (url) => revoked.push(url)}}});
  await ids.get('zoom-in').fire('click');
  const view = ids.get('map').children[0].getAttribute('transform');
  await ids.get('share-conditions').fire('click');
  await ids.get('share-image-option').fire('click');
  assert.equal(ids.get('share-preview').hidden, false);
  assert.equal(ids.get('share-image-download').getAttribute('href'), 'blob:1');
  assert.equal(ids.get('share-image-send').disabled, false);
  assert.equal(ids.get('map').children[0].getAttribute('transform'), view);
  assert.equal(window.location.hash, '');
  await ids.get('share-image-send').fire('click');
  assert.equal(shared[0].files[0].type, 'image/png');
  assert.equal(shared[0].files[0].name, ids.get('share-image-download').getAttribute('download'));
  await ids.get('share-image-option').fire('click');
  assert.deepEqual(revoked, ['blob:1']);
  await ids.get('share-close').fire('click');
  assert.deepEqual(revoked, ['blob:1', 'blob:2']);
  assert.equal(ids.get('share-preview').getAttribute('src'), null);
  assert.equal(ids.get('share-image-download').hidden, true);
});

test('closing or resetting before PNG export finishes discards stale output, and image failures can retry', async () => {
  const canvas = canvasFixture(), pending = [], created = [];
  canvas.toBlob = (done) => pending.push(done);
  const {ids} = await bootFixture('', async () => new Response(JSON.stringify(weather)), {}, {canvas,
    globals: {Path2D: class {constructor(d) { this.d = d; }}, URL: {createObjectURL: (blob) => { created.push(blob); return 'blob:current'; }, revokeObjectURL() {}}}});
  for (const action of ['share-close', 'reset-conditions']) {
    await ids.get('share-conditions').fire('click');
    const rendering = ids.get('share-image-option').fire('click');
    assert.match(ids.get('share-image-notice').textContent, /製作/);
    await ids.get(action).fire('click');
    pending.shift()(new Blob(['old']));
    await rendering;
    assert.equal(created.length, 0);
    assert.equal(ids.get('share-preview').hidden, true);
  }
  await ids.get('share-conditions').fire('click');
  let rendering = ids.get('share-image-option').fire('click');
  pending.shift()(null);
  await rendering;
  assert.match(ids.get('share-image-notice').textContent, /製作失敗/);
  assert.equal(ids.get('share-image-option').disabled, false);
  rendering = ids.get('share-image-option').fire('click');
  pending.shift()(new Blob(['ready'], {type: 'image/png'}));
  await rendering;
  assert.equal(ids.get('share-preview').hidden, false);
  assert.equal(ids.get('share-image-send').hidden, true);
  assert.equal(ids.get('share-image-download').hidden, false);
  assert.match(ids.get('share-image-notice').textContent, /下載 PNG/);
});

test('deployment output is isolated, versioned, byte-identical and has gzip-safe cache headers', () => {
  const result = buildSite(), base = path.join(result.output, 'data', result.version);
  assert.equal(result.originalBytes, binary.length);
  assert.ok(result.gzipBytes < 8_000_000);
  assert.ok(zlib.gunzipSync(fs.readFileSync(path.join(base, 'climate.bin.gz'))).equals(binary));
  for (const name of ['meta.json', 'towns.geojson', 'climate.bin', 'weather-details.json']) assert.ok(fs.readFileSync(path.join(base, name)).equals(fs.readFileSync(path.join(__dirname, 'data', name))));
  assert.deepEqual(fs.readdirSync(result.output).sort(), ['_headers', 'data', 'favicon.svg', 'index.html']);
  assert.deepEqual(fs.readdirSync(path.join(result.output, 'data')), [result.version]);
  const headers = fs.readFileSync(path.join(result.output, '_headers'), 'utf8');
  assert.match(headers, /max-age=0, must-revalidate/);
  assert.match(headers, /max-age=31536000, immutable/);
  assert.match(headers, /Content-Type: application\/gzip/);
  assert.doesNotMatch(headers, /Content-Encoding:/i);
  const blocks = headers.trim().split(/\n\s*\n/).map((block) => block.split('\n'));
  for (const file of ['/', '/index.html', ...fs.readdirSync(base).map((name) => `/data/${result.version}/${name}`)]) {
    const cacheValues = blocks.filter(([pattern]) => pattern === file || pattern === '/*')
      .flatMap(([, ...lines]) => lines.filter((line) => /^\s+Cache-Control:/.test(line)));
    assert.equal(cacheValues.length, 1, `cache rules must not merge contradictory max-age values: ${file}`);
  }
  const deployed = fs.readFileSync(path.join(result.output, 'index.html'), 'utf8');
  assert.match(deployed, new RegExp(`data/${result.version}/climate.bin.gz`));
  assert.doesNotMatch(deployed, /精確雨量/);
  assert.match(deployed, /<noscript>/);
  assert.match(deployed, /og:description/);
  assert.equal(crypto.createHash('sha256').update(binary).digest('hex'), '4398724fbed4baaea2ccd86efd45c891a768a683fc0201b67c4ce89092385fc8');
});
