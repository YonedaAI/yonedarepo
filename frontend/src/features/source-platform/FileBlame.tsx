import { Failure, Loading } from './SourceStatus';
import { shortSha } from './sourceApi';
import type { SourceRoute } from './sourceRoute';
import { useSource } from './useSource';

type Line = { line: number; commit: string; text: string };

export function FileBlame({
  repo,
  path,
  refName,
  onNavigate,
}: {
  repo: string;
  path: string;
  refName: string;
  onNavigate: (r: SourceRoute) => void;
}) {
  const blame = useSource<{ lines: Line[] }>(
    `/repos/${repo}/blame?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(refName)}`,
  );
  if (blame.error) return <Failure error={blame.error} onRetry={blame.reload} />;
  if (!blame.data) return <Loading what="blame" />;
  return (
    <table className="source-patch" aria-label={`Blame of ${path}`}>
      <tbody>
        {blame.data.lines.map((l, i) => (
          <tr key={l.line}>
            <td className="source-line">
              {(i === 0 || blame.data?.lines[i - 1].commit !== l.commit) && (
                <a
                  href={`/source/${repo}/commit/${l.commit}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate({ view: 'commit', repo, commit: l.commit });
                  }}
                >
                  {shortSha(l.commit)}
                </a>
              )}
            </td>
            <td className="source-line">{l.line}</td>
            <td>{l.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
