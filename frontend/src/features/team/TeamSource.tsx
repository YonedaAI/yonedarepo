import { useEffect, useState } from 'react';
import { api, short } from '../../lib/api';
import type { TeamRecord } from './teamView';

interface CapturedSource {
  revision: { commit: string };
  tree: string;
  files: Record<string, { content: string; encoding?: string }>;
}
export function TeamSource({ repo, run, task }: { repo: string; run: string; task: TeamRecord }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<CapturedSource>();
  const [error, setError] = useState('');
  const [file, setFile] = useState('');
  const [request, setRequest] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry requests the same captured version.
  useEffect(() => {
    if (!open) return;
    let current = true;
    setSource(undefined);
    setError('');
    void api<CapturedSource>(
      `repos/${repo}/team_source?${new URLSearchParams({ run_id: run, task_id: task.task_id })}`,
    )
      .then((result) => {
        if (!current) return;
        if (
          result.revision?.commit !== task.output?.revision?.commit ||
          result.tree !== task.output?.tree
        )
          throw new Error(
            'The returned source does not match this recorded task capture. Refresh before reviewing it.',
          );
        setSource(result);
        setFile(
          (task.output.paths ?? []).find((path: string) => Object.hasOwn(result.files, path)) ??
            Object.keys(result.files).sort()[0] ??
            '',
        );
      })
      .catch((failure) => {
        if (current) setError(failure.message);
      });
    return () => {
      current = false;
    };
  }, [open, repo, run, task.task_id, task.output?.revision?.commit, task.output?.tree, request]);
  const selected = source?.files[file];
  return (
    <details
      className="team-source"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Inspect captured task source</summary>
      <p>
        Read-only source at <code>{short(task.output?.revision?.commit)}</code>. This intermediate
        output has not received the final combined checks.
      </p>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button type="button" className="quiet" onClick={() => setRequest((value) => value + 1)}>
            Retry source
          </button>
        </>
      ) : !source ? (
        <p role="status">Loading exact captured source…</p>
      ) : !Object.keys(source.files).length ? (
        <p>No regular files were recorded in this capture.</p>
      ) : (
        <>
          <label>
            Captured source file
            <select value={file} onChange={(event) => setFile(event.target.value)}>
              {Object.keys(source.files)
                .sort()
                .map((path) => (
                  <option value={path} key={path}>
                    {path}
                  </option>
                ))}
            </select>
          </label>
          <pre>
            {selected?.encoding === 'base64'
              ? 'Binary file · content is not rendered.'
              : (selected?.content ?? 'Choose a captured file.')}
          </pre>
        </>
      )}
    </details>
  );
}
