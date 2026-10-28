// Releases as the API answers them, their paths, and the asset upload (raw bytes, not JSON).
import { SourceApiError, sourceApi } from './sourceApi';

export type Release = {
  tag: string;
  title: string;
  notes: string;
  created_by: string;
  created_at: number;
  /** The tagged commit. */
  commit_id: string | null;
  asset_count: number;
};

export type ReleaseAsset = {
  name: string;
  size: number;
  sha256: string;
  content_type: string;
  uploaded_by: string;
  uploaded_at: number;
};

export type ReleaseDetail = Release & {
  assets: ReleaseAsset[];
  /** The tag object of an annotated tag; null for a lightweight tag. */
  annotated: {
    id: string;
    message: string;
    tagger: { name: string; email: string; time: number } | null;
  } | null;
};

export const releasesPath = (repo: string) => `/repos/${repo}/releases`;
export const releasePath = (repo: string, tag: string) =>
  `${releasesPath(repo)}/${encodeURIComponent(tag)}`;
/** Where an asset downloads (the session cookie authorizes it). */
export const assetHref = (repo: string, tag: string, name: string) =>
  `/api/v1${releasePath(repo, tag)}/assets/${encodeURIComponent(name)}`;

/** Tag names (without `refs/tags/`) among a refs answer, sorted. */
export function tagNames(refs: Record<string, string> | undefined): string[] {
  return Object.keys(refs ?? {})
    .filter((name) => name.startsWith('refs/tags/'))
    .map((name) => name.slice('refs/tags/'.length))
    .sort();
}

/** A file name the server accepts as an asset name (letters, digits, `._-+`). */
export function assetName(file: string): string {
  const safe = file.replace(/[^A-Za-z0-9._+-]+/g, '-').replace(/^\.+/, '');
  return (safe || 'asset').slice(0, 200);
}

export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** Publishes a release for an existing tag (POST /releases). */
export function publishRelease(
  repo: string,
  form: { tag: string; title: string; notes: string },
): Promise<Release> {
  return sourceApi<Release>(releasesPath(repo), {
    body: { tag: form.tag, title: form.title.trim(), notes: form.notes.trim() },
  });
}

/** PUTs `file` as asset `name` of the release for `tag`. */
export async function uploadAsset(
  repo: string,
  tag: string,
  name: string,
  file: Blob,
): Promise<ReleaseAsset> {
  const response = await fetch(assetHref(repo, tag, name), {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
    credentials: 'same-origin',
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new SourceApiError(
      value.error?.code ?? 'REQUEST_FAILED',
      value.error?.message ?? `Upload failed (${response.status})`,
      response.status,
    );
  return value as ReleaseAsset;
}
