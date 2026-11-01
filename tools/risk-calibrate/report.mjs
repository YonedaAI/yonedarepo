#!/usr/bin/env node
// Reads walk.mjs output and answers: what share each band takes, and how well each cut finds
// landings that were later reverted or fixed, overall, per repository and held out.
//   node tools/risk-calibrate/report.mjs [--medium N --high N] <out.jsonl>...
import { readFileSync } from 'node:fs';
import { FIX_DAYS, REVERT_DAYS } from './labels.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return fallback;
  return Number(args.splice(at, 2)[1]);
};
const medium = flag('medium', 25);
const high = flag('high', 55);
const rows = args.flatMap((file) =>
  readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
);
const pct = (n) => `${(100 * n).toFixed(1)}%`;
const repos = [...new Set(rows.map((r) => r.repo))];

/** The label window must have closed: a landing too new has had no time to be undone. */
const labelled = {
  reverted: (r) => r.age_days >= REVERT_DAYS,
  fixed: (r) => r.age_days >= FIX_DAYS,
};
const hit = {
  reverted: (r) => r.reverted !== null && r.reverted.days <= REVERT_DAYS,
  fixed: (r) => r.fixed !== null,
};

/** Area under the ROC curve: the chance a labelled landing outranks an unlabelled one. */
function auc(list, value, positive) {
  const ranks = new Map();
  for (const r of list) {
    const v = value(r);
    const entry = ranks.get(v) ?? { pos: 0, neg: 0 };
    entry[positive(r) ? 'pos' : 'neg'] += 1;
    ranks.set(v, entry);
  }
  let below = 0;
  let wins = 0;
  for (const v of [...ranks.keys()].sort((a, b) => a - b)) {
    const { pos, neg } = ranks.get(v);
    wins += pos * (below + neg / 2);
    below += neg;
  }
  const pos = list.filter(positive).length;
  return pos && below ? wins / (pos * below) : Number.NaN;
}

function cut(list, threshold, positive) {
  const fired = list.filter((r) => r.score >= threshold);
  const caught = fired.filter(positive).length;
  const all = list.filter(positive).length;
  const rate = all / list.length;
  const precision = fired.length ? caught / fired.length : 0;
  return {
    share: fired.length / list.length,
    recall: all ? caught / all : 0,
    precision,
    lift: rate ? precision / rate : 0,
    fired: fired.length,
    caught,
  };
}

/** A 90% interval on `measure`, resampling whole repositories, the unit that really varies. */
function interval(list, measure, rounds = 2000) {
  const byRepo = repos.map((name) => list.filter((r) => r.repo === name));
  let seed = 7;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const values = [];
  for (let i = 0; i < rounds; i += 1) {
    const sample = byRepo.flatMap(() => byRepo[Math.floor(random() * byRepo.length)]);
    const value = measure(sample);
    if (Number.isFinite(value)) values.push(value);
  }
  values.sort((a, b) => a - b);
  return [values[Math.floor(0.05 * values.length)], values[Math.floor(0.95 * values.length)]];
}

const logLines = (r) => Math.log1p(r.lines);
for (const label of ['reverted', 'fixed']) {
  const list = rows.filter(labelled[label]);
  const positive = hit[label];
  const total = list.filter(positive).length;
  console.log(`\n== ${label}: ${total} of ${list.length} (${pct(total / list.length)})`);
  const [low, up] = interval(list, (s) => auc(s, (r) => r.score, positive));
  console.log(`AUC score ${auc(list, (r) => r.score, positive).toFixed(3)} (90% ${low.toFixed(3)}-${up.toFixed(3)})`
    + `  lines alone ${auc(list, logLines, positive).toFixed(3)}`);
  console.log('cut  landings  caught  precision  lift');
  for (const t of [25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80]) {
    const c = cut(list, t, positive);
    console.log(`${String(t).padStart(3)}  ${pct(c.share).padStart(7)}  ${pct(c.recall).padStart(6)}`
      + `  ${pct(c.precision).padStart(7)}  ${c.lift.toFixed(2)}`);
  }
  console.log('repository: rate, AUC, and High (share, caught, precision, lift)');
  for (const repo of repos) {
    const own = list.filter((r) => r.repo === repo);
    const c = cut(own, high, positive);
    const a = auc(own, (r) => r.score, positive);
    console.log(`${repo.padEnd(28)} ${String(own.filter(positive).length).padStart(4)}/${String(own.length).padEnd(5)}`
      + ` ${pct(own.filter(positive).length / own.length).padStart(6)}  AUC ${a.toFixed(3)}`
      + `  High ${pct(c.share).padStart(5)} caught ${pct(c.recall).padStart(6)} prec ${pct(c.precision).padStart(6)} lift ${c.lift.toFixed(2)}`);
  }
  const lift = cut(list, high, positive);
  const [a, b] = interval(list, (s) => cut(s, high, positive).lift);
  console.log(`High from ${high}: ${pct(lift.share)} of landings, caught ${lift.caught}/${total} (${pct(lift.recall)}),`
    + ` ${lift.fired - lift.caught} of ${lift.fired} fired on landings without the label; lift ${lift.lift.toFixed(2)} (90% ${a.toFixed(2)}-${b.toFixed(2)})`);
}

