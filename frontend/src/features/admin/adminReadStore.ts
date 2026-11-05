// Short-lived report DTOs live only inside one mounted, signed-in Admin scope.
// No storage, credentials, shared globals or expiry extension when a value is reused.
export class AdminReadStore {
  private entries = new Map<string, { data: unknown; until: number }>();
  private epoch = 0;
  get generation() {
    return this.epoch;
  }
  constructor(private now = Date.now) {}
  clear() {
    this.epoch++;
    this.entries.clear();
  }
  get<T>(path: string): T | undefined {
    const entry = this.entries.get(path);
    return entry && entry.until > this.now() ? (entry.data as T) : undefined;
  }
  put(path: string, data: unknown, generation = this.epoch) {
    if (generation !== this.epoch) return;
    if (this.entries.size >= 16) this.entries.delete(this.entries.keys().next().value ?? '');
    this.entries.set(path, { data, until: this.now() + 15000 });
  }
}
