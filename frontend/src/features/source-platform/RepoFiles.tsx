// The Code tab: branch or tag, path, version (time travel) and Clone; the latest commit; the
// directory as a file table with its README below, or one file with blame.
import { type ReactNode, useState } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { BranchPicker, CloneButton, LatestCommit } from './CodeParts';
import { readQuery, useActivity, useCommitMessages, useListing } from './codeData';
import { currentApiOrigin } from './connect';
import { FileBlame } from './FileBlame';
import { FileTable } from './FileTable';
import { Markdown } from './markdown';
import type { RepoStatus } from './repoStatus';
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
}: {
  route: Route;
  status?: RepoStatus;
  navigate: Navigate;
}) {
  const ref = apiRef(route.ref, status?.refs);
  const listing = useListing(route.repo, ref, route.path, route.at);
  const [blaming, setBlaming] = useState(false);
  const tree = listing.value?.kind === 'tree' ? listing.value : undefined;
  const activity = useActivity(
    route.repo,
    status?.version,
    route.ref,
    route.path,
    tree?.entries.map((e) => e.name),
    route.at,
  );
  const messages = useCommitMessages(
    route.repo,
    [...activity.values()].map((a) => a.commit),
  );
  const go = (path: string): SourceRoute => ({ ...route, path });
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
          onChange={(next) => navigate({ ...route, ref: next, path: '', at: undefined })}
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
          <VersionPicker
            repo={route.repo}
            at={route.at}
            onChange={(at) => navigate({ ...route, at })}
          />
          <a className="toolbar-link" {...linkTo({ ...route, view: 'overview' }, navigate)}>
            Overview
          </a>
          <CloneButton repo={route.repo} name={status?.name} origin={currentApiOrigin()} />
        </span>
      </div>
      {route.at !== undefined && (
        <p className="source-note" role="status">
          Time travel: showing {route.ref} as of log version {route.at}. Reads are pinned and
          immutable. <a {...linkTo({ ...route, at: undefined }, navigate)}>Back to latest</a>
        </p>
      )}
      {listing.error && <Failure error={listing.error} onRetry={listing.reload} />}
      {listing.empty && (
        <div className="source-empty-state">
          <p>
            {route.path
              ? `${route.path} does not exist ${route.at === undefined ? `on ${route.ref}` : 'at this version'}.`
              : `${route.ref} has no commits${route.at === undefined ? ' yet' : ' at this version'}.`}
          </p>
          {route.path ? (
            pathLink('', 'Go to the repository root')
          ) : (
            <p className="source-meta">
              Push a first commit: <code>git push origin main</code> (see Clone).
            </p>
          )}
        </div>
      )}
      {!listing.value && !listing.error && !listing.empty && <Loading what="files" />}
      {listing.value && route.at === undefined && (
        <LatestCommit repo={route.repo} commit={listing.value.commit} commitLink={commitLink} />
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
              messages={messages}
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
            <pre>{listing.value.content}</pre>
          ) : (
            <p className="source-empty">Binary file not shown.</p>
          )}
        </article>
      )}
    </section>
  );
}
