// A dated observation, not a controlled comparison with an earlier connection.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const argument = process.argv.indexOf('--data');
assert(argument >= 0 && process.argv[argument + 1], '--data requires a JSON path');
const source = path.resolve(process.argv[argument + 1]);
const data = JSON.parse(await readFile(source, 'utf8'));
const output = path.dirname(source);
const check = process.argv.includes('--check');
const W = 1600, H = 1250;
const C = { bg: '#101010', panel: '#1b1b1b', line: '#3b3b3b', text: '#f5f5f5', muted: '#b9b9b9', green: '#00dc8b', amber: '#edbc5d' };
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const label = (x, y, value, size = 27, color = C.text, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${extra}>${esc(value)}</text>`;
const panel = (x, y, width, height) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="${C.panel}" stroke="${C.line}"/>`;
const metrics = {};
const metric = (x, y, value, id, color = C.text, size = 31) => {
  assert(Number.isFinite(value) && value >= 0);
  metrics[id] = value;
  return label(x, y, value.toLocaleString('en-US'), size, color, `text-anchor="end" font-weight="600" data-metric="${id}" data-value="${value}"`);
};
assert.equal(data.environment, 'dev');
assert.match(data.revision, /^[0-9a-f]{40}$/);
assert.equal(data.routing.destinations.length, 6);
assert.equal(new Set(data.routing.destinations.map((r) => r.region)).size, 6);
assert.equal(data.browser.samples_per_condition, 3);
assert.equal(data.concurrency.runs.length, 3);
let body = `<rect width="${W}" height="${H}" fill="${C.bg}"/>`;
body += '<path d="M72 50V80M72 64L94 78" fill="none" stroke="#00dc8b" stroke-width="4"/>';
body += '<g fill="#101010" stroke="#00dc8b" stroke-width="4"><circle cx="72" cy="48" r="7"/><circle cx="72" cy="82" r="5"/><circle cx="97" cy="79" r="6"/></g>';
body += label(120, 80, 'YonedaRepo', 32, C.text, 'font-weight="700"');
body += label(1512, 78, `${data.date} · DEV VALIDATION`, 22, C.muted, 'text-anchor="end"');
body += label(72, 180, 'Global routing verified on dev.', 57, C.text, 'font-weight="700"');
body += label(72, 235, 'Six API execution regions. Existing repository authority stays stable.', 28, C.muted);
for (const [i, region] of data.routing.destinations.entries()) {
  assert.equal(region.samples, 3);
  assert.match(region.colo, /^[A-Z]{3}$/);
  const x = 72 + (i % 3) * 488, y = 278 + Math.floor(i / 3) * 126;
  body += panel(x, y, 464, 103) + label(x + 24, y + 40, region.label, 27);
  body += label(x + 24, y + 77, '3 observed samples', 22, C.muted);
  body += label(x + 438, y + 75, region.colo, 38, C.green, 'text-anchor="end" font-weight="600"');
}
body += label(72, 568, 'Page loading still needs work.', 34, C.amber, 'font-weight="600"');
body += label(1512, 568, '3 browser contexts · milliseconds', 24, C.muted, 'text-anchor="end"');
body += label(72, 617, 'Readiness', 23, C.muted);
for (const [x, word] of [[1010, 'Minimum'], [1250, 'Median'], [1512, 'Maximum']])
  body += label(x, 617, word, 23, C.muted, 'text-anchor="end"');
const rows = [
  ['Overview, fresh context', data.browser.overview.cold],
  ['Overview, reload', data.browser.overview.reload],
  ['Overview, repeat', data.browser.overview.repeat],
  ['Agents cards', data.browser.agents_cards],
];
for (const [i, [name, values]] of rows.entries()) {
  assert(values.min <= values.median && values.median <= values.max);
  const y = 671 + i * 56;
  body += `<path d="M72 ${y + 19}H1512" stroke="${C.line}"/>` + label(72, y, name, 29);
  for (const [x, key] of [[1010, 'min'], [1250, 'median'], [1512, 'max']])
    body += metric(x, y, values[key], `page-${i}-${key}`);
}
body += label(72, 924, 'Three independent 1,000-writer runs', 34, C.text, 'font-weight="600"');
for (const [i, [key, name]] of [['commits_ok', 'Commits accepted'], ['landings_ok', 'Landings accepted'], ['readbacks_correct', 'Correct readbacks']].entries()) {
  const total = data.concurrency.runs.reduce((sum, r) => sum + r[key], 0);
  for (const run of data.concurrency.runs) assert.equal(run.writers, 1000);
  const x = 72 + i * 488;
  body += panel(x, 955, 464, 136) + metric(x + 438, 1023, total, key, total === 3000 ? C.green : C.amber, 49);
  body += label(x + 24, 1064, name, 25);
}
const cleanup = data.concurrency.temporary_writer_tokens_revoked;
body += label(72, 1140, cleanup ? 'Dedicated fixtures retained. Temporary writer tokens revoked.' : 'Temporary token cleanup requires attention.', 26, cleanup ? C.green : C.amber);
body += label(72, 1184, `Observed client: ${data.client.country}. No external Asia-client or production acceptance.`, 25, C.muted);
body += label(72, 1222, `Dev ${data.revision.slice(0, 8)} · full timings and limits in the accompanying JSON and report.`, 23, C.muted);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc"><title id="title">Global routing verified on dev; page speed remains open</title><desc id="desc">Six API execution locations, current browser loading ranges, and three separate thousand-writer correctness runs. No controlled comparison or worldwide performance claim.</desc><style>text{font-family:Arial,Helvetica,sans-serif;font-variant-numeric:tabular-nums}</style>${body}</svg>\n`;
const svgFile = path.join(output, 'global-routing-validation.svg');
const pngFile = path.join(output, 'global-routing-validation.png');
if (check) assert.equal(await readFile(svgFile, 'utf8'), svg);
else { await mkdir(output, { recursive: true }); await writeFile(svgFile, svg); }
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><body style="margin:0">${svg}</body>`);
  await page.evaluate(() => document.fonts.ready);
  const actual = await page.evaluate(() => ({
    metrics: Object.fromEntries([...document.querySelectorAll('[data-metric]')].map((el) => [el.dataset.metric, Number(el.dataset.value)])),
    overflow: [...document.querySelectorAll('text')].filter((el) => { const b = el.getBBox(); return b.x < 0 || b.y < 0 || b.x + b.width > 1600 || b.y + b.height > 1250; }).map((el) => el.textContent),
  }));
  assert.deepEqual(actual.metrics, metrics); assert.deepEqual(actual.overflow, []);
  for (const [key, value] of Object.entries(metrics))
    assert.equal(await page.locator(`[data-metric="${key}"]`).textContent(), value.toLocaleString('en-US'));
  if (!check) await page.screenshot({ path: pngFile });
  const png = await readFile(pngFile);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), W); assert.equal(png.readUInt32BE(20), H);
} finally { await browser.close(); }
console.log(check ? 'Dated global routing figure verified.' : 'Dated global routing figure rendered.');
