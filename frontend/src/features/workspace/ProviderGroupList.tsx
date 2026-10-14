import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Provider } from './ProviderSettings';
import { type ProviderGroup, rowActionName } from './providerGroups';

/** Provider cards with one aligned row per connection; forms render inside their own card. */
export function ProviderGroupList({
  groups,
  busy,
  slot,
  onAddModel,
  onEdit,
  onDelete,
}: {
  groups: ProviderGroup[];
  busy: boolean;
  /** Inline form for the group currently being edited or extended. */
  slot: (group: ProviderGroup) => ReactNode;
  onAddModel: (source: Provider) => void;
  onEdit: (connection: Provider) => void;
  onDelete: (connection: Provider) => void;
}) {
  return (
    <div className="provider-groups">
      {groups.map((group) => {
        const count = `${group.rows.length} model${group.rows.length === 1 ? '' : 's'}`;
        return (
          <section
            key={group.key}
            className="provider-group"
            aria-label={`${group.name} connections`}
          >
            <header className="provider-group-heading">
              <div>
                <h3>{group.name}</h3>
                <small>
                  {group.route} · {count}
                </small>
              </div>
              {group.keySources.length === 1 ? (
                <button
                  type="button"
                  className="quiet"
                  disabled={busy}
                  aria-label={`Add model to ${group.name}`}
                  onClick={() => onAddModel(group.keySources[0])}
                >
                  <Plus size={15} aria-hidden="true" />
                  Add model
                </button>
              ) : (
                <details className="provider-add-menu">
                  <summary aria-label={`Add model to ${group.name}`}>
                    <Plus size={15} aria-hidden="true" />
                    Add model
                  </summary>
                  <div>
                    <p>Use the saved key from</p>
                    {group.keySources.map((source) => (
                      <button
                        key={source.id}
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={(event) => {
                          event.currentTarget.closest('details')?.removeAttribute('open');
                          onAddModel(source);
                        }}
                      >
                        {source.label}
                      </button>
                    ))}
                  </div>
                </details>
              )}
            </header>
            {slot(group)}
            <ul className="provider-rows">
              {group.rows.map((row) => (
                <li key={row.connection.id}>
                  <div className="provider-row-name">
                    <strong>{row.model}</strong>
                    <small>{row.hint ?? row.connection.label}</small>
                  </div>
                  {row.canEdit ? (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={rowActionName('Edit', row)}
                      title="Edit connection"
                      disabled={busy}
                      onClick={() => onEdit(row.connection)}
                    >
                      <Pencil size={16} aria-hidden="true" />
                    </button>
                  ) : (
                    <span className="provider-row-slot" aria-hidden="true" />
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={rowActionName('Delete', row)}
                    title="Delete connection"
                    disabled={busy}
                    onClick={() => onDelete(row.connection)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
