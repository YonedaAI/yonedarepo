import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

const MAX_PREVIEW_FILE_BYTES = 256 * 1024;
const OWNER_SOURCE_LIMIT = '500 files / 8 MiB';

interface CapturedFile {
  content?: unknown;
  encoding?: string;
}
interface CapturedSource {
  identity: string;
  candidate_id: string;
  revision: { commit: string };
  files: Record<string, CapturedFile>;
  paths: string[];
  totalFiles: number;
}
interface SourceError {
  identity: string;
  message: string;
}

export function CandidateSourcePreview({
  repo,
  candidate,
}: {
  repo: string;
  candidate: Record<string, any>;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<CapturedSource | null>(null);
  const [error, setError] = useState<SourceError | null>(null);
  const [file, setFile] = useState<{ identity: string; path: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const identity = JSON.stringify([repo, candidate.id, candidate.revision?.commit]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const currentSource = source?.identity === identity ? source : null;
  const currentError = error?.identity === identity ? error.message : '';
  const selectedPath = file?.identity === identity ? file.path : '';

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry reloads this recorded candidate.
  useEffect(() => {
    if (!open || currentSource) return;
    let current = true;
    const candidateId = candidate.id;
    const expectedCommit = candidate.revision?.commit;
    const isCurrent = () => current && identityRef.current === identity;
    setError(null);
    if (typeof candidateId !== 'string' || typeof expectedCommit !== 'string') {
      setError({
        identity,
        message:
          'The recorded candidate identity is incomplete; captured source cannot be inspected.',
      });
      return;
    }
    void api<Record<string, any>>(
      `repos/${repo}/candidate_source?${new URLSearchParams({ id: candidateId })}`,
    )
      .then((result) => {
        if (!isCurrent()) return;
        if (
          result?.candidate_id !== candidateId ||
          result.revision?.commit !== expectedCommit ||
          !result.files ||
          typeof result.files !== 'object' ||
          Array.isArray(result.files)
        )
          throw new Error(
            'The source response does not match this captured candidate. No files were shown.',
          );
        const paths = Object.keys(result.files).sort();
        for (const path of paths) {
          if (
            !path ||
            path.startsWith('/') ||
            path.includes('\\') ||
            path.split('/').includes('..')
          )
            throw new Error(
              'The captured source contains an unsupported file path. No files were shown.',
            );
        }
        const changedPaths = Array.isArray(candidate.paths)
          ? candidate.paths.filter(
              (path: unknown) => typeof path === 'string' && paths.includes(path),
            )
          : [];
        setSource({
          identity,
          candidate_id: candidateId,
          revision: { commit: expectedCommit },
          files: result.files as Record<string, CapturedFile>,
          paths,
          totalFiles: paths.length,
        });
        setFile({ identity, path: changedPaths[0] ?? paths[0] ?? '' });
      })
      .catch((failure: unknown) => {
        if (!isCurrent()) return;
        const detail = failure instanceof Error ? failure.message : '';
        const message = /exceeds MVP limit|(?:500\s*files|8\s*MiB)/i.test(detail)
          ? `Captured source exceeds the owner API limit of ${OWNER_SOURCE_LIMIT}. No source files were shown.`
          : /symlink|submodule|regular files/i.test(detail)
            ? `The owner API cannot preview this capture because it contains unsupported Git entries. No source files were shown. (${detail})`
            : detail || 'Captured source could not be read. No files were shown.';
        setError({ identity, message });
      });
    return () => {
      current = false;
    };
  }, [open, currentSource, retry, identity, repo, candidate.id, candidate.revision?.commit]);

  const selected = currentSource?.files[selectedPath];
  const content = typeof selected?.content === 'string' ? selected.content : null;
  const tooLarge =
    content !== null && new TextEncoder().encode(content).byteLength > MAX_PREVIEW_FILE_BYTES;
  return (
    <details
      className="candidate-source-preview"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>View captured source (read-only)</summary>
      <p>
        The owner API is bounded to 500 files and 8 MiB. Select any captured path; only one file up
        to 256 KiB is displayed at a time.
      </p>
      {currentError ? (
        <div role="alert">
          <p>{currentError}</p>
          <button type="button" className="quiet" onClick={() => setRetry((value) => value + 1)}>
            Retry source
          </button>
        </div>
      ) : !currentSource ? (
        <p role="status">Loading exact captured source…</p>
      ) : !currentSource.paths.length ? (
        <p>No files were recorded in this candidate capture.</p>
      ) : (
        <>
          <label>
            Captured file
            <select
              value={selectedPath}
              onChange={(event) => setFile({ identity, path: event.target.value })}
            >
              {currentSource.paths.map((path) => (
                <option value={path} key={path}>
                  {path}
                </option>
              ))}
            </select>
          </label>
          <pre>
            {selected?.encoding === 'base64'
              ? 'This file is binary and cannot be shown as text.'
              : content === null
                ? 'Text content is unavailable for this captured file.'
                : tooLarge
                  ? 'This file exceeds the 256 KiB text preview limit; content was not rendered.'
                  : content}
          </pre>
        </>
      )}
    </details>
  );
}
