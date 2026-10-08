# Workspace interface

The working surface is a repository with three dedicated views: Runs, Context graph and Source history. Provider connections, repository creation, local-agent access, new briefs and shipping review use native dialogs with focus containment and Escape dismissal. The administrator connection lives under Workspace options.

The visual language uses IBM Plex Sans with Mono reserved for source and revision IDs. White navigation and content surfaces sit on a cool pale canvas (#f6f8fb), with ink (#152436), muted text (#637286), cobalt actions (#245de8) and teal verified states (#157f72). Borders establish grouping; spacing follows a 4/8/16/24/32 scale. There are no invented activity indicators or metrics.

A selected candidate opens review immediately. The dialog names its exact captured revision, requires a rationale and alternative tradeoffs, and retains API errors. Closing it does not select or publish source. A successful selection reserves publication; the UI separately reports Git verification and the published website revision. The browser never treats an agent claim as independent evidence.

Connection names distinguish personal/team keys even when they use the same provider. A run chooses exact connection IDs and configured models for each of 2–4 isolated approaches. The UI offers the five actual provider routes, including the native Gemini harness.

At narrow widths, repository navigation collapses behind a labelled menu, dialogs fit the viewport and forms/cards stack. Every interactive element has a visible focus indicator; motion respects reduced-motion preference. Empty/loading/errors contain next actions. Authentication uses explicit Create account / Sign in tabs and a separate recovery path.

Verification is recorded in docs/ui-workflow-evidence.md. Existing submission video demonstrates the earlier interface and remains historical evidence of its real agent run.
