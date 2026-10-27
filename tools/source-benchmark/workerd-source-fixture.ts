import { env } from 'cloudflare:workers';
import type { Env } from '../../cloudflare/worker/types';

export const bindings = env as unknown as Env;
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async (bytes: Uint8Array | string) =>
  hex(
    await crypto.subtle.digest(
      'SHA-256',
      typeof bytes === 'string' ? encoder.encode(bytes) : bytes,
    ),
  );
