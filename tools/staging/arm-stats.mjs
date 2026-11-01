// Comparing two arms of an agent test: descriptive numbers per arm, and Fisher's exact test on
// a 2x2 table. Restored from the proof harness deleted in 34a63b3a; no claim from fewer than 3
// samples per arm, and 3 per arm can never reach significance on Fisher's test.

export function armSummary(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  const n = xs.length;
  if (!n) return { n: 0, mean: null, sd: null, min: null, max: null, note: 'no samples' };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null;
  return { n, mean, sd, min: Math.min(...xs), max: Math.max(...xs), note: n < 3 ? 'n<3: no claim' : null };
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