console.log(`\n== bands: Low below ${medium}, High from ${high}, ${rows.length} landings`);
const band = (r) => (r.score >= high ? 'High' : r.score >= medium ? 'Medium' : 'Low');
for (const name of ['Low', 'Medium', 'High']) {
  const own = rows.filter((r) => band(r) === name);
  const revert = own.filter(labelled.reverted);
  const fix = own.filter(labelled.fixed);
  console.log(`${name.padEnd(7)} ${pct(own.length / rows.length).padStart(6)}`
    + `  reverted ${revert.filter(hit.reverted).length}/${revert.length} (${pct(revert.filter(hit.reverted).length / revert.length)})`
    + `  fixed ${fix.filter(hit.fixed).length}/${fix.length} (${pct(fix.filter(hit.fixed).length / fix.length)})`);
}

console.log('\n== per input, rate of each label when the input adds points against when it adds none');
for (const input of ['classes', 'size', 'sensitive']) {
  for (const label of ['reverted', 'fixed']) {
    const list = rows.filter(labelled[label]);
    const floor = input === 'classes' ? 15 : 0;
    const on = list.filter((r) => r.points[input] > floor);
    const off = list.filter((r) => r.points[input] <= floor);
    const rate = (l) => l.filter(hit[label]).length / l.length;
    console.log(`${input.padEnd(10)} ${label.padEnd(9)} above ${floor}: ${pct(rate(on))} of ${on.length}; at or below: ${pct(rate(off))} of ${off.length}`);
  }
}

/** AUC comparing only pairs in the same stratum, so what defines a stratum can't explain it. */
function stratified(list, value, positive, stratum) {
  const groups = Map.groupBy(list, stratum);
  let wins = 0;
  let pairs = 0;
  for (const group of groups.values()) {
    const pos = group.filter(positive).length;
    const neg = group.length - pos;
    if (!pos || !neg) continue;
    wins += auc(group, value, positive) * pos * neg;
    pairs += pos * neg;
  }
  return wins / pairs;
}

/** The score less its size points: review class and sensitive paths. */
const notSize = (r) => r.points.classes + r.points.sensitive;
const inRepo = (r) => r.repo;
const inRepoAndSize = (r) => `${r.repo}:${r.points.size}`;

console.log('\n== signal within a repository, and within a repository and size band');
for (const label of ['reverted', 'fixed']) {
  const list = rows.filter(labelled[label]);
  const positive = hit[label];
  const show = (name, value, stratum) => {
    const [a, b] = interval(list, (s) => stratified(s, value, positive, stratum), 500);
    console.log(`${label.padEnd(9)} ${name.padEnd(36)} ${stratified(list, value, positive, stratum).toFixed(3)} (90% ${a.toFixed(3)}-${b.toFixed(3)})`);
  };
  show('score, same repo', (r) => r.score, inRepo);
  show('lines alone, same repo', logLines, inRepo);
  show('class + sensitive, same repo', notSize, inRepo);
  show('class + sensitive, same repo and size', notSize, inRepoAndSize);
}

console.log('\n== lift of each cut with a 90% interval, whole repositories resampled');
for (const label of ['reverted', 'fixed']) {
  const list = rows.filter(labelled[label]);
  for (const t of [40, 45, 50, 55, 60, 65, 70]) {
    const c = cut(list, t, hit[label]);
    const [a, b] = interval(list, (s) => cut(s, t, hit[label]).lift, 500);
    console.log(`${label.padEnd(9)} from ${t}: ${pct(c.share).padStart(5)} held, ${String(c.caught).padStart(3)} of ${String(c.fired).padEnd(4)} labelled, lift ${c.lift.toFixed(2)} (90% ${a.toFixed(2)}-${b.toFixed(2)})`);
  }
}

console.log('\n== held out: the cut holding at most 3% of the other repositories, read on this one');
for (const repo of repos) {
  const others = rows.filter((r) => r.repo !== repo);
  let chosen = 100;
  for (let t = 100; t >= 0; t -= 5) {
    if (others.filter((r) => r.score >= t).length / others.length <= 0.03) chosen = t;
  }
  const parts = ['reverted', 'fixed'].map((label) => {
    const own = rows.filter((r) => r.repo === repo && labelled[label](r));
    const c = cut(own, chosen, hit[label]);
    return `${label} ${c.caught}/${own.filter(hit[label]).length} lift ${c.lift.toFixed(2)}`;
  });
  const own = rows.filter((r) => r.repo === repo);
  console.log(`${repo.padEnd(28)} cut ${chosen}  holds ${pct(cut(own, chosen, () => true).share).padStart(5)}  ${parts.join('  ')}`);
}

console.log('\n== score spread');
for (const [lo, hi] of [[0, 14], [15, 24], [25, 34], [35, 44], [45, 54], [55, 64], [65, 74], [75, 100]]) {
  const own = rows.filter((r) => r.score >= lo && r.score <= hi);
  console.log(`${String(lo).padStart(3)}-${String(hi).padEnd(3)} ${pct(own.length / rows.length).padStart(6)}`);
}
