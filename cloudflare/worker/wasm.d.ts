declare module '*.mjs' { export const WorkspaceAuthority: any; }
declare module '*.mjs' {
  export const SourceRepository: typeof import('cloudflare:workers').DurableObject;
  export const CommitShard: typeof import('cloudflare:workers').DurableObject;
  const RustWorker: unknown;
  export default RustWorker;
}
