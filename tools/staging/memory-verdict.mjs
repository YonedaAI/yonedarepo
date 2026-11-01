// The memory test's result from its run records (memory-plan.mjs): trap avoided by Fisher's
// test first, per trap so one lucky guess can't decide it, then tokens, time, whole-file reads
// and landing success; and the results section of docs/landings-plan.md. Pure, unit-tested in
// tests/runtime/memory-test.test.mjs.
import { compareArms, fisherExact } from './arm-stats.mjs';
import { ARMS, MIN_RUNS } from './memory-plan.mjs';

const SIGNIFICANT = 0.05;
export const RESULTS_START = '<!-- memory-test-results:start -->';
export const RESULTS_END = '<!-- memory-test-results:end -->';

const tally = (list, ok) => ({ n: list.length, yes: list.filter(ok).length });
const rate = (t) => (t.n ? t.yes / t.n : 0);
const pair = (a, b) => fisherExact(a.yes, a.n - a.yes, b.yes, b.n - b.yes);

/**
 * The result of `records` (each `{ trap, arm, valid, oracle: { outcome }, landed, tokens, ms,
 * whole_file_reads }`). Only valid runs count; `delivered` shows how often the memory reached
 * the agent at all, since a memory that isn't delivered is invalid here but a real product gap.
 */
export function verdict(records, { min = MIN_RUNS } = {}) {
  const valid = records.filter((r) => r.valid);
  const of = (arm) => valid.filter((r) => r.arm === arm);
  const avoided = (r) => r.oracle.outcome === 'avoided';
  const [memory, plain] = [tally(of('memory'), avoided), tally(of('plain'), avoided)];
  const p = pair(memory, plain);
  const traps = [...new Set(records.map((r) => r.trap))].map((trap) => {
    const on = (arm) => tally(of(arm).filter((r) => r.trap === trap), avoided);
    return { trap, memory: on('memory'), plain: on('plain') };
  });
  const better = traps.filter((t) => t.memory.n && t.plain.n && rate(t.memory) > rate(t.plain)).length;
  const measure = (key) => compareArms(of('memory').map((r) => r[key]), of('plain').map((r) => r[key]));
  const landing = { memory: tally(of('memory'), (r) => r.landed), plain: tally(of('plain'), (r) => r.landed) };
  const ranMemory = records.filter((r) => r.arm === 'memory');
  const answer =
    memory.n < min || plain.n < min
      ? `no answer: ${memory.n} memory and ${plain.n} plain runs were valid, ${min} per arm are needed`
      : p >= SIGNIFICANT
        ? 'no difference shown: fix this before building Instruments on memory'
        : rate(memory) < rate(plain)
          ? 'memory did worse'
          : better < 2
            ? 'no claim: one trap decided it'
            : 'memory helped';
  return {
    answer,
    fisher_p: p,
    avoided: { memory, plain },
    traps,
    too_easy: traps.filter((t) => t.plain.yes > 0).map((t) => t.trap),
    delivered: tally(ranMemory, (r) => r.delivery?.delivered),
    invalid: Object.fromEntries(ARMS.map((arm) => [arm, records.filter((r) => r.arm === arm && !r.valid).length])),
    tokens: measure('tokens'),
    ms: measure('ms'),
    whole_file_reads: measure('whole_file_reads'),
    landing: { ...landing, fisher_p: pair(landing.memory, landing.plain) },
  };
}

const count = (t) => `${t.yes}/${t.n}`;
const number = (x) => (x == null ? '-' : Math.round(x).toLocaleString('en-US'));
const row = (label, c) => `| ${label} | ${number(c.a.mean)} (${number(c.a.min)}-${number(c.a.max)}) | ${number(c.b.mean)} (${number(c.b.min)}-${number(c.b.max)}) | ${c.ratio == null ? '-' : c.ratio.toFixed(2)} | ${c.claim} |`;

/** The results section's text for verdict `v`. */
export function resultsMarkdown(v, { recorded_at, model, evidence, commit }) {
  return [
    `Run ${recorded_at} on \`${commit}\`, \`${model}\`. Evidence: \`${evidence}\`.`,
    '',
    `**Answer: ${v.answer}.** Trap avoided: memory ${count(v.avoided.memory)}, plain ${count(v.avoided.plain)}, Fisher p = ${v.fisher_p.toFixed(4)}.`,
    '',
    '| Trap | Memory avoided | Plain avoided |',
    '|---|---|---|',
    ...v.traps.map((t) => `| ${t.trap} | ${count(t.memory)} | ${count(t.plain)} |`),
    '',
    '| Measure | Memory, mean (range) | Plain, mean (range) | Memory / plain | Claim |',
    '|---|---|---|---|---|',
    row('Tokens', v.tokens),
    row('Time, ms', v.ms),
    row('Whole-file reads', v.whole_file_reads),
    '',
    `Landing success: memory ${count(v.landing.memory)}, plain ${count(v.landing.plain)}, Fisher p = ${v.landing.fisher_p.toFixed(4)}.`,
    `Trap memory delivered in ${count(v.delivered)} memory runs. Invalid runs: ${v.invalid.memory} memory, ${v.invalid.plain} plain.`,
    ...(v.too_easy.length ? [`A plain run avoided these traps, so they can be guessed: ${v.too_easy.join(', ')}.`] : []),
  ].join('\n');
}

/** `doc` with the text between the results markers replaced by `markdown`. */
export function fillResults(doc, markdown) {
  const [start, end] = [doc.indexOf(RESULTS_START), doc.indexOf(RESULTS_END)];
  if (start < 0 || end < start) throw new Error('the results markers are missing from docs/landings-plan.md');
  return `${doc.slice(0, start + RESULTS_START.length)}\n${markdown}\n${doc.slice(end)}`;
}
