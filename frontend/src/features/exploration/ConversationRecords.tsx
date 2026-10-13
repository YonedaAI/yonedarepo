import type { Snapshot } from '../../lib/types';
import type { PeerMessage } from './conversationPager';

export function ConversationRecords({
  items,
  snapshot,
  run,
  onContext,
}: {
  items: PeerMessage[];
  snapshot: Snapshot;
  run: Record<string, any>;
  onContext: () => void;
}) {
  function participant(id: string) {
    if (id === 'team') return 'The team';
    if (id === 'coordinator') return 'The coordinator';
    const execution = snapshot.executions.find((item) => item.run_id === run.id && item.id === id);
    const task = (snapshot.team_tasks ?? []).find(
      (item) =>
        item.run_id === run.id &&
        (item.task_id === id || item.execution_id === id || item.task_id === execution?.team_task),
    );
    return (
      task?.title ||
      execution?.strategy ||
      (execution?.team_role ? `Team ${execution.team_role}` : 'Unlisted participant')
    );
  }
  return (
    <>
      <p className="subtle">
        Messages are agent assertions. Delivery and acknowledgement do not prove understanding or
        agreement.
      </p>
      <ol className="agent-conversation-records">
        {items.map((message) => (
          <li key={message.id}>
            <p className="conversation-participants">
              <strong>
                {participant(message.sender)} → {participant(message.recipient)}
              </strong>
            </p>
            <p className="subtle">
              {message.kind[0].toUpperCase() + message.kind.slice(1)} · Agent assertion
            </p>
            <p className="conversation-body">{message.body}</p>
            {!!message.context_ids.length && (
              <ul className="conversation-context">
                {message.context_ids.map((id) => (
                  <li key={id}>
                    <button type="button" className="text-button" onClick={onContext}>
                      Referenced context:{' '}
                      {(run.context_records ?? []).find((item: any) => item.id === id)?.label ||
                        snapshot.nodes.find((item) => item.id === id)?.label ||
                        'Recorded context'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="subtle">
              {message.delivery_receipts.delivered}{' '}
              {message.delivery_receipts.delivered === 1 ? 'delivery' : 'deliveries'} ·{' '}
              {message.delivery_receipts.acknowledged}{' '}
              {message.delivery_receipts.acknowledged === 1
                ? 'acknowledgement'
                : 'acknowledgements'}
            </p>
          </li>
        ))}
      </ol>
    </>
  );
}
