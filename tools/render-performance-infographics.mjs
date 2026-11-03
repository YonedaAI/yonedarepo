// Deterministic benchmark figures: SVG is the editable source, Chrome renders PNG.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'docs/performance');
const data = JSON.parse(await readFile(path.join(out, 'dev-performance-data.json'), 'utf8'));
const check = process.argv.includes('--check');
const previewAt = process.argv.indexOf('--preview-dir');
const preview = previewAt < 0 ? null : path.resolve(root, process.argv[previewAt + 1]);
const W = 1600, H = 1200;
const C = { bg: '#101010', panel: '#1b1b1b', line: '#3b3b3b', text: '#f5f5f5', muted: '#b9b9b9', green: '#00dc8b', amber: '#edbc5d', gray: '#858585' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const number = (n) => n.toLocaleString('en-US');
const text = (x, y, s, size = 26, color = C.text, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${extra}>${esc(s)}</text>`;
const rect = (x, y, w, h, fill = C.panel, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`;
const line = (x1, y1, x2, y2) => `<path d="M${x1} ${y1}H${x2}V${y2}" fill="none" stroke="${C.line}"/>`;
const panel = (x, y, w, h) => rect(x, y, w, h, C.panel, `rx="12" stroke="${C.line}"`);
const metric = (x, y, value, id, color = C.text, size = 30) => text(x, y, number(value), size, color, `text-anchor="end" font-weight="600" data-metric="${id}" data-value="${value}"`);
function frame(title, subtitle, body, description) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
<title id="title">${esc(title)}</title><desc id="desc">${esc(description)}</desc>
<style>text{font-family:Arial,Helvetica,sans-serif;font-variant-numeric:tabular-nums}</style>
${rect(0, 0, W, H, C.bg)}
<path d="M72 50V80M72 64L94 78" fill="none" stroke="${C.green}" stroke-width="4"/>
<g fill="${C.bg}" stroke="${C.green}" stroke-width="4"><circle cx="72" cy="48" r="7"/><circle cx="72" cy="82" r="5"/><circle cx="97" cy="79" r="6"/></g>
${text(120, 80, 'YonedaRepo', 32, C.text, 'font-weight="700"')}
${text(1512, 78, `${data.date} · DEV VALIDATION`, 22, C.muted, 'text-anchor="end"')}
${text(72, 178, title, 57, C.text, 'font-weight="700"')}
${text(72, 233, subtitle, 28, C.muted)}
${body}</svg>\n`;
}
const B = data.browser;
const median = (condition, kind, metricName = 'completeMs') => B[condition].overview[kind][metricName].median;

function loading() {
  const conditions = [['baseline', 'Unplaced API', C.gray], ['selected', 'Explicit regional API', C.green], ['rejected', 'Smart Placement · rejected', C.amber]];
  let body = panel(72, 278, 1440, 342) + text(96, 324, 'Repeat Overview · median milliseconds', 27);
  const metrics = {};
  for (const [i, [condition, label, color]] of conditions.entries()) {
    const value = median(condition, 'repeat'), y = 365 + i * 78;
    body += text(96, y + 13, label, 27, color);
    body += rect(550, y - 17, 900, 34, '#292929', 'rx="4"');
    body += rect(550, y - 17, value / 4000 * 900, 34, color, `rx="4" data-bar="repeat-${condition}" data-scale-max="4000"`);
    body += metric(1482, y + 12, value, `repeat-${condition}`, color);
    metrics[`repeat-${condition}`] = value;
  }
  for (const n of [0, 1000, 2000, 3000, 4000]) body += text(550 + n / 4000 * 900, 598, number(n), 21, C.muted, 'text-anchor="middle"');
  body += text(72, 675, 'Other measured paths', 32, C.text, 'font-weight="600"');
  body += text(1512, 675, 'Medians · 3 runs per condition', 24, C.muted, 'text-anchor="end"');
  body += text(72, 725, 'Readiness', 23, C.muted) + text(970, 725, 'Unplaced', 23, C.muted, 'text-anchor="end"') + text(1210, 725, 'Selected', 23, C.muted, 'text-anchor="end"') + text(1512, 725, 'Observation', 23, C.muted, 'text-anchor="end"');
  const rows = [
    ['Cold Overview', median('baseline', 'cold'), median('selected', 'cold'), 'Faster', C.green],
    ['Reload Overview', median('baseline', 'reload'), median('selected', 'reload'), 'Slower', C.amber],
    ['Repeat visible images', median('baseline', 'repeat', 'visibleImagesMs'), median('selected', 'repeat', 'visibleImagesMs'), 'Slower', C.amber],
    ['Agents cards', B.baseline.agentsCardsMs.median, B.selected.agentsCardsMs.median, 'No clear improvement', C.muted],
  ];
  for (const [i, [label, baseline, selected, finding, color]] of rows.entries()) {
    const y = 785 + 66 * i;
    body += line(72, y + 23, 1512, y + 23) + text(72, y, label, 28);
    body += metric(970, y, baseline, `row-${i}-baseline`) + metric(1210, y, selected, `row-${i}-selected`, color);
    body += text(1512, y, finding, 25, color, 'text-anchor="end"');
    metrics[`row-${i}-baseline`] = baseline; metrics[`row-${i}-selected`] = selected;
  }
  body += text(72, 1070, 'Selected API: IAD near IAD data. Smart comparison: BOM against IAD.', 26, C.muted);
  body += text(72, 1116, 'Dev only · one retained repository · no worldwide or production proof.', 26, C.muted);
  body += text(72, 1160, `Baseline ${data.revisions.baseline} · selected ${data.revisions.selected} · rejected ${data.revisions.rejected}`, 23, C.muted);
  return { name: 'dev-loading-placement', metrics, svg: frame('Keep API compute close to data.', 'Repeat Overview: 551 → 424 ms median. Other paths still need work.', body, 'Three browser runs per condition. Medians are shown; full minimum, median and maximum values are in dev-performance-data.json. Slower reload and image results are retained.') };
}

function bursts() {
  const D = data.concurrency, metrics = {};
  let body = '';
  for (const [i, [label, key]] of [['Commits accepted', 'commits_ok'], ['Landings accepted', 'landings_ok'], ['Correct readbacks', 'readbacks_correct']].entries()) {
    const x = 72 + i * 488, value = D.totals[key];
    body += panel(x, 278, 464, 185) + metric(x + 425, 365, value, key, C.green, 66) + text(x + 28, 420, label, 28);
    metrics[key] = value;
  }
  body += text(72, 503, 'Totals across three independent runs', 25, C.muted);
  body += panel(72, 540, 1440, 310) + text(96, 586, 'Client read p95', 31, C.text, 'font-weight="600"');
  body += text(1482, 586, '1,000 read samples per run · milliseconds', 24, C.muted, 'text-anchor="end"');
  for (const [i, run] of D.runs.entries()) {
    const value = run.client_read.p95_ms, y = 642 + i * 74;
    body += text(96, y + 12, `Run ${run.run} · 1,000 writers`, 27);
    body += rect(550, y - 17, 900, 34, '#292929', 'rx="4"') + rect(550, y - 17, value / 3000 * 900, 34, C.green, `rx="4" data-bar="run-${run.run}-p95" data-scale-max="3000"`);
    body += metric(1482, y + 12, value, `run-${run.run}-p95`);
    metrics[`run-${run.run}-p95`] = value;
  }
  for (const n of [0, 1000, 2000, 3000]) body += text(550 + n / 3000 * 900, 836, number(n), 21, C.muted, 'text-anchor="middle"');
  const summary = D.run_read_p95_ms;
  body += text(72, 910, `Run p95 summary: ${number(summary.min)} / ${number(summary.median)} / ${number(summary.max)} ms`, 31);
  body += text(72, 952, 'Across-run minimum / median / maximum; not a pooled p95.', 25, C.muted);
  body += text(72, 1016, 'Temporary writer tokens revoked · dedicated fixtures retained', 27, C.green);
  body += text(72, 1064, '1,000 concurrent writers per run; never 3,000 at once.', 27, C.muted);
  body += text(72, 1110, 'Read p95 exceeds one second. These tests use token clients.', 27, C.muted);
  body += text(72, 1156, 'Scope excludes real-agent, native-Git and production acceptance.', 27, C.muted);
  return { name: 'dev-concurrency-validation', metrics, svg: frame('Three bursts. Correct readbacks.', `Independent 1,000-writer token tests · dev ${data.revisions.selected}`, body, 'Three independent bursts, each with 1,000 concurrent token writers and 1,000 reads. All 3,000 commits, landings and readbacks succeeded across the runs. This does not establish subsecond latency under load or production acceptance.') };
}

assert.equal(data.environment, 'dev'); assert.equal(B.samples_per_condition, 3);
assert.equal(data.revisions.selected, 'b38706d6');
for (const condition of ['baseline', 'selected', 'rejected']) {
  const series = [...Object.values(B[condition].overview).flatMap(Object.values), B[condition].agentsCardsMs];
  for (const s of series) assert(s.min <= s.median && s.median <= s.max);
}
assert.deepEqual([median('baseline', 'repeat'), median('selected', 'repeat'), median('rejected', 'repeat')], [551, 424, 3672]);
assert.equal(data.concurrency.independent_runs, 3);
for (const r of data.concurrency.runs) for (const n of [r.writers, r.commits_ok, r.landings_ok, r.readbacks_correct, r.client_read.samples]) assert.equal(n, 1000);
for (const [key, value] of Object.entries(data.concurrency.totals)) {
  assert.equal(value, 3000); assert.equal(value, data.concurrency.runs.reduce((sum, run) => sum + run[key], 0));
}
assert.deepEqual(data.concurrency.runs.map((r) => r.client_read.p95_ms), [2796, 2644, 1732]);
assert.deepEqual(data.concurrency.run_read_p95_ms, { min: 1732, median: 2644, max: 2796 });
assert.equal(data.concurrency.temporary_writer_tokens_revoked, true);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  for (const figure of [loading(), bursts()]) {
    const svgPath = path.join(out, `${figure.name}.svg`), pngPath = path.join(out, `${figure.name}.png`);
    if (check) assert.equal(await readFile(svgPath, 'utf8'), figure.svg); else await writeFile(svgPath, figure.svg);
    await page.setContent(`<!doctype html><body style="margin:0;background:${C.bg}">${figure.svg}</body>`);
    await page.evaluate(() => document.fonts.ready);
    const inspected = await page.evaluate(() => ({
      metrics: Object.fromEntries([...document.querySelectorAll('[data-metric]')].map((el) => [el.getAttribute('data-metric'), Number(el.getAttribute('data-value'))])),
      bars: [...document.querySelectorAll('[data-bar]')].map((el) => ({ key: el.getAttribute('data-bar'), width: Number(el.getAttribute('width')), max: Number(el.getAttribute('data-scale-max')) })),
      overflow: [...document.querySelectorAll('text')].filter((el) => { const b = el.getBBox(); return b.x < 0 || b.y < 0 || b.x + b.width > 1600 || b.y + b.height > 1200; }).map((el) => el.textContent),
    }));
    assert.deepEqual(inspected.metrics, figure.metrics); assert.deepEqual(inspected.overflow, []);
    for (const bar of inspected.bars) assert.equal(bar.width, figure.metrics[bar.key] / bar.max * 900);
    for (const [key, value] of Object.entries(figure.metrics)) assert.equal(await page.locator(`[data-metric="${key}"]`).textContent(), number(value));
    if (!check) await page.screenshot({ path: pngPath });
    const png = await readFile(pngPath);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), W); assert.equal(png.readUInt32BE(20), H);
    if (preview) {
      await mkdir(preview, { recursive: true });
      const small = await browser.newPage({ viewport: { width: W / 2, height: H / 2 }, deviceScaleFactor: 1 });
      await small.setContent(`<!doctype html><body style="margin:0;background:${C.bg}"><img width="800" height="600" src="data:image/png;base64,${png.toString('base64')}"/></body>`);
      await small.locator('img').evaluate((el) => el.decode());
      await small.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await small.screenshot({ path: path.join(preview, `${figure.name}-800.png`) });
      await small.close();
    }
    console.log(`Verified ${figure.name}: exact metric text, SVG bounds, ${W}×${H} PNG`);
  }
} finally { await browser.close(); }
