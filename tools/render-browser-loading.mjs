// A dated browser observation. This renderer makes no network or platform requests.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const arg = process.argv.indexOf('--data');
assert(arg >= 0 && process.argv[arg + 1], '--data requires a JSON path');
const source = path.resolve(process.argv[arg + 1]);
const d = JSON.parse(await readFile(source, 'utf8'));
const out = path.dirname(source), check = process.argv.includes('--check');
const W = 1600, H = 1400;
const C = { bg: '#101010', panel: '#1b1b1b', line: '#3b3b3b', text: '#f5f5f5', muted: '#b9b9b9', green: '#00dc8b', amber: '#edbc5d' };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const label = (x, y, s, size = 27, color = C.text, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${extra}>${esc(s)}</text>`;
const panel = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${C.panel}" stroke="${C.line}"/>`;
const metrics = {};
const metric = (x, y, value, id, color = C.text, size = 32) => {
  assert(Number.isFinite(value) && value >= 0);
  metrics[id] = value;
  return label(x, y, value.toLocaleString('en-US'), size, color, `text-anchor="end" font-weight="600" data-metric="${id}" data-value="${value}"`);
};
const row = (cohort, page, mode, metricName) => {
  const r = cohort.rows.find(r => r.page === page && r.mode === mode && r.metric === metricName);
  assert(r && r.n === 3 && r.min <= r.median && r.median <= r.max);
  assert.equal(r.values.length, 3);
  return r;
};
const nav = (cohort, from) => cohort.rows.find(r => r.from === from && r.target === 'overview' && r.metric === 'core');
assert.equal(d.environment, 'dev');
assert.equal(d.conditions.samples_per_condition, 3);
assert.equal(d.conditions.writer_or_load_tests, false);
assert.equal(d.navigation.same_main_across_cohorts, true);
const before = d.documents.baseline, after = d.documents.current;
const fresh = row(after, 'overview', 'fresh-context', 'core');
const slowest = fresh.max;
const files = nav(d.navigation.current, 'files'), agents = nav(d.navigation.current, 'agents');
const jsReduction = Number(((1 - d.build_comparison.after.gzip / d.build_comparison.before.gzip) * 100).toFixed(1));
const imageResponses = d.navigation.current.image_responses;
assert.equal(imageResponses.length, 12);
assert(imageResponses.every(r => r.wire_status === 304));
let b = `<rect width="${W}" height="${H}" fill="${C.bg}"/>`;
b += '<path d="M72 50V80M72 64L94 78" fill="none" stroke="#00dc8b" stroke-width="4"/><g fill="#101010" stroke="#00dc8b" stroke-width="4"><circle cx="72" cy="48" r="7"/><circle cx="72" cy="82" r="5"/><circle cx="97" cy="79" r="6"/></g>';
b += label(120, 80, 'YonedaRepo', 32, C.text, 'font-weight="700"');
b += label(1512, 78, `${d.date} · DEV BROWSER LOADS`, 22, C.muted, 'text-anchor="end"');
b += label(72, 172, 'Faster repeat views.', 58, C.text, 'font-weight="700"');
b += label(72, 230, 'Fresh loading still needs work.', 42, C.amber, 'font-weight="600"');
b += label(72, 277, 'One client, one retained repository. Normal browser caches. Three runs per condition.', 25, C.muted);
for (const [i, title, value, detail] of [
  [0, 'Workspace startup JavaScript', `${jsReduction}% less`, 'Controlled gzip build comparison'],
  [1, 'Fresh Overview content', `${fresh.median} ms`, 'Header, latest commit and rich README'],
  [2, 'In-app Overview returns', `${agents.median}–${files.median} ms`, 'Medians from Agents and Files'],
]) {
  const x = 72 + i * 488;
  b += panel(x, 314, 464, 156) + label(x + 24, 354, title, 24, C.muted);
  b += label(x + 24, 411, value, 46, C.green, 'font-weight="700"');
  b += label(x + 24, 446, detail, 20, C.muted);
}
b += label(72, 532, 'Time to usable content · milliseconds', 30, C.text, 'font-weight="600"');
b += label(976, 532, 'Before', 24, C.muted, 'text-anchor="end"');
b += label(1512, 532, 'Current', 24, C.muted, 'text-anchor="end"');
const rows = [
  ['Overview · fresh', 'overview', 'fresh-context', 'core'],
  ['Overview · reload', 'overview', 'reload', 'core'],
  ['Overview · repeat document', 'overview', 'repeat-document-navigation', 'core'],
  ['Agents cards · fresh', 'agents', 'fresh-context', 'agentsCards'],
  ['Agents cards · reload', 'agents', 'reload', 'agentsCards'],
  ['Agents cards · repeat document', 'agents', 'repeat-document-navigation', 'agentsCards'],
];
for (const [i, [name, page, mode, kind]] of rows.entries()) {
  const a = row(before, page, mode, kind), z = row(after, page, mode, kind), y = 593 + i * 74;
  const color = z.median < a.median ? C.green : C.amber;
  b += `<path d="M72 ${y + 41}H1512" stroke="${C.line}"/>` + label(72, y, name, 28);
  for (const [x, end, r, id, fill] of [[610, 976, a, `before-${i}`, '#888'], [1130, 1512, z, `after-${i}`, color]]) {
    b += `<rect x="${x}" y="${y - 17}" width="${250 * r.median / 1500}" height="15" rx="3" fill="${fill}"/>`;
    b += metric(end, y, r.median, id, fill);
    b += label(end, y + 28, `${r.min.toLocaleString('en-US')}–${r.max.toLocaleString('en-US')}`, 20, C.muted, 'text-anchor="end"');
  }
}
b += label(72, 1092, 'Numbers under each median show the full minimum–maximum range.', 23, C.muted);
const fullBefore = row(before, 'overview', 'fresh-context', 'complete');
const fullAfter = row(after, 'overview', 'fresh-context', 'complete');
assert(fullAfter.median >= fullBefore.median, 'Review the optional-activity narrative for new data');
assert(fresh.median > 500, 'Review the fresh target narrative for new data');
assert(files.median < nav(d.navigation.baseline, 'files').median);
assert(agents.median < nav(d.navigation.baseline, 'agents').median);
b += label(72, 1142, `Activity and contributors, fresh: ${fullBefore.median} → ${fullAfter.median} ms. No improvement.`, 27, C.amber);
b += label(72, 1190, '12 / 12 image revalidations reused cached bodies on Overview returns.', 27, C.green);
b += label(72, 1240, `Slowest sampled fresh Overview: ${slowest.toLocaleString('en-US')} ms. Fresh 500 ms target unmet.`, 27, C.amber);
b += label(72, 1290, 'Fresh context does not force a cold backend. No worldwide or production proof.', 25, C.muted);
b += label(72, 1335, `Before ${before.frontend} · current frontend ${after.frontend} / backend ${after.backend}`, 24, C.muted);
b += label(72, 1374, 'All samples, intermediate results and limits are retained in the accompanying JSON and report.', 22, C.muted);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc"><title id="title">Dev browser loading improves, with cold and optional work still open</title><desc id="desc">Three samples per condition, before and current medians with full ranges. Fresh loading remains above its target; optional activity did not improve. No writer benchmark or global claim.</desc><style>text{font-family:Arial,Helvetica,sans-serif;font-variant-numeric:tabular-nums}</style>${b}</svg>\n`;
const svgFile = path.join(out, 'browser-loading.svg'), pngFile = path.join(out, 'browser-loading.png');
if (check) assert.equal(await readFile(svgFile, 'utf8'), svg);
else { await mkdir(out, { recursive: true }); await writeFile(svgFile, svg); }
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><body style="margin:0">${svg}</body>`);
  await page.evaluate(() => document.fonts.ready);
  const actual = await page.evaluate(() => ({
    metrics: Object.fromEntries([...document.querySelectorAll('[data-metric]')].map(n => [n.dataset.metric, Number(n.dataset.value)])),
    overflow: [...document.querySelectorAll('text')].filter(n => { const r = n.getBBox(); return r.x < 0 || r.y < 0 || r.x + r.width > 1600 || r.y + r.height > 1400; }).map(n => n.textContent),
  }));
  assert.deepEqual(actual.metrics, metrics); assert.deepEqual(actual.overflow, []);
  for (const [key, value] of Object.entries(metrics))
    assert.equal(await page.locator(`[data-metric="${key}"]`).textContent(), value.toLocaleString('en-US'));
  if (!check) await page.screenshot({ path: pngFile });
  const png = await readFile(pngFile);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), W); assert.equal(png.readUInt32BE(20), H);
} finally { await browser.close(); }
console.log(check ? 'Browser loading figure verified.' : 'Browser loading figure rendered.');
