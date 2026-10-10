import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

const MAX_PREVIEW_FILES = 2;
const MAX_PREVIEW_FILE_BYTES = 256 * 1024;

interface CapturedFile {
  content?: unknown;
  encoding?: string;
}
interface CapturedSource {
  candidate_id: string;
  revision: { commit: string };
  files: Record<string, CapturedFile>;
  paths: string[];
  totalFiles: number;
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
  const [error, setError] = useState('');
  const [file, setFile] = useState('');
  const [retry, setRetry] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry reloads this recorded candidate.
  useEffect(() => {
    if (!open || source) return;
    let current = true;
    setError('');
    const candidateId = candidate.id;
    const expectedCommit = candidate.revision?.commit;
    if (typeof candidateId !== 'string' || typeof expectedCommit !== 'string') {
      setError(
        'The recorded candidate identity is incomplete; captured source cannot be inspected.',
      );
      return;
    }
    void api<Record<string, any>>(
      `repos/${repo}/candidate_source?${new URLSearchParams({ id: candidateId })}`,
    )
      .then((result) => {
        if (!current) return;
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
        const previewPaths = paths.slice(0, MAX_PREVIEW_FILES);
        const previewFiles = Object.fromEntries(
          previewPaths.map((path) => [path, result.files[path] as CapturedFile]),
        );
        setSource({
          candidate_id: candidateId,
          revision: { commit: expectedCommit },
          files: previewFiles,
          paths: previewPaths,
          totalFiles: paths.length,
        });
        setFile(previewPaths[0] ?? '');
      })
      .catch((failure: unknown) => {
        if (current)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Captured source could not be read. No files were shown.',
          );
      });
    return () => {
      current = false;
    };
  }, [open, source, retry, repo, candidate.id, candidate.revision?.commit]);

  const selected = source?.files[file];
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
      <p>Source is resolved from this recorded candidate and capped at two preview files.</p>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" className="quiet" onClick={() => setRetry((value) => value + 1)}>
            Retry source
          </button>
        </div>
      ) : !source ? (
        <p role="status">Loading exact captured source…</p>
      ) : !source.paths.length ? (
        <p>No files were recorded in this candidate capture.</p>
      ) : (
        <>
          {source.totalFiles > MAX_PREVIEW_FILES && (
            <p role="status">
              Showing the first {MAX_PREVIEW_FILES} of {source.totalFiles} captured files.
            </p>
          )}
          <label>
            Captured file
            <select value={file} onChange={(event) => setFile(event.target.value)}>
              {source.paths.map((path) => (
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
