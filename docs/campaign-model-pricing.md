# Campaign model approval basis

Verified against official provider documentation on 2026-10-12. This is a conservative approval and reservation basis, not measured paid execution or provider invoices. Existing run approvals retain their original rates and models.

| Provider/model ID | Official standard input/output USD per million tokens | Campaign input/output ceiling |
| --- | --- | --- |
| Z.AI `glm-5.3-flash` | $0.15 / $0.50 | $0.15 / $0.50 |
| OpenAI `gpt-5.6-luna` | $0.20 / $1.20 | $0.25 / $1.20 |
| Claude `claude-sonnet-5-5` | $2 / $10 | $4 / $10 |
| Claude `claude-opus-5-5` | $4 / $20 | $8 / $20 |

Z.AI publishes [GLM5.3Flash token prices](https://docs.z.ai/guides/overview/pricing) and the [Coding Plan model and Claude-compatible endpoint](https://docs.z.ai/devpack/latest-model). Coding Plan access belongs to the operator. Its nominal token accounting caps internal campaign use; it does not claim that the subscription is billed per token. Reviewer entry exposes completed independently checked GLM evidence and fixed metered Codex trial approval.

OpenAI's [GPT5.6Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna) confirms the exact model ID, Responses endpoint, streaming and function calling. Cache creation costs 1.25 times ordinary input, covered by the $0.25 ceiling. Requests are restricted to text/local tools and 262,144 input bytes; the conservative extra 8,192 input-token allowance stays below the 272K long-context premium threshold. Server-side paid tools, prior response IDs and premium tiers are removed or rejected.

Claude's [model catalog](https://platform.claude.com/docs/en/models/overview) and [pricing table](https://platform.claude.com/docs/en/about-claude/pricing) confirm both IDs and standard rates. Campaign input ceilings include one-hour cache creation (twice base input); cached/read tokens are conservatively counted at that same ceiling. Fast mode and inference geography modifiers are stripped; paid server tools are rejected.

The [official thinking guide](https://platform.claude.com/docs/en/build-with-claude/thinking) specifies adaptive thinking for Opus5.5 and automatic interleaving with tool calls. The adapter converts the harness's bounded legacy enabled request into adaptive, normalizes beta-only display updates into stable summaries, and rejects forced tool selection, disabled thinking and between-tools mode on Opus. Streaming remains unchanged. Sonnet5.5's existing adaptive handling and Z.AI's compatible adaptive tool protocol are preserved.

Reviewer trials freeze two logical Codex roles, automatic team planning, the approved goal, working branch commit/version, shared two repair rounds and a $5 chain ceiling. The original approval also includes exactly one automatic Opus source repair/resolver after a terminal cheaper first-repair failure. Every premium request must match the server-claimed execution ID. Routine charges consume the $35 bucket; the one-shot premium execution consumes the $10 bucket within the same $5 per-run envelope. The $5 reserve is unavailable to ordinary starts. Unknown, partial, failed or lost usage remains fully reserved.

No deployment or paid inference was used to verify this policy. Local Workerd tests use synthetic credentials and upstream responses.
