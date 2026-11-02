// Comparing arms of an agent test: descriptive numbers per arm, Fisher's exact test on a 2x2
// table, and a sign test over paired blocks. Restored from the proof harness deleted in
// 34a63b3a; no claim from fewer than 3 samples per arm, and 3 per arm can never reach
// significance on Fisher's test.

const middle = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const at = sorted.length >> 1;
  return sorted.length % 2 ? sorted[at] : (sorted[at - 1] + sorted[at]) / 2;
};

export function armSummary(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  const n = xs.length;
  if (!n) return { n: 0, mean: null, median: null, sd: null, min: null, max: null, note: 'no samples' };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null;
  return { n, mean, median: middle(xs), sd, min: Math.min(...xs), max: Math.max(...xs), note: n < 3 ? 'n<3: no claim' : null };
}

/** Arm A against arm B: the ratio of means and whether the observed ranges overlap. */
export function compareArms(a, b) {
  const [sa, sb] = [armSummary(a), armSummary(b)];
  const ratio = sa.mean != null && sb.mean ? sa.mean / sb.mean : null;
  const overlap = sa.n && sb.n ? sa.min <= sb.max && sb.min <= sa.max : null;
  const claim = sa.n < 3 || sb.n < 3 ? 'n<3 in an arm: no claim' : overlap ? 'ranges overlap: no difference shown' : 'ranges separate (descriptive, not a significance test)';
  return { a: sa, b: sb, ratio, overlap, claim };
}

const logFactorial = (n) => {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
};

/** Two-sided Fisher exact p for the 2x2 table [[a, b], [c, d]]. */
export function fisherExact(a, b, c, d) {
  const [r1, r2, c1, n] = [a + b, c + d, a + c, a + b + c + d];
  const p = (x) => Math.exp(logFactorial(r1) + logFactorial(r2) + logFactorial(c1) + logFactorial(n - c1) - logFactorial(n) - logFactorial(x) - logFactorial(r1 - x) - logFactorial(c1 - x) - logFactorial(r2 - c1 + x));
  const observed = p(a);
  let total = 0;
  for (let x = Math.max(0, c1 - r2); x <= Math.min(r1, c1); x++) if (p(x) <= observed * (1 + 1e-9)) total += p(x);
  return Math.min(1, total);
}

/** Two-sided sign test: the chance of a split at least this uneven if neither side is favoured.
 * Ties are left out before it. 5 blocks can't go below 0.0625; 6 need 6 of 6, 9 need 8 of 9. */
export function signTest(lower, higher) {
  const n = lower + higher;
  let choose = 1;
  let tail = 0;
  for (let i = 0; i <= Math.min(lower, higher); i++) {
    tail += choose;
    choose = (choose * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

/** Paired blocks `[[a, b], ...]`, same trap at the same time: how often `a` came out below `b`,
 * the median of a/b per block, and the sign test. This cancels what differs between traps. */
export function pairedBlocks(pairs) {
  const both = pairs.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const lower = both.filter(([a, b]) => a < b).length;
  const higher = both.filter(([a, b]) => a > b).length;
  const ratios = both.filter(([, b]) => b > 0).map(([a, b]) => a / b);
  return { n: both.length, lower, higher, ties: both.length - lower - higher, median_ratio: ratios.length ? middle(ratios) : null, sign_p: signTest(lower, higher) };
}
