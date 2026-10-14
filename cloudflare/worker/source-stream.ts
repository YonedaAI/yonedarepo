import { SOURCE_LIMITS, sourceError } from './source-contract';
import { hex } from './source-crypto';

/** Single-pass hashing with backpressure, fixed length, and no retained body chunks. */
export function sourceStream(input: ReadableStream<Uint8Array>, size: number) {
  if (!Number.isSafeInteger(size) || size < 0 || size > SOURCE_LIMITS.fileBytes)
    throw sourceError('SOURCE_LIMIT', 'Source blob exceeds the file allowance');
  const sha = new crypto.DigestStream('SHA-256');
  const git = new crypto.DigestStream('SHA-1');
  const shaWriter = sha.getWriter();
  const gitWriter = git.getWriter();
  const header = gitWriter.write(new TextEncoder().encode(`blob ${size}\0`));
  const reader = input.getReader();
  let length = 0;
  const proof = Promise.all([sha.digest, git.digest]).then(([digest, oid]) => ({
    size: length,
    sha256: hex(digest),
    git_oid: hex(oid),
  }));
  // A caller may reject a conditional R2 write before consuming its body.
  // Retain the error for the caller without an unhandled digest rejection.
  void proof.catch(() => {});
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        await header;
        const chunk = await reader.read();
        if (chunk.done) {
          if (length !== size)
            throw sourceError('SOURCE_SIZE', 'Source body length differs from its reservation');
          await Promise.all([shaWriter.close(), gitWriter.close()]);
          controller.close();
          return;
        }
        length += chunk.value.byteLength;
        if (length > size) throw sourceError('SOURCE_SIZE', 'Source body exceeds its reservation');
        await Promise.all([shaWriter.write(chunk.value), gitWriter.write(chunk.value)]);
        controller.enqueue(chunk.value);
      } catch (failure) {
        await Promise.allSettled([
          reader.cancel(failure),
          shaWriter.abort(failure),
          gitWriter.abort(failure),
        ]);
        controller.error(failure);
      }
    },
    async cancel(reason) {
      await Promise.allSettled([
        reader.cancel(reason),
        shaWriter.abort(reason),
        gitWriter.abort(reason),
      ]);
    },
  });
  const fixed = new FixedLengthStream(size);
  const piped = stream.pipeTo(fixed.writable);
  void piped.catch(() => {});
  return { body: fixed.readable, proof, piped };
}

export async function streamProof(body: ReadableStream<Uint8Array>, size: number) {
  const measured = sourceStream(body, size);
  await measured.body.pipeTo(new WritableStream({ write() {} }));
  await measured.piped;
  return measured.proof;
}
