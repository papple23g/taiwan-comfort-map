(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ClimateCompute = api;
  if (typeof document === 'undefined' && typeof root.postMessage === 'function' && typeof root.addEventListener === 'function') {
    api.installWorker(root);
  }
})(globalThis, function (root) {
  'use strict';

  function rainMatches(rain, mode, lo, hi, rainLevels) {
    if (mode === 'any') return true;
    if (!Number.isFinite(rain) || rain < 0) return false;
    if (mode === 'dry') return rain < 1;
    return rain >= rainLevels[lo].min && rain < rainLevels[hi].max;
  }

  function matchesDay(high, low, rain, sun, wind, controls, rainLevels) {
    if (!Number.isFinite(high) || !Number.isFinite(low)) return false;
    if (high < controls.tempLo || high > controls.tempHi || low < controls.tempLo || low > controls.tempHi) return false;
    if (!rainMatches(rain, controls.rainMode, controls.rainLo, controls.rainHi, rainLevels)) return false;
    if (controls.useSun && (!Number.isFinite(sun) || sun < controls.sunMin || sun > controls.sunMax)) return false;
    if (controls.useWind && (!Number.isFinite(wind) || wind < controls.windMin || wind > controls.windMax)) return false;
    return true;
  }

  function rainData(weather) {
    return weather ? {grids: weather.grids.map((grid) => ({rain: grid.rain})), cellGrid: weather.cellGrid} : null;
  }

  function runtime(options) {
    return {
      later: options.setTimeout || root.setTimeout.bind(root),
      clear: options.clearTimeout || root.clearTimeout.bind(root),
      now: options.now || (() => root.performance ? root.performance.now() : Date.now()),
      // 背景允許較長批次以減少計時器往返；主執行緒仍每約 4ms 讓出操作時間。
      chunkMs: options.background ? 16 : Math.max(1, Math.min(6, options.chunkMs || 4)),
    };
  }

  // 位元切片索引以每個 32 位元字同時計算 32 天；35 年的四個欄位共約 19MB，僅建一次。
  function indexBlock(source, slices, offset, wordBase, from, end) {
    for (let day = from; day < end; day += 32) {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, b7 = 0;
      const count = Math.min(32, end - day), word = wordBase + (day >>> 5);
      for (let bit = 0; bit < count; bit += 1) {
        const value = source[offset + day + bit];
        b0 |= (value & 1) << bit; b1 |= ((value >>> 1) & 1) << bit;
        b2 |= ((value >>> 2) & 1) << bit; b3 |= ((value >>> 3) & 1) << bit;
        b4 |= ((value >>> 4) & 1) << bit; b5 |= ((value >>> 5) & 1) << bit;
        b6 |= ((value >>> 6) & 1) << bit; b7 |= ((value >>> 7) & 1) << bit;
      }
      slices[0][word] = b0; slices[1][word] = b1; slices[2][word] = b2; slices[3][word] = b3;
      slices[4][word] = b4; slices[5][word] = b5; slices[6][word] = b6; slices[7][word] = b7;
    }
  }

  function rangeBlock(slices, target, lower, upper, from, end) {
    for (let word = from; word < end; word += 1) {
      let above = 0, equalLower = -1, below = 0, equalUpper = -1;
      for (let bit = 7; bit >= 0; bit -= 1) {
        const values = slices[bit][word], mask = 1 << bit;
        if (lower & mask) equalLower &= values;
        else { above |= equalLower & values; equalLower &= ~values; }
        if (upper & mask) { below |= equalUpper & ~values; equalUpper &= values; }
        else equalUpper &= ~values;
      }
      target[word] = (above | equalLower) & (below | equalUpper);
    }
  }

  function encodedBounds(lo, hi, scale, offset) {
    let lower = 255, upper = -1;
    // 沿用原始解碼比較，避免進階小數在反向換算整數時被浮點誤差吃掉。
    for (let value = 0; value < 255; value += 1) {
      const decoded = value / scale + offset;
      if (decoded >= lo && decoded <= hi) { lower = Math.min(lower, value); upper = value; }
    }
    return [lower, upper];
  }

  function popcount(value) {
    value -= (value >>> 1) & 0x55555555;
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }

  function countWords(index, masks, rain, from, end, wordBase, monthly, firstDay, endDay) {
    const {monthMasks, monthBits} = index;
    let matched = 0;
    for (let word = from; word < end; word += 1) {
      const position = wordBase + word;
      let value = masks[0][position] & masks[1][position];
      if (masks[2]) value &= masks[2][position];
      if (masks[3]) value &= masks[3][position];
      if (rain) value &= rain[word];
      if (word === (firstDay >>> 5)) value &= -1 << (firstDay & 31);
      if (word === ((endDay - 1) >>> 5) && (endDay & 31)) value &= (2 ** (endDay & 31)) - 1;
      if (!value) continue;
      matched += popcount(value);
      let remaining = monthBits[word];
      while (remaining) {
        const bit = remaining & -remaining, month = 31 - Math.clz32(bit);
        monthly[month] += popcount(value & monthMasks[month][word]);
        remaining ^= bit;
      }
    }
    return matched;
  }

  async function calculateChunks(data, weather, controls, token, clock, cache) {
    const {planes, months, years, nCells, nDays, rainLevels} = data;
    const firstDay = controls.startDay ?? 0, endDay = controls.endDay ?? nDays;
    const selectedYears = controls.years ?? years;
    if (!Number.isInteger(firstDay) || !Number.isInteger(endDay) || firstDay < 0 || endDay > nDays || firstDay >= endDay
      || !Number.isInteger(selectedYears) || selectedYears < 1 || selectedYears > years) throw new Error('資料期間無效');
    const pause = () => new Promise((resolve) => clock.later(resolve, 0));
    await pause();
    let started = clock.now();
    const yieldIfNeeded = async () => {
      if (clock.now() - started >= clock.chunkMs) {
        await pause();
        started = clock.now();
      }
      return token.cancelled;
    };
    if (token.cancelled) return null;
    if (!cache.index) {
      const wordsPerCell = Math.ceil(nDays / 32), size = wordsPerCell * nCells;
      const fields = [];
      for (const plane of [0, 1, 4, 5]) {
        const slices = Array.from({length: 8}, () => new Uint32Array(size));
        for (let cell = 0; cell < nCells; cell += 1) {
          for (let day = 0; day < nDays; day += 2048) {
            indexBlock(planes[plane], slices, cell * nDays, cell * wordsPerCell, day, Math.min(day + 2048, nDays));
            if (await yieldIfNeeded()) return null;
          }
        }
        fields.push(slices);
      }
      const monthMasks = Array.from({length: 12}, () => new Uint32Array(wordsPerCell));
      const monthBits = new Uint16Array(wordsPerCell);
      for (let day = 0; day < nDays; day += 1) {
        const month = months[day] - 1, word = day >>> 5;
        monthMasks[month][word] |= 1 << (day & 31);
        monthBits[word] |= 1 << month;
      }
      cache.index = {wordsPerCell, size, fields, monthMasks, monthBits};
      cache.ranges = [];
    }
    const index = cache.index, masks = [];
    const ranges = [encodedBounds(controls.tempLo, controls.tempHi, 2, -40), encodedBounds(controls.tempLo, controls.tempHi, 2, -40),
      controls.useSun ? encodedBounds(controls.sunMin, controls.sunMax, 2, 0) : null,
      controls.useWind ? encodedBounds(controls.windMin, controls.windMax, 1, 0) : null];
    for (let field = 0; field < 4; field += 1) {
      const bounds = ranges[field];
      if (!bounds) { masks.push(null); continue; }
      const key = bounds.join(',');
      if (cache.ranges[field]?.key !== key) {
        const values = new Uint32Array(index.size);
        if (bounds[0] <= bounds[1]) {
          for (let word = 0; word < index.size; word += 2048) {
            rangeBlock(index.fields[field], values, bounds[0], bounds[1], word, Math.min(word + 2048, index.size));
            if (await yieldIfNeeded()) return null;
          }
        }
        cache.ranges[field] = {key, values};
      }
      masks.push(cache.ranges[field].values);
    }
    let rainfall = null;
    if (controls.rainMode !== 'any') {
      const rainKey = JSON.stringify([controls.rainMode, controls.rainMode === 'wet' ? controls.rainLo : null, controls.rainMode === 'wet' ? controls.rainHi : null]);
      if (cache.rainWeather !== weather || cache.rainKey !== rainKey) {
        const grids = [];
        if (weather) for (const grid of weather.grids) {
          const values = new Uint32Array(index.wordsPerCell);
          for (let day = 0; day < nDays; day += 1) {
            if (rainMatches(grid.rain[day], controls.rainMode, controls.rainLo, controls.rainHi, rainLevels)) values[day >>> 5] |= 1 << (day & 31);
            if ((day & 2047) === 2047 && await yieldIfNeeded()) return null;
          }
          grids.push(values);
        }
        cache.rainWeather = weather;
        cache.rainKey = rainKey;
        cache.rainfall = grids;
      }
      rainfall = cache.rainfall;
    }
    const scores = new Array(nCells), monthScores = new Array(nCells);
    const missingRain = new Uint32Array(index.wordsPerCell);
    for (let cell = 0; cell < nCells; cell += 1) {
      let matched = 0;
      const monthly = new Uint32Array(12), rain = rainfall ? (weather && rainfall[weather.cellGrid[cell]]) || missingRain : null;
      const endWord = Math.ceil(endDay / 32);
      for (let word = firstDay >>> 5; word < endWord; word += 256) {
        matched += countWords(index, masks, rain, word, Math.min(word + 256, endWord), cell * index.wordsPerCell, monthly, firstDay, endDay);
        if (await yieldIfNeeded()) return null;
      }
      scores[cell] = matched / selectedYears;
      monthScores[cell] = Array.from(monthly, (count) => count / selectedYears);
    }
    return token.cancelled ? null : {scores, monthScores};
  }

  function createClient(data, options = {}) {
    const clock = runtime(options);
    const WorkerClass = Object.prototype.hasOwnProperty.call(options, 'Worker') ? options.Worker : root.Worker;
    const timeoutMs = options.timeoutMs || 15000;
    let worker = null, ready = false, disposed = false, watchdog = null;
    let active = null, pending = null, serial = 0, weather = null;
    const cache = {};

    function settle(job, value) {
      if (!job || job.settled) return;
      job.settled = true;
      job.resolve(value);
    }

    function clearWatchdog() {
      if (watchdog !== null) clock.clear(watchdog);
      watchdog = null;
    }

    function watch() {
      clearWatchdog();
      watchdog = clock.later(failWorker, timeoutMs);
    }

    function failWorker() {
      clearWatchdog();
      if (worker) {
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
      }
      worker = null;
      ready = false;
      if (active) {
        active.token.cancelled = true;
        if (!active.settled && !pending) pending = active;
        else settle(active, null);
        active = null;
      }
      launch();
    }

    function finished(job, result) {
      if (active !== job) return;
      clearWatchdog();
      active = null;
      settle(job, job.token.cancelled ? null : result);
      launch();
    }

    function launch() {
      if (disposed || active || !pending || (worker && !ready)) return;
      const job = pending;
      pending = null;
      active = job;
      job.token = {cancelled: false};
      if (worker) {
        watch();
        try {
          worker.postMessage({type: 'calculate', id: job.id, controls: job.controls});
        } catch (_) {
          failWorker();
        }
      } else {
        calculateChunks(data, weather, job.controls, job.token, clock, cache)
          .then((result) => finished(job, result), () => finished(job, null));
      }
    }

    function cancelActive() {
      if (!active) return;
      settle(active, null);
      if (active.token.cancelled) return;
      active.token.cancelled = true;
      if (worker) {
        try { worker.postMessage({type: 'cancel', id: active.id}); }
        catch (_) { failWorker(); }
      }
    }

    function cancel() {
      settle(pending, null);
      pending = null;
      cancelActive();
    }

    function calculate(controls) {
      if (disposed) return Promise.resolve(null);
      return new Promise((resolve) => {
        settle(pending, null);
        pending = {id: ++serial, controls: {...controls}, resolve, settled: false, token: {cancelled: false}};
        cancelActive();
        launch();
      });
    }

    function setWeather(value) {
      cancel();
      weather = rainData(value);
      if (worker) {
        try { worker.postMessage({type: 'weather', weather}); }
        catch (_) { failWorker(); }
      }
    }

    function dispose() {
      cancel();
      disposed = true;
      clearWatchdog();
      if (worker) {
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
      }
      worker = null;
    }

    if (WorkerClass) {
      try {
        worker = new WorkerClass(options.workerURL || 'climate-compute.js');
        worker.onmessage = (event) => {
          if (disposed || !worker) return;
          const message = event.data || {};
          if (message.type === 'ready' && !ready) {
            ready = true;
            clearWatchdog();
            launch();
          } else if (message.type === 'result' && active && message.id === active.id) {
            finished(active, message.result);
          } else if (message.type === 'error') {
            failWorker();
          }
        };
        worker.onerror = worker.onmessageerror = failWorker;
        watch();
        // 不使用 transfer list，避免移除主頁圖表仍需使用的原始 buffer。
        worker.postMessage({type: 'init', data, chunkMs: clock.chunkMs});
      } catch (_) {
        failWorker();
      }
    }
    return {calculate, setWeather, cancel, dispose};
  }

  function installWorker(scope) {
    let data = null, weather = null, token = null, clock = runtime({});
    let cache = {};
    scope.addEventListener('message', (event) => {
      const message = event.data || {};
      try {
        if (message.type === 'init') {
          if (token) token.cancelled = true;
          data = message.data;
          cache = {};
          clock = runtime({chunkMs: message.chunkMs, background: true});
          scope.postMessage({type: 'ready'});
        } else if (message.type === 'weather') {
          if (token) token.cancelled = true;
          weather = rainData(message.weather);
        } else if (message.type === 'cancel') {
          if (token && token.id === message.id) token.cancelled = true;
        } else if (message.type === 'calculate') {
          if (token) token.cancelled = true;
          const next = {id: message.id, cancelled: false};
          token = next;
          calculateChunks(data, weather, message.controls, next, clock, cache).then(
            (result) => scope.postMessage({type: 'result', id: message.id, result}),
            () => scope.postMessage({type: 'error', id: message.id})
          );
        }
      } catch (_) {
        scope.postMessage({type: 'error', id: message.id});
      }
    });
  }

  return {rainMatches, matchesDay, createClient, installWorker};
});
