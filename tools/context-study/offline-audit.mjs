// Audit saved evidence only. No login, provider access, inference or oracle rerun.
// First: cargo xtask context-study plan --output .local/semantic-context-investigation/context-plan
// Then: node tools/context-study/offline-audit.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const arms = ['source_only', 'plain_notes', 'graph'];
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export function audit(manifest, results, maintenance = null) {
  const corpus = new Set(manifest.corpus.map(record => record.id));
  const summaries = results.map(result => {
    const observations = result.evidence?.observations ?? [];
    const pages = result.evidence?.usage_pages ?? [];
    const entries = new Map();
    const citations = new Map();
    for (const page of pages) {
      for (const entry of page.entries ?? []) entries.set(entry.call_id ?? entry.seq, entry);
      for (const citation of page.citations ?? []) citations.set(citation.seq ?? citation.record_id, citation);
    }
    const historicalOpened = new Set();
    const historicalReturned = new Set();
    const historicalCited = new Set();
    for (const entry of entries.values()) {
      for (const target of entry.targets ?? []) {
        if (!corpus.has(target.id)) continue;
        if (entry.stage === 'opened') historicalOpened.add(target.id);
        if (entry.stage === 'returned') historicalReturned.add(target.id);
      }
    }
    for (const citation of citations.values()) {
      for (const target of citation.targets ?? []) if (corpus.has(target.id)) historicalCited.add(target.id);
    }
    const captures = observations.map(observation => ({
      execution_id: observation.execution_id,
      provider: observation.provider,
      model: observation.model,
      status: observation.status,
      commit: observation.candidate?.revision?.commit ?? null,
      oracle_pass: typeof observation.oracle?.pass === 'boolean' ? observation.oracle.pass : null,
    }));
    const checked = captures.filter(capture => capture.commit && capture.oracle_pass !== null);
    // Relevance is a task contract, not a consequence of retrieval or a passing outcome.
    const knownTaskIds = result.trial.case === 'local_continuation'
      ? ['context:privacy', 'context:capacity']
      : ['website_update', 'delegation'].includes(result.trial.case) ? [...corpus] : null;
    const relevant = new Set(result.trial.relevant_context_ids ?? knownTaskIds ?? []);
    const relevantOpened = [...historicalOpened].filter(id => relevant.has(id)).sort();
    const relevantReturned = [...historicalReturned].filter(id => relevant.has(id)).sort();
    const executionLineage = captures.map(capture => {
      const delivered = new Set();
      const opened = new Set();
      const cited = new Set();
      const boundToCapture = new Set();
      for (const entry of entries.values()) {
        if (entry.execution_id !== capture.execution_id) continue;
        for (const target of entry.targets ?? []) {
          if (!relevant.has(target.id)) continue;
          if (entry.stage === 'opened') opened.add(target.id);
          if (['opened', 'returned'].includes(entry.stage)) delivered.add(target.id);
        }
      }
      for (const citation of citations.values()) {
        if (citation.execution_id !== capture.execution_id) continue;
        for (const target of citation.targets ?? []) {
          if (!relevant.has(target.id)) continue;
          cited.add(target.id);
          if (capture.commit && citation.candidates?.some(candidate => candidate.revision?.commit === capture.commit)) boundToCapture.add(target.id);
        }
      }
      const observed = pages.length > 0 && (knownTaskIds || result.trial.relevant_context_ids);
      return {
        execution_id: capture.execution_id,
        delivered_ids: observed ? [...delivered].sort() : null,
        opened_ids: observed ? [...opened].sort() : null,
        cited_ids: observed ? [...cited].sort() : null,
        citations_bound_to_capture_ids: observed ? [...boundToCapture].sort() : null,
        captured_commit: capture.commit, behavioral_pass: capture.oracle_pass,
        outcome_benefit: null,
      };
    });
    return {
      case: result.trial.case, arm: result.trial.arm, repetition: result.trial.repetition,
      model_assignment: result.trial.model_assignment,
      expected_executions: result.trial.executions,
      completed: captures.filter(capture => capture.status === 'completed').length,
      checked: checked.length,
      passes: checked.filter(capture => capture.oracle_pass).length,
      complete: captures.length === result.trial.executions && checked.length === result.trial.executions,
      unique_receipt_calls: entries.size,
      historical_opened_ids: [...historicalOpened].sort(),
      historical_returned_ids: [...historicalReturned].sort(),
      historical_cited_ids: [...historicalCited].sort(),
      task_relevant_context: {
        relevance_basis: result.trial.relevant_context_ids ? 'explicit trial maintenance/feature contract'
          : knownTaskIds ? 'existing fixture task contract' : 'unspecified; relevance is unknown',
        constraint_ids: [...relevant].sort(),
        receipt_observed: pages.length > 0,
        delivered_ids: pages.length && (knownTaskIds || result.trial.relevant_context_ids) ? [...new Set([...relevantOpened, ...relevantReturned])].sort() : null,
        opened_ids: pages.length && (knownTaskIds || result.trial.relevant_context_ids) ? relevantOpened : null,
        cited_ids: pages.length && (knownTaskIds || result.trial.relevant_context_ids) ? [...historicalCited].filter(id => relevant.has(id)).sort() : null,
        outcome_benefit: null,
        per_execution: executionLineage,
      },
      receipt_pages_complete: pages.length > 0 && pages.at(-1).has_more === false,
      citations_complete: pages.length > 0 && pages.every(page => page.citations_truncated === false),
      captures,
    };
  });
  const matched = new Map();
  for (const summary of summaries) {
    const key = JSON.stringify([summary.case, summary.repetition, summary.model_assignment]);
    if (!matched.has(key)) matched.set(key, []);
    matched.get(key).push(summary);
  }
  const completeTriplets = [...matched.values()].filter(group =>
    group.length === 3 && arms.every(arm => group.filter(summary => summary.arm === arm && summary.complete).length === 1));
  const bounds = [3, 9, 27].map(limit => {
    const trials = manifest.trials.slice(0, limit);
    const groups = trials.reduce((sum, trial) => sum + (trial.case === 'website_update' ? 2 : trial.case === 'delegation' ? 1 : 0), 0);
    const local = trials.filter(trial => trial.case === 'local_continuation').length;
    return {
      clusters: trials.length,
      planned_executions: trials.reduce((sum, trial) => sum + trial.executions, 0),
      hosted_model_groups: groups,
      hosted_request_ceiling: groups * manifest.hosted_model_requests_per_group,
      hosted_output_token_ceiling: groups * manifest.hosted_model_requests_per_group * manifest.output_tokens,
      local_cli_turn_ceiling: local * manifest.local_cli_max_turns,
      execution_ms_per_attempt: manifest.execution_ms,
      dollar_ceiling: null,
      pricing: null,
    };
  });
  return {
    version: 1, scope: 'Offline audit of saved legacy-study receipts and verdicts; not fresh event-booking campaign evidence; captures not fetched or re-evaluated',
    trials: summaries, complete_matched_triplets: completeTriplets.length,
    causal_effect: null,
    causal_limit: 'Delivery/citation lineage and oracle controls do not measure a causal retrieval benefit. Complete matched trials are needed; graph vs notes isolates retrieval format, graph vs source also changes historical information availability.',
    bounds,
    maintenance_acceptance: maintenance,
    cost_limit: 'The legacy hosted runner described by this manifest sends spend_limit_microusd:null and pricing:null. These are request/output/time bounds, not dollar caps. The separate fresh booking campaign requires exact server-enforced $12 total/$2 chain approvals. Input tokens, saved models and provider plans/rates are not supplied by this legacy manifest. Local CLI turns are not proxy requests.',
    live_requirements: [
      'Explicit authorization for paid inference and the selected cluster count, saved MiMo/ZAI models and existing plan/region; no silent substitution',
      'Approve current provider pricing and spending allowance separately; the runner does not enforce a dollar ceiling',
      'Dedicated test account, private mode-0600 credential file, saved MiMo/ZAI connections, compatible Worker and runtime rollout, passing oracle controls',
      'Local-continuation cases additionally require the runtime image and operator-supplied local provider keys; Worker vault keys are never exported',
      'Retain all failures, exact captures, receipt pages, citations and separate oracle outcomes; diagnose exit-143 losses and collect complete matched results',
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const defaults = {
    '--manifest': '.local/semantic-context-investigation/context-plan/manifest.json',
    '--results': 'artifacts/context-study-smoke-rechecked/results.json',
    '--output': '.local/semantic-context-investigation/context-audit.json',
    '--maintenance': null,
  };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    if (!(args[index] in defaults) || !args[index + 1]) throw new Error('Use --manifest FILE --results FILE --output FILE [--maintenance FILE]');
    defaults[args[index]] = args[index + 1];
  }
  const result = audit(readJson(defaults['--manifest']), readJson(defaults['--results']),
    defaults['--maintenance'] ? readJson(defaults['--maintenance']) : null);
  result.inputs = Object.fromEntries(['--manifest', '--results'].map(key => [key.slice(2), { path: defaults[key], sha256: sha256(defaults[key]) }]));
  if (defaults['--maintenance']) result.inputs.maintenance = { path: defaults['--maintenance'], sha256: sha256(defaults['--maintenance']) };
  mkdirSync(dirname(defaults['--output']), { recursive: true });
  writeFileSync(defaults['--output'], `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Audited ${result.trials.length} saved clusters; ${result.complete_matched_triplets} complete matched triplets. Causal effect remains unmeasured. ${defaults['--output']}`);
}
