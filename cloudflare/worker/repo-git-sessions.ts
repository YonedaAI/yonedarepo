// Rust sessions behind Git over HTTPS: a push's pack streams into one chunk by chunk and
// its verified objects stream out; a fetch's pack is written entry by entry. Sessions live
// in this isolate's Wasm memory, so every opened one is closed in a `finally`.
//
// Like `platformCompute`, worker-build publishes these `#[wasm_bindgen]` functions as
// methods of the Rust module's default entrypoint class; none uses `this`.
import RustWorker from '../../backend/crates/yoneda-worker/build/worker/shim.mjs';
import { ApiError, type Json } from './repo-ops';

type Exported = Record<string, (...args: unknown[]) => unknown>;
const rust = (RustWorker as unknown as { prototype?: Exported }).prototype ?? {};

function fn<T>(name: string): (...args: unknown[]) => T {
  const found = rust[name];
  if (typeof found !== 'function')
    throw Object.assign(new Error('Git sessions are unavailable in this build'), {
      code: 'COMPUTE_UNAVAILABLE',
    });
  return found as (...args: unknown[]) => T;
}

/** A JSON answer (`{value}` or `{error}`) as its value, or the error as an ApiError. */
function value(answer: string): Json {
  const parsed = JSON.parse(answer);
  if (parsed.error) throw new ApiError(parsed.error.code, parsed.error.message);
  return parsed.value;
}

/** A thrown session error (its message is the JSON `{code, message}`) as an ApiError. */
function bytes(run: () => Uint8Array): Uint8Array {
  try {
    return run();
  } catch (e: any) {
    let parsed: { code?: string; message?: string } = {};
    try {
      parsed = JSON.parse(String(e?.message ?? ''));
    } catch {}
    throw new ApiError(parsed.code ?? 'GIT_FAILED', parsed.message ?? String(e?.message ?? e));
  }
}

export class ReceiveSession {
  private constructor(private readonly handle: number) {}
  static open() {
    return new ReceiveSession(value(fn<string>('gitReceiveOpen')(Date.now())) as unknown as number);
  }
  feed(chunk: Uint8Array) {
    value(fn<string>('gitReceiveFeed')(this.handle, chunk));
  }
  call(input: Json): Json {
    return value(fn<string>('gitReceiveCall')(this.handle, JSON.stringify(input)));
  }
  /** Spilled files' content since the last call (see `ReceiveSession::spilled`), led by
   * one byte: 1 when the pack waits for it to be taken. */
  spilled() {
    return bytes(() => fn<Uint8Array>('gitReceiveSpilled')(this.handle));
  }
  /** Verified objects to store, framed (see `next_objects`); empty when all are out. */
  objects(budget: number) {
    return bytes(() => fn<Uint8Array>('gitReceiveObjects')(this.handle, budget));
  }
  close() {
    fn<void>('gitReceiveClose')(this.handle);
  }
}

export class UploadSession {
  private constructor(private readonly handle: number) {}
  static open(walk: Json) {
    return new UploadSession(
      value(fn<string>('gitUploadOpen')(Date.now(), JSON.stringify(walk))) as unknown as number,
    );
  }
  /** The counting pass: `{need_trees}` or `{count}`. */
  step(input: Json): Json {
    return value(fn<string>('gitUploadStep')(this.handle, JSON.stringify(input)));
  }
  /** Which of `ids` the counted pack holds (after `step` answered `{count}`). */
  holds(ids: string[]): string[] {
    return value(fn<string>('gitUploadHolds')(this.handle, JSON.stringify(ids))) as string[];
  }
  /** The sending pass: `{need_trees}` or the next wave's `{trees, fetch, tags?, done}`. */
  send(input: Json): Json {
    return value(fn<string>('gitUploadSend')(this.handle, JSON.stringify(input)));
  }
  start() {
    return bytes(() => fn<Uint8Array>('gitUploadStart')(this.handle));
  }
  entry(kind: string, id: string, data: Uint8Array = new Uint8Array()) {
    return bytes(() => fn<Uint8Array>('gitUploadEntry')(this.handle, kind, id, data));
  }
  /** A file too large to hold: its entry header (see `UploadSession::large_start`). */
  largeStart(id: string, size: number) {
    return bytes(() => fn<Uint8Array>('gitUploadLargeStart')(this.handle, id, size));
  }
  /** The streamed file's `content` and the `packed` bytes written for it. */
  largeData(content: Uint8Array, packed: Uint8Array) {
    bytes(() => {
      fn<void>('gitUploadLargeData')(this.handle, content, packed);
      return new Uint8Array();
    });
  }
  /** Ends the streamed file (its content must hash to its id). */
  largeEnd() {
    bytes(() => {
      fn<void>('gitUploadLargeEnd')(this.handle);
      return new Uint8Array();
    });
  }
  finish() {
    return bytes(() => fn<Uint8Array>('gitUploadFinish')(this.handle));
  }
  close() {
    fn<void>('gitUploadClose')(this.handle);
  }
}

/** This isolate's Wasm memory in bytes (it only grows). */
export const wasmMemoryBytes = () => fn<number>('wasmMemoryBytes')();
