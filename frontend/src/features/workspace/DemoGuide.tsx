import { X } from 'lucide-react';

export function DemoGuide({ onClose }: { onClose: () => void }) {
  return (
    <section className="demo-guide" aria-labelledby="demo-guide-title">
      <div className="demo-guide-heading">
        <h2 id="demo-guide-title">Review a run from intent to publication</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close demo guide"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <p>
        Choose an available repository and browse its recorded work. Reading evidence starts no
        agent runs.
      </p>
      <ol>
        <li>
          <strong>Find the review that needs attention.</strong> Open Runs. Choose the run in
          history and read its status. A checked result awaits a separate shipping decision.
        </li>
        <li>
          <strong>Inspect the exact result.</strong> In Results, open Review changes and Check
          details. Compare approaches when multiple results exist. A preview shows the checked
          candidate; it does not confirm publication.
        </li>
        <li>
          <strong>Read the evidence trail.</strong> Open Evidence trail, or use Read this run’s
          evidence trail in Context usage. Follow intent, agent contributions and captured handoffs,
          captured revisions, independent checks, decision rationale and reasons for rejecting
          alternatives, then publication status. Explore graph is available for relationships; it
          starts with a bounded run neighborhood.
        </li>
        <li>
          <strong>Understand agent progress.</strong> Agent activity includes the recorded event
          timeline with elapsed times, task handoffs and execution logs. Run details contains the
          brief, recorded decision and controls. Cancel run asks you to confirm before stopping
          work.
        </li>
        <li>
          <strong>Handle changed source.</strong> A stale result cannot be selected. Repair on
          current revision opens a new run using the previous brief and current source. Review
          settings and approve fresh work; the earlier capture is retained.
        </li>
      </ol>
      <details>
        <summary>Start new work or make a shipping decision</summary>
        <p>
          Use New run or Update project to prepare a brief, connections and limits. Approval starts
          paid model inference. Wait for trusted source capture and independent checks before
          reviewing a result.
        </p>
        <p>
          Review result or Review approach opens the shipping decision. Record why you chose it and
          why you rejected alternatives, then Record decision and publish. Selection and publication
          stay separate until canonical Git verification finishes.
        </p>
      </details>
      <p>
        Older runs, failures and simulated observations remain evidence. Read their labels and
        recorded status; they do not establish a new successful publication.
      </p>
    </section>
  );
}
