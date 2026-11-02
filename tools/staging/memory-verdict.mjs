// The memory test's result from its run records (memory-plan.mjs): trap avoided by Fisher's test
// first, per trap so one lucky guess can't decide it, then tokens, time, reading and landing
// success, min, median and max per arm and paired by block; what reached each arm; and the
// results section of docs/landings-plan.md. Pure, unit-tested in tests/runtime/memory-test.test.mjs.
import { armSummary, fisherExact, pairedBlocks } from './arm-stats.mjs';
import { ARMS, MIN_RUNS } from './memory-plan.mjs';

const SIGNIFICANT = 0.05;
export const RESULTS_START = '<!-- memory-test-results:start -->';
export const RESULTS_END = '<!-- memory-test-results:end -->';

/** Reading is judged on `read_bytes`: what the agent took in, whichever tool brought it. */
const MEASURES = ['tokens', 'fresh_tokens', 'ms', 'files_read', 'whole_file_reads', 'read_bytes', 'tool_calls'];
const PAIRS = [['memory', 'context'], ['memory', 'plain'], ['context', 'plain']];

const tally = (list, ok) => ({ n: list.length, yes: list.filter(ok).length });
const rate = (t) => (t.n ? t.yes / t.n : 0);
const pair = (a, b) => fisherExact(a.yes, a.n - a.yes, b.yes, b.n - b.yes);
const perArm = (make) => Object.fromEntries(ARMS.map((arm) => [arm, make(arm)]));
const perPair = (make) => Object.fromEntries(PAIRS.map(([a, b]) => [`${a}_${b}`, make(a, b)]));

/** Whether arm a's `key` came out below arm b's over the blocks where both are valid. */
function blocks(valid, a, b, key) {
  const value = (arm, round) => valid.find((r) => r.arm === arm && r.round === round)?.[key];
  return pairedBlocks([...new Set(valid.map((r) => r.round))].map((round) => [value(a, round), value(b, round)]));
}

/** A claim from a paired measure: the sign test decides, and the size is reported with it. */
function pairedClaim(what, p, min) {
  if (p.n < min) return `no answer: ${p.n} paired blocks, ${min} are needed`;
  const ratio = p.median_ratio == null ? 'no ratio' : `median ${p.median_ratio.toFixed(2)}`;
  const split = `${p.lower} lower, ${p.higher} higher, ${p.ties} tied, ${ratio}, sign test p = ${p.sign_p.toFixed(4)}`;
  if (p.sign_p >= SIGNIFICANT) return `no difference shown in ${what} (${split})`;
  return `${p.lower > p.higher ? 'less' : 'more'} ${what} (${split})`;
}

/** What reached one arm's sessions, over every run it made, valid or not: a memory that isn't
 * delivered makes a run invalid here but is a real product gap, so it stays visible. */
function deliveredTo(ran) {
  const items = {};
  for (const r of ran) for (const [type, n] of Object.entries(r.shown?.by_type ?? {})) items[type] = (items[type] ?? 0) + n;
  return { context: tally(ran, (r) => r.shown?.start), trap: tally(ran, (r) => r.shown?.trap || r.hook?.rule_seen), memories: armSummary(ran.map((r) => r.shown?.memories?.length ?? 0)), bytes: armSummary(ran.map((r) => r.shown?.bytes ?? 0)), items };
}

/**
 * The result of `records` (each `{ trap, arm, round, valid, oracle: { outcome }, landed, shown,
 * hook, ...MEASURES }`). Only valid runs count, except for `delivered`. `answer` is memory on
 * top of context, the one comparison that differs by the trap memory alone. `context_answer`
 * is what context does for the trap with no memory of it, and `reading` and `tokens` whether
 * context changes what an agent takes in and spends.
 */
export function verdict(records, { min = MIN_RUNS } = {}) {
  const valid = records.filter((r) => r.valid);
  const of = (arm) => valid.filter((r) => r.arm === arm);
  const isAvoided = (r) => r.oracle.outcome === 'avoided';
  const avoided = perArm((arm) => tally(of(arm), isAvoided));
  const fisher = perPair((a, b) => pair(avoided[a], avoided[b]));
  const traps = [...new Set(records.map((r) => r.trap))].map((trap) => ({ trap, ...perArm((arm) => tally(of(arm).filter((r) => r.trap === trap), isAvoided)) }));
  const better = traps.filter((t) => t.memory.n && t.context.n && rate(t.memory) > rate(t.context)).length;
  const landing = perArm((arm) => tally(of(arm), (r) => r.landed));
  const paired = perPair((a, b) => Object.fromEntries(MEASURES.map((key) => [key, blocks(valid, a, b, key)])));
  const short = ARMS.some((arm) => avoided[arm].n < min);
  const answer = short
    ? `no answer: ${avoided.memory.n} memory, ${avoided.context.n} context and ${avoided.plain.n} plain runs were valid, ${min} per arm are needed`
    : fisher.memory_context >= SIGNIFICANT
      ? 'no difference shown: fix this before building Instruments on memory'
      : rate(avoided.memory) < rate(avoided.context)
        ? 'memory did worse'
        : better < 2
          ? 'no claim: one trap decided it'
          : 'memory helped';
  const contextAnswer = short ? 'no answer' : fisher.context_plain >= SIGNIFICANT ? 'context alone made no difference to the trap' : rate(avoided.context) > rate(avoided.plain) ? 'context alone avoided the trap more often: look for a leak' : 'context alone did worse on the trap';
  return {
    answer,
    context_answer: contextAnswer,
    reading: pairedClaim('reading', paired.context_plain.read_bytes, min),
    tokens: pairedClaim('tokens', paired.context_plain.tokens, min),
    fisher_p: fisher.memory_context,
    fisher,
    avoided,
    traps,
    too_easy: traps.filter((t) => t.plain.yes > 0 || t.context.yes > 0).map((t) => t.trap),
    delivered: perArm((arm) => deliveredTo(records.filter((r) => r.arm === arm))),
    invalid: perArm((arm) => records.filter((r) => r.arm === arm && !r.valid).length),
    measures: perArm((arm) => Object.fromEntries(MEASURES.map((key) => [key, armSummary(of(arm).map((r) => r[key]))]))),
    paired,
    landing: { ...landing, fisher_p: pair(landing.memory, landing.plain) },
  };
}

