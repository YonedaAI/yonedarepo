import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
const assets = {};
for (const [route, file, type] of [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.mjs', 'app.mjs', 'text/javascript; charset=utf-8'],
  ['/style.css', 'style.css', 'text/css; charset=utf-8'],
]) assets[route] = [type, readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8')];
mkdirSync(new URL('./dist/', import.meta.url), {recursive:true});
writeFileSync(new URL('./dist/static.mjs', import.meta.url), `export const assets=${JSON.stringify(assets)};\n`);
writeFileSync(new URL('./dist/worker.js', import.meta.url), readFileSync(new URL('./worker.mjs', import.meta.url)));
for (const file of ['booking.mjs','api.mjs']) writeFileSync(new URL(`./dist/${file}`,import.meta.url),readFileSync(new URL(`./${file}`,import.meta.url)));
