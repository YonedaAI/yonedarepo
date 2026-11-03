// Only the owning request may join its unfinished work. Completed data is cached by
// callers separately; cancelled request I/O must never hold a different request open.
import { currentScope } from './request-scope';

const STALE_MS = 30_000;
type Flight<T> = { at: number; work: Promise<T> };

export class Flights<T> {
  readonly #requests = new WeakMap<object, Map<string, Flight<T>>>();

  /** The work in flight for `key` in this request; absent scope always starts afresh. */
  join(key: string, load: () => Promise<T>): { work: Promise<T>; joined: boolean } {
    const scope = currentScope();
    if (!scope) return { work: load(), joined: false };
    let flying = this.#requests.get(scope);
    if (!flying) {
      flying = new Map();
      this.#requests.set(scope, flying);
    }
    const flight = flying.get(key);
    if (flight && Date.now() - flight.at < STALE_MS) return { work: flight.work, joined: true };
    const work = load().finally(() => {
      if (flying.get(key)?.work === work) flying.delete(key);
    });
    flying.set(key, { at: Date.now(), work });
    return { work, joined: false };
  }
}
