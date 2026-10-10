# Provider configuration and testing budgets

Users sign in and save their own keys under provider settings. Provider keys are encrypted with
AES-256-GCM in the personal Workspace DO, with the workspace/provider/connection identity as authenticated
data (v2; existing v1 provider records remain readable). Only the scoped Worker egress adapter decrypts them. Settings responses expose connection ID/name, provider,
model, billing route and configuration status. A workspace can keep up to 32 independent connections, including multiple keys for one provider. Runs freeze connection IDs, models and billing routes; removal or a model/route mismatch fails closed. A missing user key never falls back to platform credentials.

The operator's Secrets Store bindings are `Codex`, `Claude`, `MiMo` and `ZAI`. They are available
only to administrator-owned repositories. Upstream URLs and authentication conventions are fixed
in the shared provider registry, never supplied by a browser or agent.

### Current upstream routes

| Provider | Upstream request | Account requirement |
| --- | --- | --- |
| OpenAI/Codex | `https://api.openai.com/v1/responses` | OpenAI API key |
| Anthropic/Claude | `https://api.anthropic.com/v1/messages` | Anthropic API key |
| MiMo API credits | `https://api.xiaomimimo.com/anthropic/v1/messages` | Regular `sk-` API key |
| MiMo Token Plan | `https://token-plan-{cn,sgp,ams}.xiaomimimo.com/anthropic/v1/messages` | Dedicated `tp-` or `ttp-` key and its assigned region |
| Google/Gemini | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` or `:streamGenerateContent` | Google AI Studio API key |
| ZAI | `https://api.z.ai/api/anthropic/v1/messages` | Account access to ZAI's Anthropic-compatible coding endpoint |

