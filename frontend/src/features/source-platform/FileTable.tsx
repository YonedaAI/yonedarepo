// A directory as a table: name, the last change's message and its age; folders first.
// Up and Down move between the name links (Home and End to the ends).
import { File, Folder, FolderUp, Link2 } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { type Activity, ago, sortEntries } from './fileActivity';

export type TreeEntry = { name: string; type: string; id: string };

function moveFocus(event: KeyboardEvent<HTMLTableSectionElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const links = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-entry]')];
  const at = links.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? links.length - 1
        : Math.min(links.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)));
  links[next]?.focus();
}

export function FileTable({
  dir,
  entries,
  activity,
  messages,
  now = Date.now(),
  link,
  commitLink,
}: {
  dir: string;
  entries: TreeEntry[];
  activity: Map<string, Activity>;
  /** First lines of commit messages, by commit id, as they load. */
  messages: Map<string, string>;
  now?: number;
  /** A link to a path in this directory listing ('' is the root). */
  link: (
    path: string,
    children: ReactNode,
    attrs: { 'data-entry': true; className: string },
  ) => ReactNode;
  commitLink: (commit: string, children: ReactNode) => ReactNode;
}) {
  const parent = dir.split('/').slice(0, -1).join('/');
  const full = (name: string) => (dir ? `${dir}/${name}` : name);
  return (
    <div className="source-table-wrap">
      <table className="file-table" aria-label={dir ? `Files in ${dir}` : 'Files'}>
        <thead className="sr-only">
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Last change</th>
            <th scope="col">Age</th>
          </tr>
        </thead>
        <tbody onKeyDown={moveFocus}>
          {dir && (
            <tr>
              <td colSpan={3}>
                {link(
                  parent,
                  <>
                    <FolderUp size={15} aria-hidden="true" />
                    <span>..</span>
                    <span className="sr-only"> (parent directory)</span>
                  </>,
                  { 'data-entry': true, className: 'file-label' },
                )}
              </td>
            </tr>
          )}
          {sortEntries(entries).map((entry) => {
            const last = activity.get(entry.name);
            const Icon = entry.type === 'tree' ? Folder : entry.type === 'gitlink' ? Link2 : File;
            const label = (
              <>
                <Icon size={15} aria-hidden="true" className={`file-icon-${entry.type}`} />
                <span>{entry.name}</span>
              </>
            );
            return (
              <tr key={entry.name}>
                <td className="file-name">
                  {entry.type === 'gitlink' ? (
                    <span className="file-label" title="Submodule (not browsable)">
                      {label}
                    </span>
                  ) : (
                    link(full(entry.name), label, { 'data-entry': true, className: 'file-label' })
                  )}
                </td>
                <td className="file-message">
                  {last &&
                    commitLink(last.commit, messages.get(last.commit) ?? last.commit.slice(0, 10))}
                </td>
                <td className="file-age">
                  {last && (
                    <time dateTime={new Date(last.at).toISOString()}>{ago(last.at, now)}</time>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
