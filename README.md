# YonedaRepo — Agent-First Repository

An API-first, Git-like transactional model where agents fetch only what they need, coordinate changes, and preserve context.

[Try it at yonedarepo.com](https://yonedarepo.com/) · [Submission and verification](docs/submission.md) · [Architecture](docs/current-state-architecture.md) · [Release evidence](docs/release-evidence.md) · [Published agent-built website](https://yonedarepo-sites-dev.mlong-f01.workers.dev/p/yoneda-garden-live/)

## Try it

1. Open [yonedarepo.com](https://yonedarepo.com/). Choose **Have a reviewer access key?** and enter the privately supplied key, or sign up with a username/password and connect your own provider key. Reviewers need no signup or provider key.
2. Start the **guided task-board demo**. It walks one fresh project through four stages: build together → continue from context → reconcile concurrent changes → review and publish.
3. Or choose **Start a Run** and describe an app, feature or bug fix. Leave the first agent on **Auto**; YonedaRepo plans the team, coordinates it and returns one checked result for review.
4. Publication is always a separate human decision.

Read-only CLI (Node 24, no dependencies, starts no inference):

```sh
node tools/reviewer.mjs --checked
```

It prompts for the key without echoing it and opens the latest independently checked result. A private file is supported: `node tools/reviewer.mjs --key-file /path/to/access.json --checked --no-open`. After the workspace switches to shared accounting, `--new` and `--resume` open the ordinary workspace for browser approval.

Reviewer work draws on a configurable shared workspace allowance (currently $100), counted conservatively with retained spending; provider charges may differ. Optional sample briefs only prefill a form: selecting one starts no work and is not evidence that the requested behavior occurred.

## What it does

- **Fetch only what you need.** Each agent receives a frozen, bounded packet of prior context and either an isolated Git fork or a lazy, server-side source view that loads files on demand without a clone.
- **Coordinate changes.** One transactional ledger per repository holds the planned task graph, durable peer messages and working branches that advance only when the expected version still matches. Stale or conflicting results wake a coordinator that reconciles them and obtains fresh checks.
- **Preserve context.** Intent, agent claims, independent checks and human decisions are linked to exact revisions in a typed graph. The next run inherits that history.
- **Agent claims are not authority.** Trusted capture builds fresh Git objects, a clean evaluator checks that exact revision against a protected test bundle, and a human decides what ships. Git remains the canonical, compatible history.

Verification history and dated test counts live in [release evidence](docs/release-evidence.md) and the [implementation ledger](docs/progress.md).

## Product details

Sign up with a username/password, save the recovery code, connect your own provider key, add a repository and approve a brief. Hosted agents use your paid provider account. Choose **Connect Agents** in the sidebar to connect a hosted model provider or your own MCP/Git agent, wherever it runs. The public Garden website is viewable without an account.

![Reviewing an exact captured revision before publication](docs/images/selection-review.png)

Follow [the website workflow](docs/website-workflow.md) to create an account, connect provider keys, start concurrent agents, compare their changes and publish a checked static website. The older [retry fixture walkthrough](docs/demo.md) remains an operator verification example.

MiMo connections support **API credits** or **Token Plan**, with an explicit plan region. ZAI
connections use the Coding Plan endpoint and default to **GLM-5.3-Flash**. New owner runs share the workspace allowance and bounded model/execution limits.
Automatic selection uses saved models with verified conservative pricing; unsupported or unpriced choices are rejected before scheduling.
See [provider setup and adding a provider](docs/providers.md).

Start with one Auto agent preference. The planner selects one to six approved agents when complementary work justifies a team, freezes their responsibilities, and integrates one checked result. Optional model/role rows guide the plan; task ownership and dependencies are system responsibilities. Advanced settings retain manual teams and independent comparisons. [Build together](docs/build-together.md) captures specialist outputs and checks their exact integration. An automatic run shares 144 model requests across planning, work and two bounded repair rounds, with at most three concurrent agents and 20 executions. These run limits do not expand the workspace allowance.

**Compare two approaches** starts two independent builders, checks their exact captured revisions, then runs a separate read-only reviewer. If no independently eligible result remains, review is skipped without a model call. The reviewer records why it chose a result and why the other approach lost. If neither meets the goal, it can request up to two repairs of the more promising captured alternative; each repair needs fresh capture, checks and review. Checks alone never choose the working head. You can override the recommendation with a reason, inspect both alternatives and decide whether to publish. The original agent explanation and your decision remain separate records.

Existing two-builder runs offer **Review now**: one explicit approval reviews the retained results and permits bounded repairs without rebuilding the original alternatives. Original spending and approvals remain intact. Older one-to-six-builder runs retain manual selection. Opening the review screen or running the read-only CLI starts no inference.

Later runs start from the current working branch or published source and retain relevant prior intent, criteria and context. Fresh work starts with Auto; an explicit restart preserves the older requested settings for review. Current repository checks apply.

[Current UI and deployment verification](docs/ui-workflow-evidence.md) · [Presenter video script and production brief](docs/video/production-brief.md)

Rust owns the domain, transactional ledger, native agent supervisor, MCP server, source capture and verifier. Cloudflare hosts the Worker, Durable Objects, Queues, R2, D1, Containers and Artifacts. React 19 and React Flow provide the browser. A small TypeScript adapter connects SDK capabilities absent from workers-rs.

The source includes Git-native workspaces, paged history, active-work limits, frozen prior context, guarded checked working branches, peer conversations, bounded agent-defined plan amendments and repairs, protected evaluation bundles and file-level provenance. The app profile serves JS/TS UI/API/SQLite on isolated hosts through Worker Loader and AppRunner DOs. See [the current architecture](docs/current-state-architecture.md) and [campaign contract](docs/campaign-contract.md).

## Get running

Requires the pinned Rust toolchain, Node 24, pnpm 11, Docker, and `worker-build` 0.8.7:

```sh
cargo install worker-build --version 0.8.7 --locked
cargo xtask doctor
cargo xtask setup
cargo xtask check
cargo xtask dev
```

Open `http://localhost:8787` and sign up. The sites Worker runs at `http://localhost:8788`. Local state stays in `.wrangler/state`; Artifacts requires access to the configured remote development namespace. The local test gate uses workerd and SQLite without paid inference. The private `.local/owner-token` is for operator bootstrap.

To work on the browser with hot reload, keep Wrangler running and run `pnpm --dir frontend dev` in another terminal. The Vite server proxies API traffic to Wrangler.

## Deploy to your own Cloudflare account

The `cloudflare/wrangler*.jsonc` configs describe our development deployment. Use the commands below to generate separate configs for **your** account; they remove our Secrets Store bindings and replace all resource IDs, queue names, service bindings and website URLs. Rust `xtask` owns the deployment scripts.

### One-time manual prerequisites

1. Enable Workers Paid, Containers, R2 and Queues in your Cloudflare account, and confirm your account has [Artifacts access](https://developers.cloudflare.com/artifacts/get-started/workers/). Enable a `workers.dev` subdomain under **Workers & Pages → Settings** and record it along with your account ID. Billing/access approvals happen in the dashboard, not in our scripts.
2. Install Git, the pinned Rust toolchain, Node 24.18, pnpm 11.16, `worker-build` 0.8.7 and Docker. Start Docker. [Container deployments build and upload an image](https://developers.cloudflare.com/containers/get-started/), including on the first deploy.
3. Clone this repository, run `cargo xtask setup`, then `pnpm exec wrangler login` and `pnpm exec wrangler whoami`. Choose credentials with access to your target account. For CI, use Cloudflare's [Wrangler CI authentication](https://developers.cloudflare.com/workers/wrangler/ci-cd/); keep the API token in your CI secret store.
4. Create D1 once using a minimal config so this command cannot target our development account. Replace the example account ID and names:

```sh
mkdir -p .local/bootstrap
cat > .local/bootstrap/wrangler.json <<'JSON'
{"account_id":"YOUR_32_CHARACTER_ACCOUNT_ID","name":"my-yoneda","compatibility_date":"2026-10-07"}
JSON
pnpm exec wrangler d1 create my-yoneda-index --config .local/bootstrap/wrangler.json
```

Copy the resulting D1 UUID. If the database already exists, obtain its UUID from **Storage & databases → D1** instead of creating another one.

### Configure and provision

Replace `YOUR_SUBDOMAIN` with the part before `.workers.dev`, and supply the D1 UUID:

```sh
cargo xtask cloudflare-configure \
  --name my-yoneda \
  --account-id YOUR_32_CHARACTER_ACCOUNT_ID \
  --subdomain YOUR_SUBDOMAIN \
  --namespace my-yoneda \
  --database-id YOUR_D1_UUID
```

Review `.local/deploy/my-yoneda/platform.json` and `sites.json`. Configuration is repeatable for the same identity; it preserves your existing config edits. A different account/namespace/database requires a different deployment name. Artifacts [creates the namespace on the first repository creation](https://developers.cloudflare.com/artifacts/concepts/namespaces/); no namespace-creation command is required.

Create these resources once. Skip any that already exist in your target account:

```sh
pnpm exec wrangler r2 bucket create my-yoneda-objects --config .local/deploy/my-yoneda/platform.json
pnpm exec wrangler queues create my-yoneda-dead-letter --config .local/deploy/my-yoneda/platform.json
pnpm exec wrangler queues create my-yoneda-agent --config .local/deploy/my-yoneda/platform.json
pnpm exec wrangler queues create my-yoneda-capture --config .local/deploy/my-yoneda/platform.json
pnpm exec wrangler queues create my-yoneda-evaluate --config .local/deploy/my-yoneda/platform.json
pnpm exec wrangler queues create my-yoneda-publish --config .local/deploy/my-yoneda/platform.json
```

### Build, deploy and try it

```sh
cargo xtask doctor
cargo xtask check
cargo xtask cloudflare-deploy --name my-yoneda --dry-run
cargo xtask cloudflare-deploy --name my-yoneda
```

The deploy command builds Rust Wasm and the browser, applies forward-only D1 migrations, deploys the platform and container image, deploys the isolated sites Worker, checks platform health, and initializes/readbacks the Artifacts website starter. It configures new `OWNER_TOKEN` and `VAULT_KEY` secrets via a private temporary file, retains existing deployed secrets, and removes the upload file. It starts no paid inference. Run the same deploy command for upgrades; preserve the Durable Object migration history and identities.

Back up `.local/deploy/my-yoneda/owner-token` and `vault-key` privately. Never commit them. Losing the vault key makes existing provider ciphertext unreadable. When deploying from another machine, restore the operator token to the same private path; the script refuses to rotate an existing operator credential. Existing deployed vault keys are retained even when a local copy is absent. Use separate deployment names/resources for staging and production. Custom domains are optional: configure them in the dashboard and update the generated `SITE_ORIGIN` and deployment manifest URLs together.

For canonical app links and social previews on a custom domain, set `vars.PUBLIC_APP_ORIGIN` in the generated platform config to your HTTPS origin, such as `https://yoneda.example`, then redeploy. Otherwise metadata uses the request origin. Keep `assets.run_worker_first: true` so the Worker resolves public metadata before serving HTML. See [public metadata and brand assets](docs/public-metadata.md).

Open `https://my-yoneda.YOUR_SUBDOMAIN.workers.dev`, create a personal account and save its recovery code. In **Agent providers**, add a named API key connection for MiMo, ZAI, OpenAI/Codex, Anthropic/Claude or Google/Gemini. No operator provider key or Secrets Store setup is required for personal accounts. Add a repository, create a run with 1–6 agents, set its **Model budgets**, approve the brief, review checked previews/diffs, then select an approach and record the shipping decision in its review dialog. **Update website** opens a fresh brief from current canonical source; agents can be added or removed for that run. **Restart run** reopens a completed or cancelled run's settings for a fresh approval while preserving its evidence. See [the complete browser workflow](docs/website-workflow.md) and [budget controls](docs/providers.md#run-budgets-in-the-console).

The sites Worker is `https://my-yoneda-sites.YOUR_SUBDOMAIN.workers.dev`. Initial container provisioning can take several minutes after the Worker URL responds. Inspect `pnpm exec wrangler containers list --config .local/deploy/my-yoneda/platform.json` if a hosted run cannot start. A health response proves the Worker is serving; it does not prove a provider has credit or that an agent run succeeded.

Use **Agent providers → Edit connection** to change a model or billing route without reentering a key. Each approach has **View logs** for retained request diagnostics. Operators can search structured Worker and Rust container logs in **Cloudflare → Observability**. See [logging, storage and retention](docs/logging.md).

To delete a repository, select it and open **Repository options (⋯) → Delete repository** in the header. Type its exact name to confirm. Deletion stops active agents, revokes repository agent access and makes published pages and previews unavailable. Git cleanup retries in the background; shared provider connections stay. See [deletion and storage retention](docs/website-workflow.md#delete-a-repository).

For local development against **your** remote Artifacts namespace:

```sh
cargo xtask dev --name my-yoneda
cargo xtask seed-template --url http://localhost:8787
```

Local DO/D1/R2 state is isolated under `.local/deploy/my-yoneda/state`; the local sites origin is `http://localhost:8788`. Local authentication/vault variables are private and separate from deployed credentials. Artifacts still uses your remote namespace and Cloudflare authentication. `cargo xtask check` works without provider keys or remote inference.

Use low cost MiMo/ZAI models for testing. Codex defaults to `gpt-5.6-luna`, Claude to `claude-sonnet-5-5`, and Gemini to `gemini-3.8-flash`. These are recorded model choices; no more expensive fallback is selected silently. New runs draw on the shared workspace allowance, which defaults to $50 for a new workspace and can be changed through the admin allowance API. Gemini's CLI/proxy path has local integration coverage; paid Gemini completion must be verified with a funded user key.

To connect a local agent instead, use **Connect local agent** and follow the scoped MCP/Git instructions shown there and in [the MCP guide](docs/remote-mcp.md). After publication, **Source history** traces the exact revision to its intent, alternatives and decision. **Context graph** is the browsable memory; future agents retrieve it through MCP.

## Repository

```text
frontend/                      Browser features, components, styles and Vite config
backend/crates/
  yoneda-core/                 Contracts, evidence and pure policy validation
  yoneda-app/                  Transactional commands, graph and DO migrations
  yoneda-cloudflare/           Rust SDK interoperability
  yoneda-worker/               Rust Repo and Live Durable Objects
  yoneda-runtime/              Native supervisor, MCP, capture and evaluation
cloudflare/
  worker/                      Thin SDK, transport and authentication adapters
  sites/                       Isolated static website Worker
  containers/                  Pinned native runtime image
  migrations/                  Forward-only D1 discovery migrations
  wrangler*.jsonc              Platform and sites environment configuration
shared/                        Shared contracts backed by the Rust registry
xtask/                         Reproducible developer and deployment commands
tests/                         Cross-boundary workerd, runtime and container tests
fixtures/                      Small source repositories for tests/demonstrations
docs/                          Architecture, operations and verification evidence
context/                       Original design material
tools/                         Video and public-export utilities
```

Workspace manifests, lockfiles, the pinned toolchain and shared tooling stay at the root. Generated output (`target/`, `node_modules/`, `frontend/dist/`, Wasm `build/`), local state and diagnostic artifacts stay ignored.

After upgrading from the previous layout, run `cargo xtask setup`. It privately copies an existing root `.dev.vars` to `cloudflare/.dev.vars` if the new file is absent; existing credentials and `.wrangler/state` are preserved. For a named deployment, repeat your original `cloudflare-configure` command to update known legacy source paths while preserving resource identities and custom settings. Run raw Wrangler operations with `--config cloudflare/wrangler.jsonc` (or the named config); the root scripts and `xtask` supply it automatically.

[Architecture](docs/architecture.md) · [Runbook](docs/runbook.md) · [Engineering standards](AGENTS.md) · [Implementation evidence](docs/progress.md)

Agents inspect delivery, explicit citations and exact revision checks through [context usage](docs/context-usage.md); the console shows the same evidence per run. The [controlled usefulness pilot](docs/plans/context-usefulness-pilot.md) compares source-only, plain-note and graph conditions with separate checks. [Collaborative agent runs](docs/collaborative-agent-runs-plan.md) documents the implemented brief-driven team workflow and later stages. [Public metadata](docs/public-metadata.md) documents favicons, sharing cards and canonical deployment origins.

Apache-2.0. See [the product MVP plan](docs/product-mvp-plan.md) and [foundation contract](docs/implementation-plan.md); cross-run task graphs, enterprise tenancy and automatic semantic merges are deferred.
