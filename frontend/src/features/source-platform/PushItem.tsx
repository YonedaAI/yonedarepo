import type { ConversationItem } from './changeModel';
import { usePeople } from './people';
import { shortSha, when } from './sourceApi';

const PUSHED = { created: 'pushed the branch', moved: 'pushed', deleted: 'deleted the branch' };

/** One branch push: who, what it moved the branch to and when. */
export function PushItem({
  push,
  onCommit,
}: {
  push: Extract<ConversationItem, { kind: 'push' }>['push'];
  onCommit?: (sha: string) => void;
}) {
  const people = usePeople();
  return (
    <p className="source-push source-meta">
      {people.principal(push.actor)} {PUSHED[push.action]}
      {push.after && (
        <>
          {' '}
          <a
            href={`#${push.after}`}
            onClick={(e) => {
              e.preventDefault();
              onCommit?.(push.after as string);
            }}
          >
            <code>{shortSha(push.after)}</code>
          </a>
        </>
      )}{' '}
      · v{push.version} · {when(push.at)}
    </p>
  );
}
