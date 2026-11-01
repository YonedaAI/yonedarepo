// Work in flight in this isolate, joined by requests that want the same answer. The request that
// starts it can be cancelled, and Workers then drops its continuations: the work never settles
// and its cleanup never runs. So an entry only counts for a while; a later request starts afresh
// rather than wait on it for the life of the isolate.
const STALE_MS = 30_000;

export class Flights<T> {
  readonly #flying = new Map<string, { at: number; work: Promise<T> }>();

  /** The work in flight for `key`, or `load`'s; `joined` says which. */
  join(key: string, load: () => Promise<T>): { work: Promise<T>; joined: boolean } {
    const flight = this.#flying.get(key);
    if (flight && Date.now() - flight.at < STALE_MS) return { work: flight.work, joined: true };
    const work = load().finally(() => {
      if (this.#flying.get(key)?.work === work) this.#flying.delete(key);
    });
    this.#flying.set(key, { at: Date.now(), work });
    return { work, joined: false };
  }
}
