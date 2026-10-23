const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const ROOT = __dirname;
const DATA_NAMES = ['meta.json', 'towns.geojson', 'climate.bin', 'weather-details.json'];

function buildSite() {
  const output = path.resolve(ROOT, 'dist');
  if (path.dirname(output) !== path.resolve(ROOT) || path.basename(output) !== 'dist') throw new Error('部署目錄必須是專案內的 dist');
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('部署目錄不可是連結');
  const files = new Map(DATA_NAMES.map((name) => [name, fs.readFileSync(path.join(ROOT, 'data', name))]));
  const hash = crypto.createHash('sha256');
  for (const [name, bytes] of files) hash.update(name).update('\0').update(bytes);
  const version = hash.digest('hex').slice(0, 16);
  const base = `data/${version}/`;
  const source = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const declaration = /^const DATA_FILES = .*;$/m;
  if (!declaration.test(source)) throw new Error('找不到前端資料路徑設定');
  const html = source.replace(declaration, `const DATA_FILES = ${JSON.stringify({
    meta: base + 'meta.json', geo: base + 'towns.geojson', climate: base + 'climate.bin',
    gzip: base + 'climate.bin.gz', weather: base + 'weather-details.json',
  })};`);
  const original = files.get('climate.bin');
  const compressed = zlib.gzipSync(original, {level: 9});
  if (!zlib.gunzipSync(compressed).equals(original)) throw new Error('壓縮資料驗證失敗');

  // dist 僅由本程序產生；先核對固定目錄，再清除舊版公開資產。
  fs.rmSync(output, {recursive: true, force: true});
  fs.mkdirSync(path.join(output, base), {recursive: true});
  for (const [name, bytes] of files) fs.writeFileSync(path.join(output, base, name), bytes);
  fs.writeFileSync(path.join(output, base, 'climate.bin.gz'), compressed);
  fs.writeFileSync(path.join(output, 'index.html'), html);
  fs.copyFileSync(path.join(ROOT, 'favicon.svg'), path.join(output, 'favicon.svg'));
  fs.writeFileSync(path.join(output, '_headers'), `/*
  X-Content-Type-Options: nosniff

/
  Cache-Control: public, max-age=0, must-revalidate, no-transform

/index.html
  Cache-Control: public, max-age=0, must-revalidate, no-transform

${DATA_NAMES.map((name) => `/${base}${name}\n  Cache-Control: public, max-age=31536000, immutable\n`).join('\n')}

/${base}climate.bin.gz
  Content-Type: application/gzip
  Cache-Control: public, max-age=31536000, immutable, no-transform
`);
  return {output, version, originalBytes: original.length, gzipBytes: compressed.length};
}

if (require.main === module) process.stdout.write(`${JSON.stringify(buildSite(), null, 2)}\n`);
module.exports = {buildSite};
