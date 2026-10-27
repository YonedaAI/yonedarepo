// Pure parts of the proof flows (proof-flow.mjs): fixture repositories, their check policies
// and briefs, the one-command seed, the git_plan stage reading, outcome classes and the
// descriptive statistics. Nothing here calls the network, so tests/runtime covers it offline.
import { gzipSync } from 'node:zlib';
import { SMOKE_POLICY } from './agent-smoke.mjs';

/** A policy whose one required check is `argv`; the seed tree must pass it (gates on main). */
const policy = (version, argv) => ({
  version,
  suite: 'commands-v1',
  environment: SMOKE_POLICY.environment,
  required_checks: ['proof'],
  build: { setup: [], checks: [{ name: 'proof', argv, timeout_seconds: 20 }], static_dir: 'public' },
});

// --- Seeding: one shell command writes the fixture, so its bytes never pass through a model.

const SEED_SCRIPT =
  "const z=require('zlib'),fs=require('fs'),p=require('path');" +
  "for(const[f,c]of Object.entries(JSON.parse(z.gunzipSync(Buffer.from(process.argv[1],'base64')))))" +
  '{fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,c)}';

/** The command that writes `files` ({path: text}) in the current directory. */
export function seedCommand(files) {
  const payload = gzipSync(JSON.stringify(files)).toString('base64');
  return { argv: ['node', '-e', SEED_SCRIPT, payload], shell: `node -e "${SEED_SCRIPT}" ${payload}` };
}

/** The seed run's brief: run the command once and nothing else. */
export function seedBrief(files) {
  return {
    intent:
      'Run exactly this one shell command from the repository root, once, then stop. Do not create, ' +
      `change or delete anything else and run no other command:\n\n${seedCommand(files).shell}`,
    criteria: [`The repository holds ${Object.keys(files).length} new files written by the command`],
  };
}

/** Paths whose content differs from the fixture, given the seeded tree's `{path: {content}}`. */
export function seedMismatches(fixture, tree) {
  return Object.keys(fixture).filter((path) => tree?.[path]?.content !== fixture[path]);
}

// --- B10c / C13 P2: token use with and without the platform's read tools on one task.

const DOMAINS = ['inventory', 'shipping', 'billing', 'users', 'reports', 'notifications'];
const FUNCTIONS_PER_FILE = 40;

function filler(domain, i) {
  const name = `${domain}Rule${i}`;
  return [
    `/** ${domain} rule ${i}: scales a value and clamps it at ${i % 5}. */`,
    `function ${name}(value) {`,
    `  const scaled = value * ${(i % 7) + 2} - ${i};`,
    `  return scaled < ${i % 5} ? ${i % 5} : scaled;`,
    '}',
  ];
}

/** Six CommonJS modules of 40+ functions each; billing.js alone holds invoiceTotal. */
export function tokenFixture() {
  const files = {};
  for (const domain of DOMAINS) {
    const lines = ["'use strict';", ''];
    const names = [];
    for (let i = 0; i < FUNCTIONS_PER_FILE; i++) {
      lines.push(...filler(domain, i), '');
      names.push(`${domain}Rule${i}`);
      if (domain === 'billing' && i === FUNCTIONS_PER_FILE / 2) {
        lines.push('/** The sum of price * qty over the items. */', 'function invoiceTotal(items) {', '  return items.reduce((sum, item) => sum + item.price * item.qty, 0);', '}', '');
        names.push('invoiceTotal');
      }
      if (domain === 'reports' && i === 10) {
        // A decoy: a search for "invoice" finds this too.
        lines.push('/** A one-line summary of an invoice for the monthly report. */', 'function invoiceSummary(items) {', '  return `${items.length} items`;', '}', '');
        names.push('invoiceSummary');
      }
    }
    lines.push(`module.exports = { ${names.join(', ')} };`, '');
    files[`src/${domain}.js`] = lines.join('\n');
  }
  return files;
}

