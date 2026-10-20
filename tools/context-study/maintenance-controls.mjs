// Existing-project bug/feature acceptance controls. Hand-authored patches, no agents.
// Copies the committed yoneda-core and yoneda-agents-core into .local; Cargo is strictly offline.
// Reproduce: node tools/context-study/maintenance-controls.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const output = resolve('.local/semantic-context-investigation/maintenance');
mkdirSync(output, { recursive: true });
function git(args) {
  const result = spawnSync('/usr/bin/git', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const revision = git(['rev-parse', 'HEAD']).trim();
const core = 'backend/crates/yoneda-agents-core';
const crates = [core, 'backend/crates/yoneda-core'];
const paths = crates.flatMap((crate) => git(['ls-tree', '-r', '--name-only', revision, crate]).trim().split('\n'));
const source = git(['show', `${revision}:${core}/src/model_budget.rs`]);
assert.equal(source.split('.checked_add(999_999)').length, 2, 'rounding injection anchor must be unique');
const workspace = git(['show', `${revision}:Cargo.toml`]).replace(/^members = .*$/m, `members = ${JSON.stringify(crates)}`);
const lock = git(['show', `${revision}:Cargo.lock`]);
const contracts = [
  { id: 'maintenance:round-once', statement: 'Sum input and output fixed-point cost, then round upward once; retain checked arithmetic.' },
  { id: 'maintenance:utf8', statement: 'Text reservations count UTF-8 bytes, allow at most 262144 input bytes, and retain 8192-token overhead.' },
  { id: 'maintenance:count-only', statement: 'Count-only calls charge zero but still reject oversized input and nonzero requested output.' },
  { id: 'maintenance:optional-caps', statement: 'None means no request cap; zero is invalid. Optional pricing and explicit zero rates retain their separate meanings.' },
];
const badHelper = `
impl ModelBudget {
    pub fn reserve_text(&self, text: &str, output: i64, count_only: bool) -> Result<(i64,i64)> {
        if count_only { return Ok((0,0)); }
        self.reserve_charge(text.chars().count() as i64, output, false)
    }
}
`;
const goodHelper = `
impl ModelBudget {
    pub fn reserve_text(&self, text: &str, output: i64, count_only: bool) -> Result<(i64,i64)> {
        let bytes = i64::try_from(text.len()).map_err(|_| Error::new("INVALID_INPUT", "Text too large"))?;
        self.reserve_charge(bytes, output, count_only)
    }
}
`;
// Trusted tests are outside src; candidates never choose the acceptance cases.
const acceptance = `
use yoneda_agents_core::model_budget::{ModelBudget, MAX_MODEL_INPUT_BYTES};
fn budget() -> ModelBudget {
    serde_json::from_value(serde_json::json!({"provider":"mimo","model":"flash",
        "max_requests":null,"max_output_tokens":4096,"max_execution_ms":600000,
        "spend_limit_microusd":null,"pricing":{"input_microusd_per_million":1,
        "output_microusd_per_million":1,"source":"owner-approved conservative rates"}})).unwrap()
}
#[test]
fn bug_fixed_point_rounds_up_once() {
    assert_eq!(budget().charge(1,1).unwrap(),1);
}
#[test]
fn feature_utf8_reservation_keeps_byte_overhead() {
    let text="é".repeat(usize::try_from(MAX_MODEL_INPUT_BYTES/2).unwrap());
    assert_eq!(budget().reserve_text(&text,4096,false).unwrap().1,270336);
}
#[test]
fn feature_rejects_multibyte_input_over_limit() {
    let text="é".repeat(usize::try_from(MAX_MODEL_INPUT_BYTES/2+1).unwrap());
    assert_eq!(budget().reserve_text(&text,4096,false).unwrap_err().code,"INVALID_INPUT");
}
#[test]
fn feature_count_only_still_validates_input_and_output() {
    let b=budget();
    assert_eq!(b.reserve_text("hello",0,true).unwrap(),(0,0));
    assert_eq!(b.reserve_text("hello",1,true).unwrap_err().code,"INVALID_INPUT");
    let text="x".repeat(usize::try_from(MAX_MODEL_INPUT_BYTES+1).unwrap());
    assert_eq!(b.reserve_text(&text,0,true).unwrap_err().code,"INVALID_INPUT");
}
#[test]
fn compatibility_optional_caps_and_zero_rates() {
    let mut b=budget();
    assert!(b.validate_configuration().is_ok());
    b.max_requests=Some(0);assert!(b.validate_configuration().is_err());
    b.max_requests=None;b.pricing=None;assert!(b.validate_configuration().is_ok());
    assert_eq!(b.reserve_text("é",4096,false).unwrap().0,0);
    let mut b=budget();let rates=b.pricing.as_mut().unwrap();
    rates.input_microusd_per_million=0;rates.output_microusd_per_million=0;
    assert!(b.validate_configuration().is_ok());
    assert_eq!(b.reserve_text("é",4096,false).unwrap().0,0);
}
`;
const variants = [
  { id: 'injected-bug-and-incomplete-feature', fixBug: false, goodFeature: false, expectedPasses: 1 },
  { id: 'bug-specialist-only', fixBug: true, goodFeature: false, expectedPasses: 2 },
  { id: 'feature-specialist-only', fixBug: false, goodFeature: true, expectedPasses: 4 },
  { id: 'combined-contract-preserving-repair', fixBug: true, goodFeature: true, expectedPasses: 5 },
];
const results = [];
for (const variant of variants) {
  const directory = join(output, variant.id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'Cargo.toml'), workspace);
  writeFileSync(join(directory, 'Cargo.lock'), lock);
  for (const path of paths) {
    const destination = join(directory, path);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    writeFileSync(destination, git(['show', `${revision}:${path}`]));
  }
  const patched = (variant.fixBug ? source : source.replace('.checked_add(999_999)', '.checked_add(0)'))
    + (variant.goodFeature ? goodHelper : badHelper);
  writeFileSync(join(directory, core, 'src/model_budget.rs'), patched);
  mkdirSync(join(directory, core, 'tests'), { recursive: true });
  writeFileSync(join(directory, core, 'tests/maintenance_acceptance.rs'), acceptance);
  const tested = spawnSync('cargo', ['test', '--offline', '--manifest-path', join(directory, 'Cargo.toml'),
    '-p', 'yoneda-agents-core', '--test', 'maintenance_acceptance', '--', '--nocapture'], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CARGO_TARGET_DIR: join(output, 'target') },
  });
  const log = `${tested.stdout ?? ''}\n${tested.stderr ?? ''}`;
  writeFileSync(join(directory, 'test.log'), log);
  const checked = [...log.matchAll(/^test (\w+) \.\.\. (ok|FAILED)$/gm)].map(match => ({ name: match[1], pass: match[2] === 'ok' }));
  assert.equal(checked.length, 5, `acceptance suite did not finish: ${variant.id}; see test.log`);
  assert.equal(checked.filter(check => check.pass).length, variant.expectedPasses, variant.id);
  assert.equal(tested.status, variant.expectedPasses === 5 ? 0 : 101, variant.id);
  results.push({
    variant: variant.id, checks: checked, passed: variant.expectedPasses, total: 5,
    exit: tested.status, model_calls: 0,
    source_sha256: createHash('sha256').update(patched).digest('hex'),
    relevant_constraints: contracts.map(contract => contract.id),
    delivered: null, opened: null, cited: null, outcome_benefit: null,
  });
  console.log(`${variant.id}: ${variant.expectedPasses}/5 maintenance contracts pass`);
}
const result = {
  version: 1, existing_project: 'YonedaRepo yoneda-agents-core ModelBudget', source_revision: revision,
  source_path: `${core}/src/model_budget.rs`, source_sha256: createHash('sha256').update(source).digest('hex'),
  task: 'Fix an injected fractional-cost regression and add a raw-text reservation helper while retaining established contracts',
  injected_bug: true, production_bug_claim: false,
  relevant_maintenance_constraints: contracts, variants: results,
  lineage: 'No agent execution or retrieval occurred; delivered/opened/cited are unobserved, not zero',
  causal_effect: null,
  live_extension_required: 'The current three-arm runner catalog only covers website/delegation/local website cases. A live maintenance comparison needs a separately authorized new frozen existing-project case with matched source/model/budgets, hidden acceptance tests and retained task-relevant receipts; this offline control does not add that paid runner case.',
  limitation: 'Deterministic hand-authored maintenance acceptance controls on frozen existing-project code. Specialist labels describe patch roles, not agents. Differences in these chosen patches do not estimate context retrieval benefit.',
};
writeFileSync(join(output, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
