// An R2 object written as its bytes stream through the Worker: parts of `PART` bytes go up
// one at a time while the next fills (at most two parts held), so memory stays two parts
// whatever the size; an object under one part is one put at the end. Nothing is visible
// until `finish`; `abort` (a failed or cancelled stream) leaves nothing behind. A writer
// that must never wait (a clone's stored pack) uses `offer`: two parts go up at once while
// a third fills, and past that it refuses instead of waiting.
import type { Env } from './types';

/** Bytes per multipart part (R2: every part but the last the same size, at least 5 MiB). */
export const PART = 8 * 1024 * 1024;
/** Parts `offer` keeps on their way up at once. */
const OFFERED = 2;

export class R2Parts {
  #parts: R2UploadedPart[] = [];
  #buffer: Uint8Array;
  #filled = 0;
  #total = 0;
  #upload?: Promise<R2MultipartUpload>;
  #uploading: Promise<void> = Promise.resolve();
  /** Parts on their way up (a failed one never leaves). */
  #sending = 0;

  constructor(
    private readonly env: Env,
    readonly key: string,
    private readonly options: R2PutOptions = {},
    private readonly part = PART,
  ) {
    this.#buffer = new Uint8Array(part);
  }

  /** Bytes added so far. */
  get size() {
    return this.#total;
  }

  /** Adds `bytes`, waiting for an upload only when a second full part is ready. */
  async add(bytes: Uint8Array) {
    this.#total += bytes.length;
    for (let at = 0; at < bytes.length; ) {
      const take = Math.min(bytes.length - at, this.part - this.#filled);
      this.#buffer.set(bytes.subarray(at, at + take), this.#filled);
      this.#filled += take;
      at += take;
      if (this.#filled === this.part) await this.#send(this.#buffer);
    }
  }

  /** Adds `bytes` at once, never waiting: false when a part fills while `OFFERED` are
   * still on their way up (or one failed), and the object is then to be aborted. */
  offer(bytes: Uint8Array) {
    this.#total += bytes.length;
    for (let at = 0; at < bytes.length; ) {
      const take = Math.min(bytes.length - at, this.part - this.#filled);
      this.#buffer.set(bytes.subarray(at, at + take), this.#filled);
      this.#filled += take;
      at += take;
      if (this.#filled === this.part) {
        if (this.#sending >= OFFERED) return false;
        this.#start(this.#buffer);
      }
    }
    return true;
  }

  async #send(part: Uint8Array) {
    await this.#uploading;
    this.#start(part);
  }

  /** Starts `part`'s upload once the multipart upload exists; the buffer starts afresh.
   * `#uploading` settles when every part started so far has. */
  #start(part: Uint8Array) {
    this.#sending++;
    this.#upload ??= this.env.OBJECTS.createMultipartUpload(this.key, this.options);
    const number = this.#parts.length + 1;
    const sent = this.#upload
      .then((upload) => upload.uploadPart(number, part))
      .then((uploaded) => {
        this.#parts[number - 1] = uploaded;
        this.#sending--;
      });
    this.#uploading = Promise.all([this.#uploading, sent]).then(() => {});
    this.#parts.length = number;
    this.#buffer = new Uint8Array(this.part);
    this.#filled = 0;
  }

  /** Makes the object visible with everything added. */
  async finish() {
    const rest = this.#buffer.subarray(0, this.#filled);
    if (!this.#upload) {
      await this.env.OBJECTS.put(this.key, rest, this.options);
      return;
    }
    if (rest.length > 0) await this.#send(rest);
    await this.#uploading;
    await (await this.#upload).complete(this.#parts);
  }

  async abort() {
    if (!this.#upload) return;
    await this.#uploading.catch(() => {});
    await (await this.#upload).abort();
  }
}
