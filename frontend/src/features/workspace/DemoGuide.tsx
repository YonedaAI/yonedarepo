// The surrounding dialog supplies the title and close control.
export function DemoGuide(_props: { onClose: () => void }) {
  return (
    <section className="demo-guide" aria-label="How YonedaRepo works">
      <p className="demo-guide-lede">
        YonedaRepo is an agent-first repository. Agents <strong>fetch</strong> only what they need,{' '}
        <strong>coordinate</strong> their changes through one shared ledger, and{' '}
        <strong>preserve</strong> the context behind every decision. You decide what ships.
      </p>
      <h3>Try it in four steps</h3>
      <ol>
        <li>
          <strong>Build together.</strong> Open <em>Guided demo</em> and start the first step. Two
          agents work in parallel from a shared contract; their work is captured and independently
          checked.
        </li>
        <li>
          <strong>Continue from context.</strong> A new run opens the earlier design decision and
          builds on it instead of starting cold.
        </li>
        <li>
          <strong>Reconcile changes.</strong> Two runs edit the same code. A coordinator reconciles
          them, then fresh checks run.
        </li>
        <li>
          <strong>Review and publish.</strong> See what changed, why, and which checks passed.
          Nothing ships until you publish.
        </li>
      </ol>
      <h3>Where to look</h3>
      <ul>
        <li>
          <strong>Runs</strong> — each run's result, status and agent activity.
        </li>
        <li>
          <strong>Evidence trail</strong> — intent, agent claims, checks and decisions, linked to
          exact revisions.
        </li>
        <li>
          <strong>Source history</strong> — why each file changed.
        </li>
      </ul>
      <details>
        <summary>Start your own run</summary>
        <p>
          Choose <em>Start a Run</em> and describe an app, a feature or a bug fix. YonedaRepo plans
          the team and works within your workspace allowance. Opening the form or a sample brief
          costs nothing; starting the run uses model inference.
        </p>
      </details>
      <details>
        <summary>Connect your own agents</summary>
        <p>
          <em>Connect Agents</em> adds hosted model providers, or gives your own MCP-compatible
          agent (such as Claude Code or Codex) a key scoped to one repository.
        </p>
      </details>
      <p className="demo-guide-note">
        Agent statements are claims until captured and checked. Reading evidence never starts work.
      </p>
    </section>
  );
}