/** Passes at the seed (no invoiceTotalWithTax yet); a present one must be right and unique. */
export const TOKEN_POLICY = policy('proof-tokens-v1', [
  'node',
  '-e',
  "const fs=require('fs');let n=0;for(const f of fs.readdirSync('src')){const m=require('./src/'+f);" +
    "if(typeof m.invoiceTotalWithTax==='function'){n++;if(m.invoiceTotalWithTax([{price:10,qty:2}],0.075)!==21.5)process.exit(1)}}" +
    "if(n>1||require('./src/billing.js').invoiceTotal([{price:3,qty:3}])!==9)process.exit(1)",
]);

export const TOKEN_BRIEF = {
  intent:
    'Add an exported function invoiceTotalWithTax(items, rate) in the same file as the existing ' +
    'invoiceTotal function. It returns invoiceTotal(items) * (1 + rate) rounded to 2 decimal places ' +
    '(Math.round(x * 100) / 100). Change no other function and no other file.',
  criteria: ['invoiceTotalWithTax is exported next to invoiceTotal', 'No other function or file changes'],
};

/** The tools arm's extra paragraph: the platform's server-side reads through the `yoneda` CLI. */
export const PLATFORM_TOOLS_NOTE =
  '\n\nThis repository is hosted on a Git platform with server-side read tools. Prefer them to ' +
  'reading whole files. Run `export YONEDA_TOKEN=provided-by-worker` once in your shell (the ' +
  'sandbox replaces it with the real credential), then, from the repository root: ' +
  '`yoneda grep <text>` lists matching lines as path:line: text; `yoneda symbols <path>` lists ' +
  "each function of a file with its start_line and end_line, so you can read only those lines " +
  "(for example `sed -n '<start>,<end>p' <path>`); `yoneda blame <path>` and `yoneda log <path>` " +
  'also work.';

export const TOKEN_ARMS = {
  tools: { label: 'platform read tools (yoneda grep/symbols)', brief: { ...TOKEN_BRIEF, intent: TOKEN_BRIEF.intent + PLATFORM_TOOLS_NOTE } },
  plain: { label: 'plain clone only', brief: TOKEN_BRIEF },
};

/** What the CLI did, from its sandbox activity (`tool` entries read "<Tool> <target>"). */
export function toolProfile(entries) {
  const tools = (entries ?? []).filter((e) => e.kind === 'tool').map((e) => String(e.text ?? ''));
  return {
    tool_calls: tools.length,
    yoneda_calls: tools.filter((t) => /\byoneda\s+(grep|symbols|blame|log|diff)\b/.test(t)).length,
    file_reads: tools.filter((t) => /^Read\b/.test(t)).length,
    searches: tools.filter((t) => /^(Grep|Glob)\b/.test(t) || /\b(rg|grep)\s/.test(t.replace(/\byoneda\s+grep\b/g, ''))).length,
  };
}

// --- C13 P9: file-disjoint but dependency-coupled tasks vs the platform's plan.

export function p9Fixture() {
  return {
    'src/pricing.js': "'use strict';\n\n/** The price of `amount` units. */\nfunction price(amount) {\n  return amount;\n}\n\nmodule.exports = { price };\n",
    'src/checkout.js': "'use strict';\nconst { price } = require('./pricing.js');\n\n/** The total price of a list of unit amounts. */\nfunction total(amounts) {\n  return amounts.reduce((sum, amount) => sum + price(amount), 0);\n}\n\nmodule.exports = { total };\n",
    'src/cart.js': "'use strict';\n\n/** The number of items in a cart. */\nfunction count(items) {\n  return items.length;\n}\n\nmodule.exports = { count };\n",
    'src/format.js': "'use strict';\n\n/** A plain integer label. */\nfunction label(n) {\n  return String(n);\n}\n\nmodule.exports = { label };\n",
  };
}

/** Passes at the seed; every present function must be right, so a stale price() call fails. */
export const P9_POLICY = policy('proof-p9-v1', [
  'node',
  '-e',
  "const p=require('./src/pricing.js'),c=require('./src/cart.js'),k=require('./src/checkout.js'),f=require('./src/format.js');" +
    "if(k.total([1,2])!==3)process.exit(1);if(typeof c.shipping==='function'&&c.shipping()!==5)process.exit(1);" +
    "if(typeof p.quote==='function'&&p.quote(4)!==4)process.exit(1);if(typeof f.formatMoney==='function'&&f.formatMoney(5)!=='$5.00')process.exit(1)",
]);

