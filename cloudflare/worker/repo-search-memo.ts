// Only completed immutable code results. Current admission, records, memories and public
// redaction stay outside. Serialized LRU values cannot carry another request's unfinished I/O.
import type { Json } from './repo-ops';

type Bounds = { entries: number; bytes: number; entry: number };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export class CodeMemo {
  readonly #items = new Map<string, { bytes: Uint8Array; size: number }>();
  #bytes = 0;
  constructor(
    private readonly bounds: Bounds = {
      entries: 128,
      bytes: 4 * 1024 * 1024,
      entry: 256 * 1024,
    },
  ) {}

  get(key: string): Json | undefined {
    const item = this.#items.get(key);
    if (!item) return;
    this.#items.delete(key);
    this.#items.set(key, item);
    return JSON.parse(decoder.decode(item.bytes));
  }

  put(key: string, value: Json) {
    const bytes = encoder.encode(JSON.stringify(value));
    const size = bytes.byteLength + encoder.encode(key).byteLength;
    if (size > this.bounds.entry || size > this.bounds.bytes) return;
    const old = this.#items.get(key);
    if (old) this.#bytes -= old.size;
    this.#items.delete(key);
    this.#items.set(key, { bytes, size });
    this.#bytes += size;
    for (const [oldest, item] of this.#items) {
      if (this.#bytes <= this.bounds.bytes && this.#items.size <= this.bounds.entries) break;
      this.#items.delete(oldest);
      this.#bytes -= item.size;
    }
  }
}

const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const sha = (s: unknown) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);

/** Called only with fresh authority status, after the requested target was admitted. */
export function codeKey(repo: string, status: Json, where: Json, query: string, args: Json) {
  if (
    status.parent != null ||
    status.grant !== null ||
    !integer(status.version) ||
    !integer(status.quarantine_epoch) ||
    typeof status.history_chain !== 'string' ||
    !status.history_chain ||
    typeof status.object_store !== 'string' ||
    !status.object_store ||
    !sha(where.commit) ||
    !sha(where.tree)
  )
    return null;
  return JSON.stringify([
    'search-code-v1-segment-v4',
    repo,
    status.object_store,
    status.history_chain,
    status.quarantine_epoch,
    where.commit,
    where.tree,
    query,
    String(args.path ?? ''),
    args.ignore_case === true || args.ignore_case === 'true',
    args.word === true || args.word === 'true',
    Math.min(Number(args.limit ?? 50) || 50, 200),
  ]);
}

export const completedCode = new CodeMemo();
