// Optional driver post-step after read_only_review: stage timing plus the driver-side browser
// check on the exact checked final revision. A failing check means the demo is not ready.
import { gateSummary, runProductGate } from './product-gate.mjs';
import { guidedTiming, readEvents } from './timing.mjs';

export async function productGateStep(client, state, { outRoot, save = async () => {}, gate = runProductGate } = {}) {
  const final = state.steps?.concurrent?.checked;
  if (!final?.evaluation_id || !final.candidate_id || !final.revision?.commit)
    throw new Error('No checked final result to gate; complete the guided steps first');
  const { result, outDir, snapshot } = await gate(client.api, state.repo_id, {
    evaluation: final.evaluation_id,
    candidate: final.candidate_id,
    revision: final.revision.commit,
    ...(outRoot ? { outRoot } : {}),
  });
  state.product_gate = gateSummary(result, outDir);
  state.demo_ready = result.outcome === 'pass';
  state.timing = guidedTiming(snapshot, { steps: state.steps, events: await readEvents(client.api, state.repo_id) });
  await save(state);
  return { product_gate: state.product_gate, timing: state.timing, demo_ready: state.demo_ready };
}
