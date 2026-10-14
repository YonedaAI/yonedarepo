import { billingLabel } from './ProviderBillingPicker';
import type { Provider } from './ProviderSettings';
import { modelDisplayName, providerNames } from './providerModels';

const providerOrder = ['claude', 'codex', 'zai', 'mimo', 'gemini'];

/** How a connection is billed; ZAI keys are Coding Plan keys, MiMo records its plan. */
export function billingRoute(connection: Provider) {
  if (connection.provider === 'mimo') return billingLabel(connection.routing);
  if (connection.provider === 'zai') return 'Coding Plan';
  return 'API credits';
}

export type ProviderRow = {
  connection: Provider;
  model: string;
  /** Present only when another row in the group shows the same model name. */
  hint?: string;
  canEdit: boolean;
};
export type ProviderGroup = {
  key: string;
  provider: string;
  name: string;
  route: string;
  rows: ProviderRow[];
  /** Connections holding their own sealed key; added models reuse one of these. */
  keySources: Provider[];
};

/** Presentation grouping only: every connection appears exactly once, in server order. */
export function groupConnections(connections: Provider[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();
  for (const connection of connections) {
    const route = billingRoute(connection);
    const key = `${connection.provider}:${route}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        provider: connection.provider,
        name: providerNames[connection.provider] ?? connection.provider,
        route,
        rows: [],
        keySources: [],
      };
      groups.set(key, group);
    }
    group.rows.push({
      connection,
      model: modelDisplayName(connection.provider, connection.model),
      canEdit: !connection.alias_source,
    });
    if (!connection.alias_source) group.keySources.push(connection);
  }
  for (const group of groups.values()) {
    // Before any key-less alias exists, keep the previous behavior of adding from any row.
    if (!group.keySources.length) group.keySources.push(group.rows[0].connection);
    for (const row of group.rows) {
      const same = group.rows.filter((other) => other.model === row.model);
      if (same.length < 2) continue;
      const role = (item: ProviderRow) =>
        item.connection.alias_source ? 'added model' : 'saved key';
      const sameLabel = same.filter((other) => other.connection.label === row.connection.label);
      const sameRole = sameLabel.filter((other) => role(other) === role(row));
      row.hint =
        sameLabel.length < 2
          ? row.connection.label
          : sameRole.length < 2
            ? `${row.connection.label} · ${role(row)}`
            : `${row.connection.label} · …${row.connection.id.slice(-6)}`;
    }
  }
  const rank = (provider: string) => {
    const index = providerOrder.indexOf(provider);
    return index < 0 ? providerOrder.length : index;
  };
  return [...groups.values()].sort((a, b) => rank(a.provider) - rank(b.provider));
}

/** Accessible name for a row action; duplicates carry their distinguishing hint. */
export function rowActionName(action: 'Edit' | 'Delete', row: ProviderRow) {
  return `${action} ${row.model}${row.hint ? ` (${row.hint})` : ''}`;
}
