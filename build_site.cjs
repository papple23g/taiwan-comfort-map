const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const ROOT = __dirname;
const DATA_NAMES = ['meta.json', 'towns.geojson', 'climate.bin', 'weather-details.json'];
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

function buildSite() {
  const output = path.resolve(ROOT, 'dist');
  if (path.dirname(output) !== path.resolve(ROOT) || path.basename(output) !== 'dist') throw new Error('部署目錄必須是專案內的 dist');
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('部署目錄不可是連結');
  const files = new Map(DATA_NAMES.map((name) => [name, fs.readFileSync(path.join(ROOT, 'data', name))]));
  const hash = crypto.createHash('sha256');
  for (const [name, bytes] of files) hash.update(name).update('\0').update(bytes);
  const version = hash.digest('hex').slice(0, 16);
  const base = `data/${version}/`;
  const original = files.get('climate.bin');
  const assets = new Map(files), climateFiles = [];
  if (original.length > MAX_ASSET_BYTES) {
    assets.delete('climate.bin');
    for (let offset = 0; offset < original.length; offset += MAX_ASSET_BYTES) {
      const name = `climate.part-${climateFiles.length + 1}.bin`;
      climateFiles.push(name);
      assets.set(name, original.subarray(offset, offset + MAX_ASSET_BYTES));
    }
  } else climateFiles.push('climate.bin');
  for (const [name, bytes] of assets) if (bytes.length > MAX_ASSET_BYTES) throw new Error(`公開資產超過 25 MiB：${name}`);
  const source = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const computeBytes = fs.readFileSync(path.join(ROOT, 'climate-compute.js'));
  const computeVersion = crypto.createHash('sha256').update(computeBytes).digest('hex').slice(0, 16);
  const computeFile = `climate-compute.${computeVersion}.js`;
  const declaration = /^const DATA_FILES = .*;$/m;
  if (!declaration.test(source)) throw new Error('找不到前端資料路徑設定');
  if (!/^const COMPUTE_FILE = ['"]climate-compute\.js['"];$/m.test(source) || !source.includes('<script src="climate-compute.js"></script>')) throw new Error('找不到背景計算模組路徑設定');
  const html = source.replace(declaration, `const DATA_FILES = ${JSON.stringify({
    meta: base + 'meta.json', geo: base + 'towns.geojson',
    climate: climateFiles.length === 1 ? base + climateFiles[0] : climateFiles.map((name) => base + name),
    gzip: base + 'climate.bin.gz', weather: base + 'weather-details.json',
  })};`).replace(/^const COMPUTE_FILE = .*;$/m, `const COMPUTE_FILE = '${computeFile}';`)
    .replace('<script src="climate-compute.js"></script>', `<script src="${computeFile}"></script>`);
  const compressed = zlib.gzipSync(original, {level: 9});
  if (compressed.length > MAX_ASSET_BYTES) throw new Error('壓縮氣候資料超過 25 MiB');
  if (!zlib.gunzipSync(compressed).equals(original)) throw new Error('壓縮資料驗證失敗');

  // dist 僅由本程序產生；先核對固定目錄，再清除舊版公開資產。
  fs.rmSync(output, {recursive: true, force: true});
  fs.mkdirSync(path.join(output, base), {recursive: true});
  for (const [name, bytes] of assets) fs.writeFileSync(path.join(output, base, name), bytes);
  fs.writeFileSync(path.join(output, base, 'climate.bin.gz'), compressed);
  fs.writeFileSync(path.join(output, 'index.html'), html);
  fs.writeFileSync(path.join(output, computeFile), computeBytes);
  fs.copyFileSync(path.join(ROOT, 'favicon.svg'), path.join(output, 'favicon.svg'));
  fs.writeFileSync(path.join(output, '_headers'), `/*
  X-Content-Type-Options: nosniff

/
  Cache-Control: public, max-age=0, must-revalidate, no-transform

/index.html
  Cache-Control: public, max-age=0, must-revalidate, no-transform

/${computeFile}
  Content-Type: text/javascript; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable

${[...assets.keys()].map((name) => `/${base}${name}\n  Cache-Control: public, max-age=31536000, immutable\n`).join('\n')}

/${base}climate.bin.gz
  Content-Type: application/gzip
  Cache-Control: public, max-age=31536000, immutable, no-transform
`);
  return {output, version, computeFile, climateFiles, originalBytes: original.length, gzipBytes: compressed.length};
}

if (require.main === module) process.stdout.write(`${JSON.stringify(buildSite(), null, 2)}\n`);
module.exports = {buildSite};
