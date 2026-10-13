//! Narrow, server-trusted app authority contract; HTTP callers never choose object digests.
export interface AppManifest {
  version: 1;
  entrypoint: string;
  export_name: string;
  migrations: { version: number; sql: string[] }[];
  seed: string[];
}
export interface AppBundle {
  version: 1;
  revision: string;
  policy_digest: string;
  manifest: AppManifest;
  modules: Record<string, string>;
}
export interface TrustedApp {
  app_id: string;
  revision: string;
  policy_digest: string;
  bundle_digest: string;
  mode: 'preview' | 'published';
  /** Monotonic publication version supplied by the authoritative platform. */
  generation: number;
}
export interface AppPlatform {
  authorizeAppPreview(previewId: string, token: string): Promise<TrustedApp | null>;
  publishedApp(slug: string): Promise<TrustedApp | null>;
}
export interface RunnerEnv {
  OBJECTS: R2Bucket;
  LOADER: WorkerLoader;
}
