export type Json = Record<string, any>;
export type Envelope = {
  v: 1;
  repo_id: string;
  job_id: string;
  kind: string;
  workspace?: string;
  /** An account email job's confirmation token (platform-email-verify.ts); never logged. */
  token?: string;
};
export interface Env {
  WORKSPACES: DurableObjectNamespace;
  /** Source platform authority: one SourceRepository per repository. */
  SOURCE_REPOS: DurableObjectNamespace;
  /** Commit shards (platform write path); absent where not yet deployed. */
  COMMIT_SHARDS?: DurableObjectNamespace;
  /** Land combiners, one per branch (platform write path); absent where not deployed. */
  LAND_COMBINERS?: DurableObjectNamespace;
  /** Landing mode: batch (default) or changeset (see repo-changesets.ts). */
  LAND_MODE?: string;
  /** "true" lets a request choose its landing mode (x-yoneda-land-mode), for benchmarks. */
  LAND_MODE_OVERRIDE?: string;
  /** Platform check executors (one fresh container per run attempt). */
  CHECK_RUNNERS: DurableObjectNamespace<import('./check-container').CheckContainer>;
  OBJECT_PUSHES: DurableObjectNamespace<import('./repo-push-queue').ObjectPushQueue>;
  /** Platform jobs (projection, derived data, webhooks, purges). */
  PLATFORM_QUEUE: Queue<Envelope>;
  /** Check runs on their own queue (minutes each), so they never hold derive and
   * projection jobs' consumer slots; absent where not deployed (PLATFORM_QUEUE then). */
  PLATFORM_CHECKS?: Queue<Envelope>;
  /** This account's workers.dev subdomain: its Workers are never webhook targets (without
   * it, no workers.dev host is). */
  WORKERS_SUBDOMAIN?: string;
  /** Basin Pipelines stream for change-log analytics (platform-dev only; optional). */
  CHANGELOG?: { send(records: import('./repo-changelog').ChangeEvent[]): Promise<void> };
  /** Durable imports of external Git repositories into the source platform. */
  PLATFORM_IMPORT: Workflow<import('./repo-import').ImportParams>;
  OBJECTS: R2Bucket;
  /** R2's S3 API for Git LFS presigned URLs (repo-lfs.ts): `https://<account>.r2.cloudflarestorage.com`,
   * the OBJECTS bucket's name, and an R2 API token's S3 key pair (secrets). LFS answers 501
   * where any is missing. */
  LFS_S3_ENDPOINT?: string;
  LFS_S3_BUCKET?: string;
  LFS_S3_ACCESS_KEY_ID?: string;
  LFS_S3_SECRET_ACCESS_KEY?: string;
  INDEX: D1Database;
  ARTIFACTS: Artifacts;
  /** Public downloads: CLI releases and the Claude Code marketplace (front Worker only). */
  DOWNLOADS?: R2Bucket;
  ASSETS: Fetcher;
  /** The platform's own review-model key (model checks); never an agent-layer key. */
  REVIEW_MODEL_KEY?: { get(): Promise<string> };
  AUTH_LIMITER?: RateLimit;
  /** Sign-in with GitHub / Google (oauth.ts): each provider is on only while both of its
   * secrets are set; otherwise its routes answer 404 and the sign-in page hides it. */
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
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
  /** Operators: accounts (comma separated) whose browser sessions may use the admin pages
   * and `/api/v1/admin` (admin-auth.ts). Unset or empty: none. */
  ADMIN_ACCOUNTS?: string;
  /** The managed agents Worker's admin bearer (platform Worker), for the admin pages' credit
   * grants and balances over MANAGED; unset: those answer as unavailable. */
  MANAGED_ADMIN_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ARTIFACTS_NAMESPACE: string;
  /** `r2` stores new source-platform repositories' Git objects in R2 (local development). */
  PLATFORM_OBJECT_STORE?: string;
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
  /** The website people sign in at (device approval page `/device`); the platform falls
   * back to the request origin. */
  WEB_ORIGIN?: string;
  /** The source platform Worker (front Worker); its public API is all it calls. */
  PLATFORM?: Fetcher;
  /** The managed agents Worker: the front Worker proxies `/api/managed/*` to it; the
   * platform Worker grants and reads credit through its admin routes (admin pages). */
  MANAGED?: Fetcher;
  PUBLIC_APP_ORIGIN?: string;
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
}
export type Principal = {
  workspace: string;
  role: 'user' | 'admin';
  /** Organizations the account joined (hints from its authority; they grant nothing). */
  orgs?: string[];
};
