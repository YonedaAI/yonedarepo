// The two request forms a check server takes. The streamed one (`/check/stream`, see the
// runtime's check_stream.rs) ships content as raw binary frames the server writes to disk
// as they arrive; the JSON one (`/check`, base64 content) is kept for a runtime image from
// before the stream route.
import type { CheckJob } from './check-container';
import { toBase64 } from './repo-objects';

export const STREAM_TYPE = 'application/vnd.yoneda.check-stream';
const MAGIC = new TextEncoder().encode('YCHK1\n');
const KINDS: Record<string, number> = { blob: 1, exec: 2, symlink: 3 };

/** A file's frame head: kind byte, u16 path length, the path, u32 content length. */
function frameHead(file: CheckJob['files'][number]) {
  const kind = KINDS[file.type];
  if (!kind) throw new Error(`Unsupported check file type ${file.type}`);
  const path = new TextEncoder().encode(file.path);
  const head = new Uint8Array(1 + 2 + path.length + 4);
  const view = new DataView(head.buffer);
  head[0] = kind;
  view.setUint16(1, path.length);
  head.set(path, 3);
  view.setUint32(3 + path.length, file.data.length);
  return head;
}

/** The streamed body: frames produced as the server reads, so none is copied whole. */
export function streamBody(job: CheckJob): ReadableStream<Uint8Array> {
  const header = new TextEncoder().encode(
    JSON.stringify({ command: job.command, timeout_seconds: job.timeout_seconds }),
  );
  const start = new Uint8Array(MAGIC.length + 4 + header.length);
  start.set(MAGIC);
  new DataView(start.buffer).setUint32(MAGIC.length, header.length);
  start.set(header, MAGIC.length + 4);
  let next = 0;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(start);
    },
    pull(controller) {
      const file = job.files[next++];
      if (!file) {
        controller.enqueue(new Uint8Array([0]));
        controller.close();
        return;
      }
      controller.enqueue(frameHead(file));
      if (file.data.length) controller.enqueue(file.data);
    },
  });
}

/** The JSON body of the older route. */
export const jsonBody = (job: CheckJob) =>
  JSON.stringify({
    command: job.command,
    timeout_seconds: job.timeout_seconds,
    files: job.files.map((f) => ({ path: f.path, type: f.type, data_b64: toBase64(f.data) })),
  });