const count = (t) => `${t.yes}/${t.n}`;
const number = (x) => (x == null ? '-' : Math.round(x).toLocaleString('en-US'));
const spread = (s) => `${number(s.median)} (${number(s.min)}-${number(s.max)})`;
const types = (items) => Object.entries(items).map(([type, n]) => `${type} ${n}`).join(', ') || 'none';
const MEASURE_ROWS = [['Tokens', 'tokens'], ['Tokens without cache reads', 'fresh_tokens'], ['Time, ms', 'ms'], ['Files read', 'files_read'], ['Whole-file reads', 'whole_file_reads'], ['Bytes read', 'read_bytes'], ['Tool calls', 'tool_calls']];

/** One paired row: arm a against arm b per block. */
const pairedRow = (label, p) => `| ${label} | ${p.lower} / ${p.higher} / ${p.ties} | ${p.median_ratio == null ? '-' : p.median_ratio.toFixed(2)} | ${p.sign_p.toFixed(4)} |`;

/** The results section's text for verdict `v`. */
export function resultsMarkdown(v, { recorded_at, model, evidence, commit }) {
  const a = v.avoided;
  const d = v.delivered;
  return [
    `Run ${recorded_at} on \`${commit}\`, \`${model}\`. Evidence: \`${evidence}\`.`,
    '',
    `**Answer: ${v.answer}.** Trap avoided: memory ${count(a.memory)}, context ${count(a.context)}, plain ${count(a.plain)}. Fisher p: memory vs context ${v.fisher.memory_context.toFixed(4)}, memory vs plain ${v.fisher.memory_plain.toFixed(4)}, context vs plain ${v.fisher.context_plain.toFixed(4)}.`,
    '',
    `**Context against plain:** ${v.context_answer}. Reading: ${v.reading}. Tokens: ${v.tokens}.`,
    '',
    '| Trap | Memory avoided | Context avoided | Plain avoided |',
    '|---|---|---|---|',
    ...v.traps.map((t) => `| ${t.trap} | ${count(t.memory)} | ${count(t.context)} | ${count(t.plain)} |`),
    '',
    '| Measure, median (min-max) | Memory | Context | Plain |',
    '|---|---|---|---|',
    ...MEASURE_ROWS.map(([label, key]) => `| ${label} | ${spread(v.measures.memory[key])} | ${spread(v.measures.context[key])} | ${spread(v.measures.plain[key])} |`),
    '',
    '| Context against plain, per block | Lower / higher / tied | Median ratio | Sign test p |',
    '|---|---|---|---|',
    ...MEASURE_ROWS.map(([label, key]) => pairedRow(label, v.paired.context_plain[key])),
    '',
    '| Delivered | Memory | Context | Plain |',
    '|---|---|---|---|',
    `| Start context | ${count(d.memory.context)} | ${count(d.context.context)} | ${count(d.plain.context)} |`,
    `| Trap memory | ${count(d.memory.trap)} | ${count(d.context.trap)} | ${count(d.plain.trap)} |`,
    `| Memories shown, median (min-max) | ${spread(d.memory.memories)} | ${spread(d.context.memories)} | ${spread(d.plain.memories)} |`,
    `| Context bytes, median (min-max) | ${spread(d.memory.bytes)} | ${spread(d.context.bytes)} | ${spread(d.plain.bytes)} |`,
    `| Items by type | ${types(d.memory.items)} | ${types(d.context.items)} | ${types(d.plain.items)} |`,
    '',
    `Landing success: memory ${count(v.landing.memory)}, context ${count(v.landing.context)}, plain ${count(v.landing.plain)}. Invalid runs: ${v.invalid.memory} memory, ${v.invalid.context} context, ${v.invalid.plain} plain.`,
    ...(v.too_easy.length ? [`A run without the trap memory avoided these traps, so they can be guessed: ${v.too_easy.join(', ')}.`] : []),
  ].join('\n');
}

/** `doc` with the text between the results markers replaced by `markdown`. */
export function fillResults(doc, markdown) {
  const [start, end] = [doc.indexOf(RESULTS_START), doc.indexOf(RESULTS_END)];
  if (start < 0 || end < start) throw new Error('the results markers are missing from docs/landings-plan.md');
  return `${doc.slice(0, start + RESULTS_START.length)}\n${markdown}\n${doc.slice(end)}`;
}
