# Repository usage activation

Repository Insights and the operators' repository reports use the existing
Analytics Engine dataset. `REPO_ANALYTICS=on` is declared for dev and prepared
for the same production configuration; production activation still follows the
ship pipeline. No new dataset, authority, queue or historical backfill is added.

## Request budget

- Collection adds repository/actor-kind/outcome/bytes fields to the existing
  point, at most one usage point per request. No source paths, branch names,
  commit messages, raw credentials or account names enter these fields.
- Collection runs after the response. A clone's pack bytes are counted when
  its stream finishes. Internal accounts and marked test traffic stay excluded.
- Insights first asks the repository authority on every request. Only viewers
  allowed to read the whole repository receive it; restricted readers have no
  Insights navigation capability and the endpoint still refuses them.
- The authority bounds contributor history to the newest 5,000 rows per source
  and shows at most 25 contributors. Usage takes one Analytics SQL statement on
  a miss. Cache only completed rows for at most 5 minutes, 500 entries/isolate;
  key by account/dataset/repository/range and exact bucket window. No pending
  I/O or authorization result is shared between requests.
- Missing reader configuration or a failed query yields unavailable usage,
  preserves admitted contributors, and offers retry. An empty successful query
  stays empty. Collection begins after activation; earlier missing usage is not
  reconstructed from commit history. Counts may be sampled and are marked ≈.

## Verification and activation

Local checks cover flag/binding parity in both declared environments and every
regional API/authority, one-point recording/refusals/stream completion, whole-repo
admission and revocation, bucket-boundary cache invalidation, empty and failure
states. Real workerd repositories provide admission; Analytics Engine binding and
SQL responses are simulated locally, not presented as historical usage.

After review, deploy dev and confirm the read secret/binding and a real query.
Use isolated non-internal test activity for live counting: the owner's marked
QA traffic deliberately produces no usage. Do not enable an unrelated agent,
visitor or operations switch or fabricate past counts. Production is source-ready
only until the normal dev acceptance and ship process complete.
