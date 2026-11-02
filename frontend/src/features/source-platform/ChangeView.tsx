// One change request: what it proposes, its gates and actions, its route, the conversation
// (comments and branch pushes) and the diff from the merge base with main, with threads on its lines.
import { useMemo, useState } from 'react';
import type { ChangeGates as Gates } from '../../../../shared/contracts/change-gates';
import type { Navigate } from '../shell/useRoute';
import { ChangeDiff } from './ChangeDiff';
import { ChangeGates } from './ChangeGates';
import { ChangeRoute } from './ChangeRoute';
import { ChangeSessions } from './ChangeSessions';
import { CommentItem, Composer, LineThread, postComment } from './ChangeThread';
import {
  type ChangeDetail,
  conversation,
  diffAnchors,
  groupComments,
  landingState,
} from './changeModel';
import { FlightPlanLine } from './FlightPlanLine';
import { Instruments, instrumentsKey } from './Instruments';
import { useLandingWatch } from './landingWatch';
import { MergeGates } from './MergeGates';
import { Person } from './Person';
import { PushItem } from './PushItem';
import { RebaseButton } from './RebaseButton';
import { ChangeStatusChip } from './RepoChanges';
import { useReadOnly } from './repoAccess';
import { Failure, Loading } from './SourceStatus';
import { shortSha, when } from './sourceApi';
import { formatSourceRoute } from './sourceRoute';
import { useSource } from './useSource';

export function ChangeView({
  repo,
  number,
  onBack,
  onCommit,
  onChanged,
  navigate,
}: {
  repo: string;
  number: number;
  onBack?: () => void;
  onCommit?: (sha: string) => void;
  onChanged?: () => void;
  /** Links the sessions behind the change's commits to their pages. */
  navigate?: Navigate;
}) {
  const detail = useSource<ChangeDetail>(`/repos/${repo}/changes/${number}?patch=1`);
  const gates = useSource<Gates>(`/repos/${repo}/changes/${number}/gates`);
  const readOnly = useReadOnly();
  const c = detail.data;
  const [reading, setReading] = useState(0);
  useLandingWatch(c?.status === 'open', gates, () => {
    detail.reload();
    setReading((n) => n + 1);
    onChanged?.();
  });
  const grouped = useMemo(
    () => c && groupComments(c.comments, c.head, diffAnchors(c.diff?.changes ?? [])),
    [c],
  );
  if (detail.error) return <Failure error={detail.error} onRetry={detail.reload} />;
  if (!c || !grouped) return <Loading what={`Landing #${number}`} />;
  const refresh = () => {
    detail.reload();
    gates.reload();
    onChanged?.();
  };
  const submit = (input: Parameters<typeof postComment>[2]) => postComment(repo, number, input);
  const items = conversation(grouped.general, c.timeline);
  const lineThreads = grouped.inline.size + grouped.outdated.length;
  return (
    <article className="source-change" aria-labelledby="change-title">
      {onBack && (
        <button type="button" className="quiet source-back" onClick={onBack}>
          ← All Landings
        </button>
      )}
      <header>
        <h2 id="change-title">
          {c.title} <span className="source-meta">#{c.number}</span>
        </h2>
        <p className="source-meta">
          <ChangeStatusChip status={c.status} state={landingState(c, gates.data)} />{' '}
          <Person principal={c.author} /> {c.status === 'open' ? 'proposes' : 'proposed'} landing{' '}
          <code>{c.branch}</code> on <code>{c.base}</code> · opened {when(c.created_at)}
          {c.head && (
            <>
              {' · head '}
              <a
                href={`#${c.head}`}
                onClick={(e) => {
                  e.preventDefault();
                  onCommit?.(c.head as string);
                }}
              >
                <code>{shortSha(c.head)}</code>
              </a>
            </>
          )}
        </p>
        {c.source_repo && (
          <p className="source-meta">
            from fork{' '}
            <a
              href={formatSourceRoute({
                view: 'history',
                repo: c.source_repo,
                ref: c.source_branch ?? 'main',
              })}
            >
              <code>
                {c.source_repo}:{c.source_branch}
              </code>
            </a>
          </p>
        )}
        {c.source_error && (
          <p role="alert" className="source-error">
            The fork branch's latest pushes could not be brought here: {c.source_error}
          </p>
        )}
        {c.body && <p className="source-change-body">{c.body}</p>}
        <FlightPlanLine plan={c.flight_plan} />
      </header>
      {c.instruments && (
        <Instruments key={instrumentsKey(c)} repo={repo} number={number} reading={reading} />
      )}
      {c.status === 'open' && <MergeGates gates={gates} />}
      <ChangeGates
        repo={repo}
        change={c}
        onChanged={refresh}
        onDeleted={() => {
          onChanged?.();
          onBack?.();
        }}
      />
      {!readOnly && c.status === 'open' && c.head && (
        <RebaseButton repo={repo} change={c} onChanged={refresh} />
      )}
      {navigate && (
        <ChangeRoute
          key={c.head}
          repo={repo}
          number={number}
          pushes={c.timeline}
          navigate={navigate}
          onCommit={onCommit}
        />
      )}
      {c.head && navigate && (
        <ChangeSessions
          repo={repo}
          head={c.head}
          base={c.diff?.base?.commit ?? null}
          navigate={navigate}
          onCommit={onCommit}
        />
      )}
      <section aria-labelledby="conversation-heading">
        <h3 id="conversation-heading">Conversation</h3>
        {items.length === 0 && <p className="source-empty">No comments yet.</p>}
        {items.map((item) =>
          item.kind === 'comment' ? (
            <CommentItem key={`c${item.comment.id}`} comment={item.comment} />
          ) : (
            <PushItem key={`p${item.push.version}`} push={item.push} onCommit={onCommit} />
          ),
        )}
        {lineThreads > 0 && (
          <p className="source-meta">
            {lineThreads} line thread{lineThreads === 1 ? '' : 's'}
            {grouped.outdated.length > 0 && `, ${grouped.outdated.length} outdated (below)`}.
          </p>
        )}
        <Composer label="Comment on this Landing" submit={submit} onDone={refresh} />
      </section>
      {grouped.outdated.length > 0 && (
        <section aria-labelledby="outdated-heading">
          <h3 id="outdated-heading">Outdated line threads</h3>
          {grouped.outdated.map((t) => (
            <LineThread
              key={`${t.anchor.commit}${t.anchor.side}${t.anchor.line}${t.anchor.path}`}
              thread={t}
              outdated
              submit={submit}
              onDone={refresh}
            />
          ))}
        </section>
      )}
      <section aria-labelledby="files-heading">
        <h3 id="files-heading">Files changed{c.diff ? ` (${c.diff.changes.length})` : ''}</h3>
        {c.diff ? (
          <ChangeDiff
            changes={c.diff.changes}
            head={c.status === 'open' ? c.head : null}
            threads={grouped.inline}
            classes={Object.fromEntries(
              (c.head_commit?.review_classes?.files ?? []).map((f) => [f.path, f.class]),
            )}
            submit={submit}
            onPosted={refresh}
          />
        ) : (
          <p className="source-empty">No diff: the Landing has no head commit.</p>
        )}
      </section>
    </article>
  );
}