/** Owner-written tasks with the read and write sets the owner declares for git_plan. */
export const P9_TASKS = {
  pricing: {
    title: 'Currency for price()',
    instructions:
      "In src/pricing.js, give price() a second required parameter currency: it throws an Error when currency is missing, returns amount when currency is 'usd' and amount * 2 otherwise. Add and export quote(amount), which returns price(amount, 'usd'). Update every existing caller of price() in the repository to pass 'usd'. Change nothing else.",
    write_set: ['src/pricing.js', 'src/checkout.js'],
    read_set: [],
    done: [['src/pricing.js', /\bquote\b/]],
  },
  shipping: {
    title: 'Shipping in the cart',
    instructions:
      'In src/cart.js, add and export shipping(), which returns the price of 5 units by calling price() from src/pricing.js (require it). Read price() first and call it correctly for its current signature. Change nothing else.',
    write_set: ['src/cart.js'],
    read_set: ['src/pricing.js#price'],
    done: [['src/cart.js', /\bshipping\b/]],
  },
  format: {
    title: 'Money format',
    instructions: "In src/format.js, add and export formatMoney(n), which returns '$' followed by n with two decimals (n.toFixed(2)). Change nothing else.",
    write_set: ['src/format.js'],
    read_set: [],
    done: [['src/format.js', /\bformatMoney\b/]],
  },
};

/** The two task sets: coupled (shipping calls what pricing changes) and the control. */
export const P9_SETS = { coupled: ['pricing', 'shipping'], control: ['format', 'shipping'] };

export const P9_INTENT = {
  intent: 'Small changes to a CommonJS pricing module, one task per agent.',
  criteria: ['The repository check passes', 'Each task changes only its own files'],
};

/** git_plan items for a task set: the owner's declared sets, nothing inferred. */
export const planItems = (ids) => ids.map((id) => ({ id, read_set: P9_TASKS[id].read_set, write_set: P9_TASKS[id].write_set }));

/**
 * The platform plan's stages as task ids. A joined item (a reference cycle) would need one
 * agent doing several tasks: the proof refuses it rather than invent a merge of briefs.
 */
export function stagesFromPlan(planned) {
  const items = planned?.items ?? [];
  const joined = items.filter((item) => (item.members ?? []).length !== 1);
  if (joined.length) throw new Error(`git_plan joined ${joined.map((i) => i.members.join('+')).join(', ')}: not runnable as one task each`);
  return (planned?.stages ?? []).map((stage) => stage.map((k) => items[k].members[0]));
}

/** One trial's outcome from the final candidate's check status and tree. */
export function p9Outcome(status, tree, taskIds) {
  if (status === 'rejected') return 'broken';
  if (status !== 'eligible') return 'unsettled';
  const missing = taskIds.flatMap((id) => P9_TASKS[id].done).filter(([path, pattern]) => !pattern.test(tree?.[path]?.content ?? ''));
  return missing.length ? 'incomplete' : 'clean';
}

// --- Statistics: descriptive only; no claim from fewer than 3 samples per arm.

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

/** Spend and time before a live command, at measured sandbox costs (about $0.003-0.01 per agent). */
export function estimate(executions, perExecutionUsd, minutes) {
  return { executions, usd: Number((executions * perExecutionUsd).toFixed(3)), minutes };
}

/** A run's metered model usage, summed over its executions (`metered_usage` per execution). */
export function sumUsage(executions) {
  const total = { requests: 0, input: 0, cache_read: 0, output: 0, usd: 0 };
  for (const { metered_usage: u } of executions ?? []) {
    if (!u || !Number.isSafeInteger(u.requests)) continue;
    total.requests += u.requests;
    total.input += u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
    total.cache_read += u.cache_read_input_tokens;
    total.output += u.output_tokens;
    total.usd += u.charged_microusd / 1e6;
  }
  return total;
}
