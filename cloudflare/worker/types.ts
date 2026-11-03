export type Json = Record<string, any>;
export type Envelope = {
  v: 1;
  repo_id: string;
  job_id: string;
  kind: string;
  workspace?: string;
  /** An account email job's confirmation token (platform-email-verify.ts); never logged. */
  token?: string;
  /** A classify job's pushed commits, parents first (repo-classify.ts). */
  commits?: string[];
  /** When an erase job first found the audit log in its way (repo-erase.ts). */
  blocked_since?: number;
  /** The Landing a clearance job looks at (repo-land-cleared.ts). */
  number?: number;
  /** The request this job descends from (request-scope.ts). Absent on older messages. */
  request_id?: string;
};
export interface Env {
  WORKSPACES: DurableObjectNamespace;
  /** Source platform authority: one SourceRepository per repository. */
  SOURCE_REPOS: DurableObjectNamespace;
  /** Commit shards (platform write path); absent where not yet deployed. */
  COMMIT_SHARDS?: DurableObjectNamespace;
  /** Land combiners, one per branch (platform write path); absent where not deployed. */
  LAND_COMBINERS?: DurableObjectNamespace;
  /** "request" makes a create wait for its commit shards to start, for comparing benches
   * (default: they start after the answer, see repo-create.ts). */
  SHARD_START?: string;
  /** Landing mode: batch (default) or changeset (see repo-changesets.ts). */
  LAND_MODE?: string;
  /** "true" lets a request choose its landing mode (x-yoneda-land-mode), for benchmarks. */
  LAND_MODE_OVERRIDE?: string;
  /** `on`: a repository's database refuses new work from 9 GB (unset or `off`: never). */
  REPO_STORAGE_GUARD?: string;
  REPO_SIZE_GUARD?: string;
  /** `on`: a check verdict's evidence is stored once, in `checks` (unset or anything else:
   * the run keeps a copy too; repo-archive-switches.ts). */
  CHECK_EVIDENCE_ONCE?: string;
  /** `on`: a new branch's `ref_chain` stores only what lies above main's (unset or anything
   * else: its whole first-parent history, up to 5,000 rows; repo-archive-switches.ts). */
  REF_CHAIN_SHARED?: string;
  /** `on`: commit shards forget a batch-landed commit once the authority holds it (unset or
   * anything else: they keep their copy until vacuum; repo-changesets.ts). */
  SHARD_FORGET_RECORDED?: string;
  /** `on`: every repository gets a compaction job once a day, landing or not (unset or
   * anything else: only a landing starts one; repo-compaction.ts). */
  COMPACTION_SWEEP?: string;
  /** `on`: destructive ops wait for the owner's legal hold answer, and the hold routes
   * exist (unset or anything else: neither; platform-legal-hold.ts). */
  LEGAL_HOLD?: string;
  /** `on`: the operators' billing routes and the nightly reconcile exist (unset or anything
   * else: neither; platform-admin-billing.ts). Set with the managed Worker's. */
  ADMIN_BILLING?: string;
  /** `on`: a change's page shows its Slop and Risk cards (repo-instruments.ts; unset or
   * anything else: no route, and the page asks for nothing). */
  LANDING_INSTRUMENTS?: string;
  /** `on`: what can clear a Landing queues a clearance job, and a repository can turn on Land
   * when cleared (repo-land-check.ts; unset or anything else: no job, and the switch is refused).
   * Set it only once every Worker on the queue knows the job. */
  LAND_WHEN_CLEARED?: string;
  /** `on`: `yoneda login --agent <name>` signs an agent up through the device flow. */
  AGENT_SIGNUP?: string;
  /** Platform check executors (one fresh container per run attempt). */
  CHECK_RUNNERS: DurableObjectNamespace<import('./check-container').CheckContainer>;
  IMPORT_RUNNERS: DurableObjectNamespace<import('./import-container').ImportContainer>;
  /** Platform jobs (projection, derived data, webhooks, purges). */
  PLATFORM_QUEUE: Queue<Envelope>;
  /** Check runs on their own queue (minutes each), so they never hold derive and
   * projection jobs' consumer slots; absent where not deployed (PLATFORM_QUEUE then). */
  PLATFORM_CHECKS?: Queue<Envelope>;
  /** This account's workers.dev subdomain: its Workers are never webhook targets (without
   * it, no workers.dev host is). */
  WORKERS_SUBDOMAIN?: string;
  /** Basin Pipelines stream for change-log analytics (repo-changelog.ts; unset: no stream
   * and no hold on compaction). Setup is in docs/runbook.md. */
  CHANGELOG?: { send(records: import('./repo-changelog').ChangeEvent[]): Promise<void> };
  /** Durable imports of external Git repositories into the source platform. */
  PLATFORM_IMPORT: Workflow<import('./repo-clone').CloneParams>;
  OBJECTS: R2Bucket;
  /** Private, epoch-fenced nearby Git read copies; retain the binding after first use. */
  READ_COPIES?: DurableObjectNamespace;
  /** Off by default: automatic US/Europe copies and actual-request creation hints. */
  AUTOMATIC_LOCALITY?: string;
  /** Off by default: authorized same-cell file walks reuse the existing tree holder. */
  SHARED_READ_TREES?: string;
  /** Probe local immutable bytes before the regional read copy; defer bounded fills. */
  EDGE_FIRST_READS?: string;
  /** Off by default: status owner/path decoration uses one local joined projection read. */
  JOINED_REPO_PATH?: string;
  /** Off by default: one fresh response supplies the full selected Overview. */
  OVERVIEW_BOOTSTRAP?: string;
  /** Off by default: reuse exact-content code matches after fresh authority admission. */
  SEARCH_CODE_MEMO?: string;
  RECENT_VERSIONS?: string;
  /** R2's S3 API for Git LFS presigned URLs (repo-lfs.ts): `https://<account>.r2.cloudflarestorage.com`,
   * the OBJECTS bucket's name, and an R2 API token's S3 key pair (secrets). LFS answers 501
   * where any is missing. */
  LFS_S3_ENDPOINT?: string;
  LFS_S3_BUCKET?: string;
  LFS_S3_ACCESS_KEY_ID?: string;
  LFS_S3_SECRET_ACCESS_KEY?: string;
  INDEX: D1Database;
  /** Public downloads: CLI releases and the Claude Code marketplace (front Worker only). */
  DOWNLOADS?: R2Bucket;
  ASSETS: Fetcher;
  /** The platform's own review-model key (model checks); never an agent-layer key. */
  REVIEW_MODEL_KEY?: { get(): Promise<string> };
  GLOBAL_AUTH_LIMITS?: string;
  AUTH_LIMITER?: RateLimit;
  /** Sign-in with GitHub / Google (oauth.ts): each provider is on only while both of its
   * secrets are set; otherwise its routes answer 404 and the sign-in page hides it. */
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  /** The GitHub App that reads private repositories for an import (github-app). Any of the three
   * unset: there is no Connect, and imports are of public repositories. */
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  /** Requests without credentials (public repositories), per client address. */
  PUBLIC_LIMITER?: RateLimit;
  OWNER_TOKEN?: string;
  /** The welcome email (account-email.ts): the Resend API key (Secrets Store, read at send
   * time), the sender (`YonedaRepo <hello@yonedarepo.com>`) and the contact address it
   * names. Any missing or unreadable: email is off. */
  RESEND_API_KEY?: { get(): Promise<string> };
  EMAIL_FROM?: string;
  EMAIL_CONTACT?: string;
  /** Where the operators' sign-up notice goes (platform-signup-notice.ts); EMAIL_CONTACT
   * when unset. */
  ADMIN_NOTIFY_EMAIL?: string;
  /** `on` opens the Flight log sign-up (platform-newsletter.ts); unset or anything else, or with
   * NEWSLETTER_KEY or email unset: nothing is stored or sent and the page says Coming soon. */
  NEWSLETTER?: string;
  /** Signs the Flight log's unsubscribe links; changing it breaks every link already mailed. */
  NEWSLETTER_KEY?: string;
  /** Where contact support's emails go (platform-support.ts); unset, the form answers 503. */
  SUPPORT_EMAIL?: string;
  /** Operators: accounts (comma separated) whose browser sessions may use the admin pages
   * and `/api/v1/admin` (admin-auth.ts). Unset or empty: none. */
  ADMIN_ACCOUNTS?: string;
  /** The managed agents Worker's admin bearer (platform Worker), for the admin pages' credit
   * grants and balances over MANAGED; unset: those answer as unavailable. */
  MANAGED_ADMIN_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** `on` erases a deleted repository's records once its purge finishes (repo-erase); any
   * other value leaves them in its tombstone. */
  REPO_ERASE?: string;
  /** Days a deleted repository can be restored before its purge (repo-undo-window.ts). Unset or
   * 0: it purges at once. */
  REPO_UNDO_DAYS?: string;
  /** `on` writes a large push's objects as bundles (repo-bundles); reads always use them. */
  PUSH_BUNDLES?: string;
  /** `on` serves a clone's pack (full, partial or shallow) from the store when one is held,
   * else stores it as it streams or hands it to a job, and builds main's packs after a push
   * (repo-pack-cache, repo-pack-jobs); otherwise every pack is built. */
  PACK_CACHE?: string;
  /** Objects a pack needs before a job builds it (default 5000; repo-pack-jobs). */
  PACK_BUILD_MIN_OBJECTS?: string;
  /** Wasm MiB above which a clone hands its pack to a job instead of storing it (default
   * 48; repo-git-upload). */
  PACK_STORE_WASM_MIB?: string;
  /** `off` leaves a shard commit's blobs to its shard's drain instead of also writing them
   * to R2's cache key after the commit (repo-commit-shard); anything else writes them. */
  BLOB_WRITE_THROUGH?: string;
  /** `on` keeps organizations' audit logs and people's sign-in events (account-audit.ts);
   * anything else writes neither and `/orgs/:org/audit` answers 404. */
  AUDIT_LOG?: string;
  /** `on` keeps search summaries and serves `GET /search` (repo-account-search.ts); anything
   * else writes none, that route answers 404 and clients ask each repository themselves. */
  ACCOUNT_SEARCH?: string;
  /** The website people sign in at (device approval page `/device`); the platform falls
   * back to the request origin. */
  WEB_ORIGIN?: string;
  /** The source platform Worker (front Worker); its public API is all it calls. */
  PLATFORM?: Fetcher;
  /** The managed agents Worker: the front Worker proxies `/api/managed/*` to it; the
   * platform Worker grants and reads credit through its admin routes (admin pages). */
  MANAGED?: Fetcher;
  PUBLIC_APP_ORIGIN?: string;
  /** Cookieless site analytics (site-events.ts): page requests, pings and sign-ups on the front
   * Worker, client kinds on the platform Worker; absent, nothing is recorded. */
  SITE_EVENTS?: AnalyticsEngineDataset;
  /** `on` takes the browser ping (site-ping.ts) and counts platform requests by client kind
   * (platform-client-events.ts); set on both Workers. */
  TRAFFIC_EVENTS?: string;
  /** `on` adds outcome and duration to client points, leaves internal accounts out of every
   * figure (internal-accounts.ts), and opens the Traffic page's other ranges and comparison;
   * set on both Workers. */
  TRAFFIC_REPORT?: string;
  /** `on` adds the repository, bytes and a landing's outcome to platform points, and opens the
   * repository Insights page and the admin landing and repository reports (repo-usage.ts). Needs
   * TRAFFIC_EVENTS and TRAFFIC_REPORT on. */
  REPO_ANALYTICS?: string;
  /** `on` counts an agent credential as an agent, adds a digest of its token's id and the client
   * it names to its points, and opens the admin Agents tab (platform-agent-report.ts). Needs
   * REPO_ANALYTICS on. */
  AGENT_REPORT?: string;
  /** `on` splits the operator log, adds its filters and detail panel, and records failed admin
   * attempts, purges' ends and staff reads (platform-operator-audit.ts). Needs D1 migration 0015. */
  OPERATOR_AUDIT?: string;
  /** `on` opens the admin Operations and Infrastructure tabs (platform-operations-report.ts). */
  OPS_REPORT?: string;
  /** What the Infrastructure tab reads, as JSON: `{"scripts":["name"],"queues":{"jobs":"<id>"},
   * "d1":"<id>","r2":"<bucket>"}`. Ids, no secrets; a queue whose label holds `dead` counts as
   * dead letters. Unset, the tab says it isn't set up. */
  OPS_RESOURCES?: string;
  /** `on` adds a daily rotating, salted hash to browser pings and opens the admin Visitors tab
   * (site-visitors.ts); set on both Workers. */
  VISITORS?: string;
  /** `on` records a new account's region and samples where writes come from (region.ts). */
  REGION_SIGNALS?: string;
  /** `on`: requests find their cell, and a Worker forwards what is another's (cells.ts). Unset or
   * anything else: this Worker serves everything it is sent, as ever. */
  CELLS?: string;
  /** `on`: default HTTP entries select an API execution Worker from trusted client geography. */
  REGIONAL_API?: string;
  /** Configured execution identity; separate from the repository authority's CELL. */
  API_REGION?: string;
  API_ENAM?: Fetcher;
  API_WEUR?: Fetcher;
  API_APAC?: Fetcher;
  API_OC?: Fetcher;
  API_SAM?: Fetcher;
  API_AFR?: Fetcher;
  /** The cell this Worker is; unset: `enam`, today's stack. */
  CELL?: string;
  /** A cell's own object namespaces are restricted to this jurisdiction (cell-env.ts). */
  CELL_JURISDICTION?: string;
  /** A new account authority's location hint in this cell (cell-env.ts). */
  CELL_HINT?: string;
  /** The other cells' platform Workers. */
  CELL_ENAM?: Fetcher;
  CELL_WEUR?: Fetcher;
  /** The other cells' D1, for the rows that name no repository: personal tokens' look-ups and
   * an older account's handle. */
  INDEX_ENAM?: D1Database;
  INDEX_WEUR?: D1Database;
  /** `on`: a create may ask for a location hint (repo-region-hint.ts). Dev only, for the latency
   * matrix; off or unset, a create ignores it. */
  REGION_HINT_TEST?: string;
  /** Cloudflare Web Analytics site token (front Worker); set, public pages carry its beacon. */
  WEB_ANALYTICS_TOKEN?: string;
  /** Immutable browser cache for fingerprinted public build assets only. */
  STATIC_ASSET_CACHE?: string;
  /** Site traffic reports (platform Worker, platform-site-traffic.ts): the account and dataset the
   * Analytics Engine SQL API reads, with an Account Analytics Read token; any unset, none. The
   * same token reads Web Analytics for WEB_ORIGIN's host (platform-web-analytics.ts). */
  CF_ACCOUNT_ID?: string;
  SITE_EVENTS_DATASET?: string;
  ANALYTICS_READ_TOKEN?: string;
  /** `on` lets search engines index this environment (production only; seo-files.ts). */
  SEO_INDEXING?: string;
  /** `on` serves a generic noindex repository shell for account-cookie requests without
   * waiting for optional public metadata. API authorization is unchanged. */
  FAST_APP_HEAD?: string;
  /** This Worker itself (service binding); the SSH gateway's container reaches the
   * platform through it (platform-ssh-gateway.ts). */
  SELF?: Fetcher;
  /** Shared with the SSH gateway: signs its JWTs to `/internal/ssh/*` and derives the
   * session-token key (platform-ssh.ts). Unset, or under 32 characters: SSH is off. */
  SSH_GATEWAY_SECRET?: string;
  /** The gateway's SSH host keys (OpenSSH private key files), passed to its container. */
  SSH_HOST_ED25519_KEY?: string;
  SSH_HOST_ECDSA_KEY?: string;
  /** SSH gateway containers (platform-ssh-gateway.ts); absent where not deployed. */
  SSH_GATEWAYS?: DurableObjectNamespace<import('./platform-ssh-gateway').SshGateway>;
  /** Clone-pack builders, one container per repository (platform-pack-builder.ts); absent where not
   * deployed (then no pack is handed off or built by a job). */
  PACK_BUILDERS?: DurableObjectNamespace<import('./platform-pack-builder').PackBuilder>;
  /** How clients reach the SSH gateway: `tunnel` (Cloudflare Tunnel, cloudflared in its
   * container), `connect` (inbound TCP to this Worker, private beta) or `off`. */
  SSH_FRONT_DOOR?: string;
  /** The tunnel's token (secret; the `tunnel` front door). */
  SSH_TUNNEL_TOKEN?: string;
  /** The hostname clients use for Git over SSH (`ssh.yonedarepo.com`). */
  SSH_HOST?: string;
  BUILD_REVISION?: string;
  /** `on`: the request id goes on every response and travels with each hop (request-scope.ts;
   * unset or anything else: failure lines still carry it, nothing else changes). */
  REQUEST_IDS?: string;
  /** `on`: `POST /api/client-error` logs what browsers report (client-errors.ts; unset or
   * anything else: it answers 204 and does nothing). */
  CLIENT_ERRORS?: string;
  /** A number N: 1 request in N, and every slow one, keeps its Server-Timing phases as a log line
   * and one Analytics Engine point (repo-span-sample.ts); unset or `off`: nothing. */
  SPAN_SAMPLE?: string;
  /** `on`: the operations with service targets write a point each, reads 1 in 10, and the admin
   * page reads them back (shared/service-levels.ts); unset or anything else: nothing. */
  SERVICE_LEVELS?: string;
}
export type Principal = {
  workspace: string;
  role: 'user' | 'admin';
  /** Organizations the account joined (hints from its authority; they grant nothing). */
  orgs?: string[];
};
