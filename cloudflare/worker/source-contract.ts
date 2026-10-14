/** Source API v1 wire types; source state never confers checked or published authority. */
export type SourceRevision = { repository: string; commit: string; tree: string };
export type GitContent = {
  kind: 'git';
  repository: string;
  commit: string;
  blob: string;
  path: string;
};
export type R2Content = {
  kind: 'r2';
  key: string;
  sha256: string;
  size: number;
  ticket_id: string;
};
export type SourceContent = GitContent | R2Content;
export type SourceFile = {
  path: string;
  mode: '100644' | '100755';
  size: number;
  content: SourceContent;
};
export type SourceView = { version: 1; base: SourceRevision; files: SourceFile[] };
export type SourceOverride = { path: string; file: SourceFile | null };
export type SourceMount = 'repo' | 'candidate-0' | 'candidate-1';
export type SourceRole =
  | 'builder'
  | 'specialist'
  | 'integrator'
  | 'repair'
  | 'reviewer'
  | 'planner'
  | 'coordinator'
  | 'evaluator';
export type SourceBinding = {
  version: 1;
  transport: 'api-source-v1';
  workspace_id: string;
  repo_id: string;
  run_id: string;
  job_id: string;
  epoch: number;
  execution_id: string;
  role: SourceRole;
  access: 'read_only' | 'read_write';
  view_digest: string;
  baseline_overrides_digest: string;
  base: SourceRevision;
  parents: string[];
  policy_digest: string;
  intent_digest: string;
  write_paths: string[];
  protected_paths: string[];
  scratch_paths: string[];
  inputs: SourceRevision[];
  repo_base_version: number;
  working_branch_id: string | null;
  working_branch_version: number | null;
};
export type SourceActorClaims = {
  version: 1;
  workspace_id: string;
  binding_digest: string;
  repo_id: string;
  run_id: string;
  job_id: string;
  epoch: number;
  execution_id: string;
  view_digest: string;
  role: SourceRole;
  access: 'read_only' | 'read_write';
  purpose: 'source' | 'supervisor';
  expires_at: number;
};
export type SourceActor = { claims: SourceActorClaims; signature: string };
export type SourceContext = {
  binding: SourceBinding;
  view?: SourceView;
  baseline_overrides?: SourceOverride[];
  actor: SourceActor;
  mount: SourceMount;
};
export type SourceFileStat = SourceFile & { kind: 'file'; exists: true; file_version: number };
export type SourceRead = {
  version: 1;
  workspace_id: string;
  workspace_version: number;
  file: SourceFileStat;
  content: SourceContent;
  offset: number;
  length: number;
};
export type SourceTicket = {
  id: string;
  key: string;
  path: string;
  sha256: string;
  size: number;
  mode: '100644' | '100755';
  state: 'issued' | 'verified' | 'committed' | 'gc_pending' | 'deleted';
  expires_at: number;
};
export type SourceIndexEnvelope = {
  v: 1;
  version: 1;
  kind: 'source_index';
  repo_id: string;
  job_id: string;
  mount: SourceMount;
  revision: SourceRevision;
};
export type SourceReadContext = {
  version: 1;
  transport: 'api-source-v1';
  repo_id: string;
  run_id: string;
  job_id: string;
  epoch: number;
  status: string;
  execution_id: string;
  role: SourceRole;
  access: 'read_only' | 'read_write';
  source_resolution?: boolean;
  base: SourceRevision;
  inputs: SourceRevision[];
  parents: string[];
  write_paths: string[];
  protected_paths: string[];
  policy_digest: string;
  intent_digest: string;
  repo_base_version: number;
  working_branch_id: string | null;
  working_branch_version: number | null;
  plan_version: number | null;
  task_version: number | null;
  baseline_inputs?: { revision: SourceRevision; tree: string; paths: string[] }[];
  bindings?: SourceBinding[];
  source_mounts?: { path: string; base: SourceRevision }[];
};
export type SourceGcGrant = {
  claims: {
    version: 1;
    workspace_id: string;
    binding_digest: string;
    repo_id: string;
    expires_at: number;
    purpose: 'gc';
  };
  signature: string;
};
export type SourceGcDue = {
  version: 1;
  workspace_id: string;
  repo_id: string;
  binding_digest: string;
  tickets: {
    id: string;
    key: string;
    state: string;
    expires_at: number;
    gc_token: string | null;
  }[];
  gc_grant: SourceGcGrant;
  next_due_at: number | null;
};
export const SOURCE_LIMITS = {
  files: 10000,
  bytes: 100 * 1024 * 1024,
  fileBytes: 32 * 1024 * 1024,
  readBytes: 65536,
  page: 200,
} as const;

export const sourceError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });
