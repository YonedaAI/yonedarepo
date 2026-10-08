# Provider configuration and testing budgets

Users sign in and save their own keys under provider settings. Provider keys are encrypted with
AES-256-GCM in the personal Workspace DO, with the workspace/provider identity as authenticated
data. Only the scoped Worker egress adapter decrypts them. Settings responses expose provider,
model and configuration status. A missing user key never falls back to platform credentials.

The operator's Secrets Store bindings are `Codex`, `Claude`, `MiMo` and `ZAI`. They are available
only to administrator-owned repositories. All upstream URLs are fixed in the adapter.

| Provider | Testing model | Protocol |
| --- | --- | --- |
| Codex | `gpt-5.6-luna` | OpenAI Responses |
| Claude | `claude-sonnet-4-6` | Anthropic Messages |
| MiMo | `mimo-v2.6-flash` | Anthropic compatibility |
| ZAI | `glm-4.7-flash` | Anthropic compatibility; key/model entitlement must be verified live |

The MiMo Flash default follows the current [MiMo pricing and model availability](https://mimo.mi.com/docs/pricing).
Protocol setup: [MiMo Claude Code](https://mimo.mi.com/docs/integration/claudecode),
[ZAI Claude Code](https://docs.z.ai/devpack/tool/claude).
Configured models are recorded on the execution. No provider or model fallback is automatic.

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

Each attempt has a durable limit of 24 model requests, 4,096 output tokens per request and a wall
deadline. Local checks need no keys and perform no inference. Live checks are explicit.
An increase to the shared testing ceiling requires a deliberate operator change; it never resets
when another run begins.

`cargo xtask setup` creates ignored, mode-0600 local owner/vault credentials. Back up
`.local/vault-key` securely. Deployment retains an existing Worker `VAULT_KEY`; it does not rotate
the key on each deploy. A deliberate key rotation needs decrypt/re-encrypt migration before the
old key is removed. Never put keys in Git, CLI arguments, browser storage or logs.

The execution image includes pinned Node/Rust tooling, pnpm and Python's standard library.
Owner-approved setup/check commands run in fresh containers. Dependency egress permits only
read-only npm and crates.io registry downloads, strips credentials, rejects redirects and bounds
downloads. Other package registries, arbitrary Docker images and private dependency credentials
are outside this first runtime profile.
