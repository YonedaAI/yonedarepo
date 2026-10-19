declare module '*.mjs' { export const RepositoryAuthority: any; export const LiveRoom: any; export const WorkspaceAuthority: any; }
declare module '*.mjs' {
  export const SourceWorkspaceAuthority: typeof import('cloudflare:workers').DurableObject;
  export const SourceRepository: typeof import('cloudflare:workers').DurableObject;
  const RustWorker: unknown;
  export default RustWorker;
}
