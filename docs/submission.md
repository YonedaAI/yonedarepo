# YonedaRepo submission

YonedaRepo treats a development run as a shared intent and a set of concurrent alternatives. Agents preserve typed context while they work. Independent capture and checks attach evidence to exact revisions; the owner selects what ships, and a future agent can query why through MCP.

- **Video:** [narrated product walkthrough](https://github.com/MagnetonIO/yonedarepo/releases/download/mvp-2026-10-08/yonedarepo-mvp.mp4). Edited actual browser captures and live evidence; synthetic narration. See [script and production notes](demo-video.md).
- **Source:** [MagnetonIO/yonedarepo](https://github.com/MagnetonIO/yonedarepo), Apache-2.0.
- **Try it:** [development platform](https://yonedarepo-dev.mlong-f01.workers.dev/). Create an account, connect your own provider key, create a repository and approve a two-agent run. Paid inference uses your provider account.
- **Immediate public example:** [Juniper Garden](https://yonedarepo-sites-dev.mlong-f01.workers.dev/p/yoneda-garden-live/), built by concurrent Luna/Sonnet agents and published after an owner-directed selection.
- **Run locally:** [README](../README.md#get-running) and [runbook](runbook.md). The local gate needs no inference keys; local Artifacts access requires Cloudflare authentication and configured resources.
- **Connect your existing agent:** [remote MCP and Git setup](remote-mcp.md), using a revocable repository-scoped key from the website.
- **Evidence and limits:** [release verification](release-evidence.md) and [machine-readable record](release-evidence.json).

## Five-minute hands-on path

1. Sign up and save the one-time recovery code privately.
2. Connect a provider key under **Agent providers**, or use **Connect local agent** for your own local coding agent.
3. Add a website-template repository. Choose **New run** and ask for a small static site, such as an accessible event page. Give two approaches the same goal. Review and approve the brief and independent check commands.
4. Watch concurrent progress, inspect captured code and previews, and explore typed context. When the run is **Ready for review**, select an eligible approach and record a reason and alternative tradeoffs.
5. Wait for verified canonical publication, then open the published site. Use **Intentional history** to trace its code to intent and evidence. A fresh MCP client can recover that context and submit another checked contribution.

Use a project-specific test profile: the starter HTML smoke check does not prove all browser interactions or product requirements. Hosted sites are isolated relative-path static output; full-stack applications and external API calls require a future deployment profile.

## Submission checklist

The release provides the requested permissively licensed source, 5–10 minute video and running instructions. Competition form submission, any entry agreement, and final creative acceptance are the owner's actions. No competition entry submission is claimed here.
