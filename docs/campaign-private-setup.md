# Private campaign setup

Target workspace: existing `reviewer` account. Operator authentication and target ownership are distinct: `/api/admin/campaign/*` requires an operator admin session or private bearer held in memory; request bodies name `username:"reviewer"`. `operator-account` in the fixture example is an inert placeholder and must not become a new account or repository owner. The `.local/owner-token` file is mode 0600; never echo its contents, interpolate it into command-line arguments or save response credentials.

IDs are distinct and immutable:

- Reviewer: `reviewer-event-booking-20261012-v1`, $50 total, $35 routine/$10 Opus/$5 inaccessible reserve, $5 shared per-run chain.
- Controlled six-chain study: `booking-maintenance-20261012-v1`, $12 total/$2 per chain, routine only, 60 shared Codex requests per chain across its three stages. No Opus or reserve.

E owns the private incomplete Artifacts starter, seven fresh forks, six-chain plan and execution. F owns both funding approvals and reviewer evidence/enablement. Configure/enable have no model calls. No caller should configure a second ID or reset a used ID because a request acknowledgement was lost: read the same server ID first.

1. E pushes the exported incomplete starter to private `yoneda-booking-campaign-starter-20261012`, verifies its exact HEAD, and revokes setup capabilities. E uses `/api/admin/campaign/provision` to fork the reviewer repository and six distinct study repositories with workspace `reviewer`. Study forks additionally freeze exact `context_study` and owner-asserted `context_seed`. Do not use generic admin init, which defaults to `_admin` ownership.
2. Operator setup/reads use POST `/api/admin/campaign/repository` with `{username:"reviewer",repo_id,action,input}`. It checks exact workspace ownership and permits bounded reads plus branch creation, protected-test approval and cancellation. Paid starts use their separate signed route. For the reviewer repository, POST wrapper action `create_working_branch` with `{id:"campaign-development",expected_commit:<read published_commit>,expected_version:<read version>}`. Read it back active. E may create this branch during provision handoff.
3. POST `/api/admin/reviewer/campaign/configure` with `{username:"reviewer",repo_id:<E's fresh reviewer ID>,expected_version:0,version:1}`. Do not supply old run/spend IDs. No GLM evidence is required yet. Configuration inherits the existing reviewer expiry and returns the disabled new approval with zero new campaign spend.
4. Configure internally seals four saved connections without returning keys: GLM `owner-campaign-glm-20261012`, Codex `reviewer-campaign-codex-20261012`, Sonnet `owner-campaign-sonnet-20261012`, Opus `reviewer-campaign-opus-20261012`. GLM/Sonnet are operator-only; fixed reviewer trials use Codex and their original dormant one-shot Opus escalation.
5. After the successful platform/native/Linux/local gates, POST `/api/admin/campaign/enable` with `{username:"reviewer",id:"reviewer-event-booking-20261012-v1",expected_version:1,expected_revision:<configure readback>,local_gate_receipt:<gate provenance>}`. This enables funding, while reviewer entry remains disabled.
6. For the controlled study, POST `/api/admin/campaign/configure` with this exact envelope, taking repositories and budget from E's frozen plan:

```json
{
  "username": "reviewer",
  "id": "booking-maintenance-20261012-v1",
  "expected_version": 0,
  "approval": {
    "version": 1,
    "profile": "controlled-event-booking-study-v1",
    "audience": "owner",
    "repo_ids": ["SIX_EXACT_E_PLAN_REPOSITORY_IDS"],
    "expires": "EXISTING_REVIEWER_EXPIRY_MILLISECONDS",
    "limit_microusd": 12000000,
    "chain_limit_microusd": 2000000,
    "buckets": {"routine": 12000000, "opus": 0, "reserve": 0},
    "model_budgets": [{
      "provider": "codex", "model": "gpt-5.6-luna",
      "max_requests": 60, "max_output_tokens": 4096,
      "max_execution_ms": 600000, "spend_limit_microusd": 2000000,
      "pricing": {"input_microusd_per_million": 250000, "output_microusd_per_million": 1200000,
        "source": "owner-approved conservative rates"}
    }]
  }
}
```

The two capitalized values above are substitutions, not a request to submit: `repo_ids` must contain all six E plan IDs, and `expires` must be an integer. Enable this ID with its read version/revision and gate receipt. Read `/api/admin/campaign/status` back; E verifies exact equality before execution. E's saved connection is `reviewer-campaign-codex-20261012`; its plan username is `reviewer`.

7. F uses wrapper action `approve_test_bundle` to approve the protected reviewer first-stage test bundle, then starts a new collaborative GLM/Codex run through `/api/admin/campaign/start_run`. Its original signed approval freezes both priced model groups, `campaign-development` commit/version, approved intent, shared two repair rounds, original one-shot Opus escalation and the $5 chain ceiling. Generic `start_run` cannot claim campaign authority. Verify `/api/admin/campaign/run_status` and persisted `campaign_approval_digest` before considering any result.
8. After a completed GLM execution and the exact final independently checked app outcome, POST `/api/admin/reviewer/campaign/enable` with `{username:"reviewer",expected_version:<current>,expected_revision:<current>,local_gate_receipt:<gate provenance>,glm_evidence_run_id:<fresh checked run>}`. This enables reviewer entry; it does not edit the funding approval or old spend. Later feature/duplicate-fix stages use new run IDs on the same checked working branch and preserve prior artifacts and accounting.
9. Reviewer default is `GET /api/reviewer/campaign/checked` and the isolated `site_preview?evaluation=<exact evaluation ID>` app. Optional `POST .../trial {request_id}` and `POST .../resume {}` preserve the fixed collaborative profile and immutable approval. No signup or provider-key setup is requested from the reviewer.

Pricing is conservative internal approval/reservation accounting, not a claim of measured provider invoice costs. See [pricing basis](campaign-model-pricing.md) and [route contracts](campaign-contract.md). Checked outcomes, deployment, real execution and publication are separate records; these workflows do not publish a canonical change.
