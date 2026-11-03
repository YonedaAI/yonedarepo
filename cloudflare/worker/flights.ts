// Worker I/O belongs to its request. A Durable Object can explicitly own unfinished
// work with its state lifetime; its requests then share that object's work, not another
// Worker request's I/O. Completed data is cached separately by callers.
import { currentScope } from './request-scope';

const STALE_MS = 30_000;
type Flight<T> = { at: number; work: Promise<T> };

/** Only a Durable Object state may retain shared unfinished I/O after caller cancellation. */
export type DurableFlightOwner = Pick<DurableObjectState, 'waitUntil'>;

export class Flights<T> {
  readonly #requests = new WeakMap<object, Map<string, Flight<T>>>();

  constructor(private readonly owner?: DurableFlightOwner) {}

  /** Pending `key` within its explicit DO owner or request; no owner starts afresh. */
  join(key: string, load: () => Promise<T>): { work: Promise<T>; joined: boolean } {
    const scope = this.owner ?? currentScope();
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
    // The DO owns this I/O even when the initiating request disappears. Callers still
    // receive the original rejection; the retained branch only avoids an unhandled one.
    this.owner?.waitUntil(work.catch(() => {}));
    return { work, joined: false };
  }
}
