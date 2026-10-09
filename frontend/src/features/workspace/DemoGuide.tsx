import { X } from 'lucide-react';

export function DemoGuide({ onClose }: { onClose: () => void }) {
  return (
    <section className="demo-guide" aria-labelledby="demo-guide-title">
      <div className="demo-guide-heading">
        <h2 id="demo-guide-title">Try the existing demo first</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close demo guide"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <p>The populated Retry client demo is ready to browse. Viewing it starts no agent runs.</p>
      <ol>
        <li>
          <strong>Connect your workspace.</strong> Open Owner connection and choose your owner token
          file, or paste the workspace owner token and click Connect. Provider API keys are separate
          and stay in Cloudflare.
        </li>
        <li>
          <strong>Compare the code.</strong> Select Retry client, then Exploration. Open Review
          changes on each approach and check its build and behavior results. The existing run is
          already accepted, so its Select approach buttons are disabled.
        </li>
        <li>
          <strong>Find the reason.</strong> Open Intentional history. Keep the published commit and
          path <code>src/main.rs</code>, then click Trace history. Use Fit View and click graph
          nodes to inspect the intent, shared research, alternatives, checks and recorded decision.
        </li>
        <li>
          <strong>Inspect the incident.</strong> Find the recorded observation in the history graph.
          Its details label it simulated and link it to the original research assumption. You can
          optionally record another simulated observation; this adds history without running agents.
        </li>
      </ol>
      <details>
        <summary>Run a fresh exploration with real agents</summary>
        <p>
          This uses paid model inference. In Exploration, click New run, leave the sample retry
          intent and click Start run. Research runs first; minimal, defensive and maintainable then
          work from the same research. Wait for captured commits and independent build and behavior
          checks.
        </p>
        <p>
          Review changes, select an eligible approach and explain Why choose this approach? Click
          Record decision and publish. The publication banner separates the selected commit from the
          published commit until verification finishes. Then trace the new published commit in
          Intentional history.
        </p>
      </details>
      <p>
        What to test: can you understand the alternatives, find their checks, and trace the chosen
        code back to its reason? Start with browsing; a fresh run is optional.
      </p>
    </section>
  );
}