ZAI's [regular API](https://docs.z.ai/api-reference/introduction) documents
`https://api.z.ai/api/paas/v4/chat/completions`, which uses a different protocol from the
[Coding Plan endpoint](https://docs.z.ai/devpack/tool/others) above. The current connector
does not offer a separate regular-API route. A published model ID or a saved key does not
establish access to the configured endpoint. This is an integration limitation to resolve
before claiming general ZAI API-key support.

| Provider | Testing model | Protocol |
| --- | --- | --- |
| Codex | `gpt-5.6-luna` | OpenAI Responses |
| Claude | `claude-sonnet-5-5` | Anthropic Messages |
| MiMo | `mimo-v2.6-flash` | Anthropic compatibility |
| Gemini | `gemini-3.8-flash` | Native Gemini GenerateContent through Gemini CLI 0.63.0 |
| ZAI | `glm-5.3-flash` | Anthropic compatibility through the Coding Plan endpoint |

The MiMo Flash default follows the current [MiMo pricing and model availability](https://mimo.mi.com/docs/pricing).
Protocol setup: [MiMo Claude Code](https://mimo.mi.com/docs/integration/claudecode),
[ZAI Claude Code](https://docs.z.ai/devpack/tool/claude).
Gemini configuration follows the official [CLI proxy and authentication settings](https://geminicli.com/docs/reference/configuration/) and [current API models](https://ai.google.dev/gemini-api/docs/models). Its native CLI/Rust MCP roundtrip is tested with offline fixtures; paid-provider and deployed egress acceptance are separate.
Configured models are recorded on the execution. No provider or model fallback is automatic.

### MiMo billing source

In **Agent providers → Add a connection**, choose **API credits** for a regular `sk-` key, or
**Token Plan subscription** for a `tp-`/`ttp-` key. For Token Plan, select the region shown on
your MiMo plan page: China, Singapore or Europe (Amsterdam). MiMo does not currently document a
US Token Plan endpoint. The console detects a pasted Token Plan key but requires an explicit
region. A mismatched key type is rejected before saving or sending inference. The saved route
is frozen into root and child executions; there is no regional or billing fallback.
See [MiMo's key and endpoint guide](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access).

Existing connections can be corrected with **Edit connection**. Leave the API key blank to retain
its encrypted value; saving checks the stored key against the chosen billing source. Concurrent
edits use a configuration version and stale saves are rejected. Starting a hosted run also checks
stored key/route compatibility before creating executions or dispatching work, including older
connections saved before billing routes were exposed. Changes apply to freshly approved runs;
historical evidence and frozen routes are preserved. See [logging and diagnostics](logging.md).

ZAI Coding Plan and general API usage bundles are separate products. This connector uses the
Coding Plan endpoint; saving a key here does not consume a regular API usage bundle. Existing
connections retain their model IDs; new ZAI connections default to GLM-5.3-Flash.

Claude testing starts with a **USD 20 ceiling**. The administrator's ceiling is shared across
repositories, concurrent attempts and restarts in a Workspace DO. Personal BYOK workspaces have
their own initial ceiling. Only Sonnet 4.6 is accepted for Claude testing.

Each request reserves a conservative upper bound before inference. The bound counts one input
token per UTF-8 JSON byte plus 8,192 tokens of overhead, at USD 6 per million input tokens and USD
30 per million output tokens. This covers Sonnet's one-hour cache-write rate and twice its ordinary
output rate. Completed provider usage settles at those conservative rates; incomplete responses
retain the entire reservation. The ledger reports a charged safety allowance, **not an invoice**.
Reference: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).
Paid server tools, images, premium tiers and custom upstream URLs are disabled in testing.

## Choosing a model

**Agent providers → Model** offers provider-specific presets and a custom model entry for
providers that permit it. Presets are taken from the provider's published catalog; they are not a
live check of a key's access. Changing the picker does not alter existing connections or runs.
Claude remains limited to the configured Sonnet testing policy.

ZAI currently uses its [Anthropic-compatible coding endpoint](https://docs.z.ai/devpack/tool/others).
Its general API catalog and Coding Plan have different model access rules; check the
[model switching guide](https://docs.z.ai/devpack/latest-model) for your account. Selecting a model
does not fund an account or increase its provider limits. ZAI documents HTTP 429 business code
1302 as a request rate limit, 1113 as insufficient balance, and 1305 as temporary overload in
its [error reference](https://docs.z.ai/api-reference/api-code). A rate-limited request can produce
no model output; YonedaRepo still counts the attempted request against the approved allowance.

## Run budgets in the console

In **New run → Model budgets**, optionally enter a request limit or dollar budget for each model.
Both are blank by default: new hosted runs have no YonedaRepo request or dollar cap unless you
set one. **Minutes per execution** is visible for every model: the default remains 10 minutes, and owners can approve 1–30 minutes. **Advanced limits** contains response size and pricing. A timeout stops work even if provider requests succeed; use Restart run to approve more time or narrow the task.
Roots using different connections for the same model, their subagents
and infrastructure retries share that model's request and dollar allowance. Execution time applies
to each attempt. New runs have no hidden 24-request or aggregate 144-request ceiling.
Known models use conservative pricing presets when you enter an amount; custom models require
owner-entered rates under **Advanced limits**. Approving the run brief approves its configured
limits and rates together. These settings are frozen with the brief; agents cannot
raise them. **Restart run** reopens the brief and budgets for approval as a fresh run, preserving the
original run and its evidence. Finish or cancel active work before restarting it.

The ledger reserves input bytes plus 8,192 tokens of overhead and the permitted output before
each model request. Complete upstream token usage reconciles that reservation at the approved
rates; missing/truncated usage retains it. **Reserved estimate** includes these outstanding
reservations. A request can stop before the displayed allowance is completely consumed because
its worst-case reservation would not fit. This is an estimate using approved rates, not a provider
invoice or Cloudflare infrastructure budget. Provider pricing and account balances remain separate.

Presets were checked against official pricing on 2026-10-08: [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[MiMo](https://mimo.mi.com/docs/pricing), [Z.AI](https://docs.z.ai/guides/overview/pricing),
[Gemini](https://ai.google.dev/gemini-api/docs/pricing) and [Sonnet](https://platform.claude.com/docs/en/about-claude/pricing).
Conservative presets use Luna's cache-write input premium, Gemini's announced higher January 2027
standard rates, and Sonnet's existing USD 6/30 input/output safety rates. GLM-4.7-Flash is currently
listed as free; request and time limits still apply. Review the rates when approving a run.

Approved budgeted runs do not inherit the CLI's hidden USD 1 estimate. Older runs without a
`model_budgets` approval retain their legacy 24 requests per execution across retries,
4,096 output tokens per response and ten-minute attempt deadline; actual Anthropic legacy runs
also retain the CLI USD 1 estimate. The durable Claude workspace ceiling remains an additional
operator limit for all runs. Local checks need no keys and perform no inference. Live checks are explicit.
An increase to the shared testing ceiling requires a deliberate operator change; it never resets
when another run begins.

`cargo xtask setup` creates ignored, mode-0600 local owner/vault credentials. Back up
`.local/vault-key` securely. Deployment retains an existing Worker `VAULT_KEY`; it does not rotate
the key on each deploy. A deliberate key rotation needs decrypt/re-encrypt migration before the
old key is removed. Never put keys in Git, CLI arguments, browser storage or logs.

## Adding a provider

The public descriptor at `backend/crates/yoneda-core/src/providers.json` is the single registry consumed
by Rust validation/scheduling, `shared/providers.ts`, the browser picker and Worker egress.
It contains no credentials. For a compatible provider, add one descriptor with a stable ID,
display name, harness/protocol, HTTPS API base, authentication header/prefix, default model,
model presets and official catalog URL. Personal BYOK connections then work through the shared
vault and settings flow; operator credentials additionally need the named Cloudflare binding.

Supported protocols are Anthropic Messages (`claude` harness), OpenAI Responses (`codex` harness)
and Gemini GenerateContent (`gemini` harness). The API base excludes the protocol paths appended
by its adapter. OpenAI Chat Completions alone is not Responses-compatible and requires an adapter.
Provider-specific products belong in small routing adapters, as with `cloudflare/worker/mimo-routing.ts`.
New protocols also need a request/stream adapter and compatible harness; they are not just an URL.

Run the registry invariants, Worker protocol/scope tests and `cargo xtask check`. Verify actual
authentication, tools and streaming with an explicitly authorized live check. Unknown pricing
requires owner-entered rates only when a dollar cap is configured. No provider may change the
frozen connection, billing product, region or model from an agent-supplied argument.

### Upgrade compatibility

This change adds JSON metadata, not SQL tables or columns. Existing numeric request limits and
legacy routing remain readable. New runs record `request_limits: "optional-v1"`; `max_requests:
null` means uncapped. Historical runs retain their original per-model and aggregate limits.
Deploy the new Rust ledger, Worker and runner image together. Capabilities advertise
`optional_model_requests: 1`; the Worker refuses old runners before inference. Restarting creates
a fresh run on the current policy; historical explicitly set limits are shown for editing rather
than silently erased. To roll back, stop new attempts and restore a compatible ledger/image pair;
older binaries cannot deserialize new null limits.

The execution image includes pinned Node/Rust tooling, pnpm and Python's standard library.
Owner-approved setup/check commands run in fresh containers. Dependency egress permits only
read-only npm and crates.io registry downloads, strips credentials, rejects redirects and bounds
downloads. Other package registries, arbitrary Docker images and private dependency credentials
are outside this first runtime profile.
