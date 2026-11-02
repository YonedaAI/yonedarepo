// The Code tab: branch or tag, path, version (time travel) and Clone; the latest commit; the
// directory as a file table with its README below, or one file with blame.
import { type ReactNode, useState } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { linkTo, type Navigate } from '../shell/useRoute';
import { BranchPicker, CloneButton, LatestCommit } from './CodeParts';
import { CommitFile } from './CommitFile';
import { readQuery, useActivity, useListing } from './codeData';
import { currentApiOrigin } from './connect';
import { FileBlame } from './FileBlame';
import { FileTable } from './FileTable';
import { FileText } from './FileText';
import { Markdown } from './markdown';
import { canMoveBranches, type RepoStatus } from './repoStatus';
import { Failure, Loading } from './SourceStatus';
import type { SourceRoute } from './sourceRoute';
import { useSource } from './useSource';
import { VersionPicker } from './VersionPicker';

type Route = Extract<SourceRoute, { view: 'files' }>;
const README = /^readme(\.(md|markdown))?$/i;

/** The ref the API reads: a branch name, or a tag's commit (tags never move). */
export function apiRef(ref: string, refs: RepoStatus['refs'] | undefined): string | undefined {
  if (!ref.startsWith('refs/tags/')) return ref;
  return refs?.find((r) => r.name === ref)?.commit_id;
}

function Readme({ repo, ref, path, at }: { repo: string; ref: string; path: string; at?: number }) {
  const file = useSource<{ encoding: string; content: string }>(
    `/repos/${repo}/blob?${readQuery(ref, path, at)}`,
  );
  if (file.error) return <Failure error={file.error} onRetry={file.reload} />;
  if (!file.data) return <Loading what="README" />;
  if (file.data.encoding !== 'utf-8') return null;
  return (
    <article className="source-file readme" aria-label={path}>
      <header>
        <code>{path.split('/').pop()}</code>
      </header>
      <div className="readme-body">
        <Markdown source={file.data.content} />
      </div>
    </article>
  );
}

