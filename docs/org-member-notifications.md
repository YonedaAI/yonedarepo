# Organization membership notifications

An added member receives an account-scoped in-app notification and, if their
current contact address is verified, an email. Membership remains instant. The
saved membership never depends on notification delivery succeeding.

The organization authority commits a notice beside a new membership grant.
Existing memberships and role-only edits create no notice. Removing a member
cancels unfinished notices; a later new membership has a new event id. A job
already in flight may record the same person's historical membership before it
observes cancellation; that entry grants no access. Recipient incarnation is
captured at the grant and checked in the recipient transaction for inbox, hint
and verified mail target. Account name reuse cannot receive a prior person's
notice, even if both signups share the same clock tick. An alarm is armed
before the grant can commit, then sends at most 20 pending notice jobs per pass
through the existing platform queue. Pending delivery retries every minute; new
grants can bring that pass forward without postponing an earlier alarm. No external I/O
runs inside the membership transaction. Queue loss and transient mail failure
leave the durable notice recoverable. Concurrent jobs take a fenced lease.

The job upserts a recipient inbox entry using organization+event id, checks the
current verified address server-side, and reuses the existing Resend sender and
stable idempotency keys. No recipient email enters the inbox, UI or logs. Email
retry after an uncertain send stops before the provider's 24-hour dedupe window;
in-app delivery remains available. This avoids blind duplicate sends after a
long delivery outage; provider acceptance is separate from inbox delivery.

Inbox endpoints derive the account from its current cookie session. They return
at most 50 entries and unread count; acknowledgement can update only that account.
The header bell starts after the application is usable and idle, then polls
once a minute in visible tabs. Opening it requests the latest inbox immediately.
No new global scan, service, queue, agent or invitation/acceptance flow is added.

Verification covers new/repeated grants, role changes, removal/re-addition,
transaction rollback, schema upgrade/replay, leases and stale completions,
recipient isolation, verified email, failure/retry and acknowledgement loss.
Local queue/mail capture and served UI checks are distinct from real email
delivery. No actual email is sent by the automated local checks.

Request budget: no inbox request during sign-in or the initial repository load;
one deferred read once usable, a 60-second visible-tab poll, a fresh read when
returning to a visible tab, and an explicit read when opening. Responses contain at most 50 entries; each
personal inbox retains 100. Organization recovery processes at most 20 events
per pass. Existing account, queue and email bindings are reused.

Local acceptance: Rust transaction/migration/recovery cases, real workerd
recipient isolation and captured verified mail, and Chrome against the served
application with real local account alarms and queue delivery. Wide and 375px,
light and dark, keyboard, empty/loading/error/full states passed. A typed Rust
queue envelope is required: generic JSON maps serialize as JavaScript Maps in
the SDK and do not reach the TypeScript envelope decoder correctly. Real email
provider delivery and deployed acceptance remain separate checks.
