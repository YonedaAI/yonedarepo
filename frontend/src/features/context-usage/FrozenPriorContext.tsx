import { useId } from 'react';
import type { ContextUsage } from '../../../../shared/context_usage';
import type { Snapshot } from '../../lib/types';
import { ContextRecordBody } from './ContextRecordBody';
import { contextActivity, contextRelations, frozenInputs } from './frozenContextView';
import { LinkedContextRecord } from './LinkedContextRecord';
import '../../styles/frozen-context.css';

export function FrozenPriorContext({
  snapshot,
  run,
  data,
  labels,
}: {
  snapshot: Snapshot;
  run: Record<string, any>;
  data: ContextUsage | null;
  labels: Map<string, string>;
}) {
  const prefix = useId();
  const inputs = frozenInputs(run);
  const anchor = (id: string) => `${prefix}-prior-${id}`;
  const agentNames = (ids: string[]) => ids.map((id) => labels.get(id) ?? id).join(', ');
  return (
    <section className="prior-context" aria-labelledby={`${prefix}-heading`}>
      <h3 id={`${prefix}-heading`}>Frozen prior context</h3>
      <p className="context-usage-note">
        Read the prior requirements, constraints and decisions supplied when this work started.
        These are recorded inputs; their effect on a bug fix or feature is unmeasured.
      </p>
      {!inputs.ids.length ? (
        <p className="context-usage-empty">
          No prior context records were frozen into this run’s initial input.
        </p>
      ) : (
        <>
          <p className="context-usage-note">
            Assigned lists agents in this run. Opened shows retrieval evidence on the current page
            and filters. Cited shows explicit references included in this response. Earlier or
            other-page access may be unavailable.
          </p>
          <ul className="prior-context-records">
            {inputs.ids.map((id) => {
              const record = inputs.records.get(id);
              const activity = contextActivity(id, snapshot, run.id, data);
              return (
                <li key={id} id={anchor(id)}>
                  {record ? (
                    <ContextRecordBody record={record} />
                  ) : (
                    <>
                      <p className="prior-context-statement">
                        Frozen statement unavailable for <code>{id}</code>.
                      </p>
                      <p className="context-usage-note">
                        The initial input records this ID. Current source can be read separately.
                      </p>
                      <LinkedContextRecord repo={snapshot.repository.id} id={id} label={id} />
                    </>
                  )}
                  <dl className="prior-context-activity">
                    <div>
                      <dt>Assigned</dt>
                      <dd>
                        {agentNames(activity.assigned) ||
                          'Frozen run input; agent assignment unavailable'}
                      </dd>
                    </div>
                    <div>
                      <dt>Opened</dt>
                      <dd>
                        {agentNames(activity.opened) ||
                          (activity.loaded
                            ? 'Not shown on this page'
                            : 'Retrieval evidence pending')}
                      </dd>
                    </div>
                    <div>
                      <dt>Cited</dt>
                      <dd>
                        {agentNames(activity.cited) ||
                          (activity.loaded
                            ? 'No citation included in this response'
                            : 'Citation evidence pending')}
                      </dd>
                    </div>
                  </dl>
                  {record && contextRelations(record).length > 0 && (
                    <div className="prior-context-relations">
                      <strong>Recorded relations</strong>
                      <ul>
                        {contextRelations(record).map((link) => (
                          <li key={`${link.relation}:${link.target}`}>
                            <span>{link.relation} </span>
                            {inputs.records.has(link.target) ? (
                              <a href={`#${encodeURIComponent(anchor(link.target))}`}>
                                {inputs.records.get(link.target)?.label || link.target}
                              </a>
                            ) : (
                              <LinkedContextRecord
                                repo={snapshot.repository.id}
                                id={link.target}
                                label={
                                  snapshot.nodes.find((node) => node.id === link.target)?.label ||
                                  link.target
                                }
                              />
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