export function RepoFiles({
  route,
  status,
  navigate,
  account,
}: {
  route: Route;
  status?: RepoStatus;
  navigate: Navigate;
  /** The signed-in account, named on a commit made here. */
  account?: string;
}) {
  const ref = apiRef(route.ref, status?.refs);
  // A line belongs to the file on screen: every link away leaves it behind.
  const { line, ...place } = route;
  const listing = useListing(route.repo, ref, route.path, route.at);
  const [blaming, setBlaming] = useState(false);
  // The place the form was opened on: moving to another closes it.
  const here = `${route.ref}:${route.path}`;
  const [writingAt, setWritingAt] = useState<string | null>(null);
  const writing = writingAt === here;
  const canCommit =
    canMoveBranches(status?.viewer) &&
    route.at === undefined &&
    !route.ref.startsWith('refs/tags/');
  const tree = listing.value?.kind === 'tree' ? listing.value : undefined;
  const activity = useActivity(route.repo, route.ref, route.path, Boolean(tree), route.at);
  const go = (path: string): SourceRoute => ({ ...place, path });
  const pathLink = (path: string, children: ReactNode, attrs = {}) => (
    <a {...attrs} {...linkTo(go(path), navigate)}>
      {children}
    </a>
  );
  const commitLink = (commit: string, children: ReactNode) => (
    <a {...linkTo({ view: 'commit', repo: route.repo, commit }, navigate)}>{children}</a>
  );
  const crumbs = route.path.split('/').filter(Boolean);
  const readme = tree?.entries.find((e) => e.type !== 'tree' && README.test(e.name));
  return (
    <section className="source-files" aria-label="Files">
      <div className="source-toolbar">
        <BranchPicker
          refs={status?.refs ?? []}
          value={route.ref}
          onChange={(next) => navigate({ ...place, ref: next, path: '', at: undefined })}
        />
        <nav aria-label="Path" className="source-crumbs">
          {pathLink('', <strong>{status?.name ?? route.repo}</strong>)}
          {crumbs.map((part, i) => (
            <span key={crumbs.slice(0, i + 1).join('/')}>
              <span aria-hidden="true">/</span>
              {i === crumbs.length - 1 ? (
                <span aria-current="page">{part}</span>
              ) : (
                pathLink(crumbs.slice(0, i + 1).join('/'), part)
              )}
            </span>
          ))}
        </nav>
        <span className="source-toolbar-end">
          {canCommit && tree && !writing && (
            <button type="button" className="quiet" onClick={() => setWritingAt(here)}>
              Add file
            </button>
          )}
          <VersionPicker
            repo={route.repo}
            at={route.at}
            onChange={(at) => navigate({ ...place, at })}
          />
          <CloneButton
            repo={route.repo}
            name={status?.name}
            origin={currentApiOrigin()}
            visibility={status?.visibility}
          />
        </span>
      </div>
      {route.at !== undefined && (
        <p className="source-note" role="status">
          Showing {route.ref} at version {route.at}.{' '}
          <a {...linkTo({ ...place, at: undefined }, navigate)}>Back to latest</a>
        </p>
      )}
      {listing.error && <Failure error={listing.error} onRetry={listing.reload} />}
      {listing.empty && status && (
        <EmptyState
          title={
            route.path
              ? `${route.path} does not exist ${route.at === undefined ? `on ${route.ref}` : 'at this version'}`
              : `${route.ref} has no commits${route.at === undefined ? ' yet' : ' at this version'}`
          }
          action={
            route.path && pathLink('', 'Go to the repository root', { className: 'button-link' })
          }
        >
          {!route.path && route.at === undefined && 'Push a first commit to see your code here.'}
        </EmptyState>
      )}
      {/* No files means little until the status says why: the repository may be importing. */}
      {!listing.value && !listing.error && (!listing.empty || !status) && <Loading what="files" />}
      {listing.value && route.at === undefined && (
        <LatestCommit repo={route.repo} commit={listing.value.commit} commitLink={commitLink} />
      )}
      {writing && listing.value && (
        <CommitFile
          repo={route.repo}
          place={{ from: route.ref, head: listing.value.commit, account }}
          dir={route.path}
          editing={
            listing.value.kind === 'file'
              ? { path: route.path, content: listing.value.content }
              : undefined
          }
          onCancel={() => setWritingAt(null)}
          onCommitted={(done, path) => {
            setWritingAt(null);
            navigate(
              done.change
                ? { view: 'change', repo: route.repo, number: done.change }
                : { ...place, ref: done.branch, path },
            );
          }}
        />
      )}
      {tree && (
        <>
          {tree.entries.length === 0 ? (
            <p className="source-empty">This directory is empty.</p>
          ) : (
            <FileTable
              dir={route.path}
              entries={tree.entries}
              activity={activity}
              link={pathLink}
              commitLink={commitLink}
            />
          )}
          {readme && ref && (
            <Readme
              repo={route.repo}
              ref={ref}
              path={route.path ? `${route.path}/${readme.name}` : readme.name}
              at={route.at}
            />
          )}
        </>
      )}
      {listing.value?.kind === 'file' && (
        <article className="source-file">
          <header>
            <code>{route.path}</code>
            <span>
              {listing.value.size} bytes{listing.value.executable ? ' · executable' : ''}
            </span>
            {canCommit && listing.value.encoding === 'utf-8' && !writing && (
              <button type="button" className="quiet" onClick={() => setWritingAt(here)}>
                Edit
              </button>
            )}
            {route.at === undefined && listing.value.encoding === 'utf-8' && ref && (
              <button
                type="button"
                className="quiet"
                aria-pressed={blaming}
                onClick={() => setBlaming((b) => !b)}
              >
                {blaming ? 'Hide blame' : 'Blame'}
              </button>
            )}
          </header>
          {blaming && route.at === undefined && ref ? (
            <FileBlame repo={route.repo} path={route.path} refName={ref} onNavigate={navigate} />
          ) : listing.value.encoding === 'utf-8' ? (
            <FileText content={listing.value.content} line={line} />
          ) : (
            <p className="source-empty">Binary file not shown.</p>
          )}
        </article>
      )}
    </section>
  );
}
