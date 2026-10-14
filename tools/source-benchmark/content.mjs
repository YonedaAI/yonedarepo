import { createCipheriv, createHash } from 'node:crypto';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Fixed AES-CTR streams provide reproducible high-entropy bytes without network or RNG. */
export function fixtureBytes(seed, path, bytes, generation = 'base') {
  const key = createHash('sha256').update(`${seed}\0${path}\0${generation}`).digest();
  const cipher = createCipheriv('aes-256-ctr', key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(Buffer.alloc(bytes)), cipher.final()]);
}

export function fixturePaths(count) {
  if (!Number.isSafeInteger(count) || count < 6 || count > 10000)
    throw new Error('Fixture must contain 6–10000 files');
  return Array.from(
    { length: count },
    (_, index) =>
      `data/${String(Math.floor(index / 100)).padStart(3, '0')}/${String(index).padStart(5, '0')}.bin`,
  );
}

export function requestedPaths(paths) {
  return Array.from(
    { length: 5 },
    (_, index) => paths[Math.floor((index * (paths.length - 1)) / 4)],
  );
}
