// Shared request identities and queue envelopes, independent of Worker bindings.
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
  observation?: import('./operation-carrier').OperationCarrier;
  parent_span_id?: string;
  origin_route?: string;
  origin_source?: string;
  /** Intentional producer delay; monitoring subtracts it from enqueue age. */
  queue_delay_ms?: number;
};
export type Principal = {
  workspace: string;
  role: 'user' | 'admin';
  /** Organizations the account joined (hints from its authority; they grant nothing). */
  orgs?: string[];
};
