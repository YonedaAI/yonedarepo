// Webhooks: tell CI, chat or a waiting agent what happened (landings, refusals, branch and
// tag moves, checks). Each payload is signed with the hook's secret, shown once at creation.
import { type FormEvent, useState } from 'react';
import { Failure } from '../source-platform/SourceStatus';
import { sourceApi } from '../source-platform/sourceApi';
import { CopyBlock } from '../source-platform/TokenParts';
import { useSource } from '../source-platform/useSource';
import { type Delivery, DeliveryTable, HOOK_EVENTS, type Hook, HookTable } from './HookParts';

export function RepoWebhooks({ repo }: { repo: string }) {
  const hooks = useSource<{ hooks: Hook[] }>(`/repos/${repo}/hooks`);
  const [selected, setSelected] = useState<number>();
  const deliveries = useSource<{ deliveries: Delivery[] }>(
    selected ? `/repos/${repo}/hooks/${selected}/deliveries` : null,
  );
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([...HOOK_EVENTS]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState('');

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await sourceApi<{ secret: string }>(`/repos/${repo}/hooks`, {
        body: { url: url.trim(), events },
      });
      setSecret(created.secret);
      setUrl('');
      hooks.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(hook: Hook) {
    if (!window.confirm(`Delete the webhook to ${hook.url}? Queued deliveries are dropped.`))
      return;
    setError('');
    try {
      await sourceApi(`/repos/${repo}/hooks/${hook.id}`, { method: 'DELETE' });
      if (selected === hook.id) setSelected(undefined);
      hooks.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section aria-labelledby="hooks-heading">
      <h2 id="hooks-heading">Webhooks</h2>
      <p className="source-meta">
        Payloads arrive in order, signed with HMAC-SHA256 of the hook&apos;s secret, and are retried
        with backoff. A hook that keeps failing is disabled.
      </p>
      <HookTable
        hooks={hooks}
        selected={selected}
        onDeliveries={(h) => setSelected(selected === h.id ? undefined : h.id)}
        onDelete={remove}
      />
      {selected !== undefined && (
        <section aria-label="Deliveries" className="settings-deliveries">
          <DeliveryTable deliveries={deliveries} />
        </section>
      )}
      {secret ? (
        <div className="source-shown-once" role="status">
          <strong>Copy the signing secret now. It will not be shown again.</strong>
          <CopyBlock label="signing secret" text={secret} />
          <button type="button" onClick={() => setSecret('')}>
            I saved it
          </button>
        </div>
      ) : (
        <form onSubmit={create} className="source-token-form" aria-label="Add a webhook">
          <label htmlFor="hook-url" className="source-field settings-wide">
            Payload URL
            <input
              id="hook-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://ci.example.com/yoneda"
              required
            />
          </label>
          <fieldset className="source-checks">
            <legend>Events</legend>
            {HOOK_EVENTS.map((name) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={events.includes(name)}
                  onChange={(e) =>
                    setEvents(
                      e.target.checked ? [...events, name] : events.filter((x) => x !== name),
                    )
                  }
                />
                {name}
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={busy || !url.trim() || events.length === 0}>
            {busy ? 'Adding…' : 'Add webhook'}
          </button>
        </form>
      )}
      {error && <Failure error={error} />}
    </section>
  );
}
