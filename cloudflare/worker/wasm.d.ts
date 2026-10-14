declare module '*.mjs' { export const RepositoryAuthority: any; export const LiveRoom: any; export const WorkspaceAuthority: any; }
declare module '*.mjs' {
  export const SourceWorkspaceAuthority: typeof import('cloudflare:workers').DurableObject;
}
