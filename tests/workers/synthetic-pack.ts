// Synthetic histories for big-history gates: Git objects, trees and packs built here in
// JavaScript (zlib stored blocks: fast, no compression), and Git requests to the platform.
import { platformFetch } from '../../cloudflare/worker/platform-routes';
import type { Env } from '../../cloudflare/worker/types';

export const text = new TextEncoder();
export const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
export const binary = (id: string) => Uint8Array.from((id.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)));

export function join(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** `data` as a zlib stream of stored blocks (no compression: fast to build). */
export function zlib(data: Uint8Array) {
  const parts: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  for (let at = 0; at === 0 || at < data.length; at += 65535) {
    const block = data.subarray(at, at + 65535);
    const last = at + 65535 >= data.length ? 1 : 0;
    parts.push(Uint8Array.of(last, block.length & 255, block.length >> 8, ~block.length & 255, (~block.length >> 8) & 255), block);
  }
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  parts.push(Uint8Array.of(b >> 8, b & 255, a >> 8, a & 255));
  return join(parts);
}

export type Obj = { kind: 'commit' | 'tree' | 'blob'; data: Uint8Array; id: string };
export const CODES = { commit: 1, tree: 2, blob: 3 };
export async function object(kind: Obj['kind'], data: Uint8Array): Promise<Obj> {
  const head = text.encode(`${kind} ${data.length}\0`);
  return { kind, data, id: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', join([head, data])))) };
}
export const tree = (entries: [string, string, string][]) =>
  object('tree', join(entries.flatMap(([mode, name, id]) => [text.encode(`${mode} ${name}\0`), binary(id)])));

export async function pack(objects: Obj[]) {
  const n = objects.length;
  const parts: Uint8Array[] = [text.encode('PACK'), Uint8Array.of(0, 0, 0, 2, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255)];
  for (const o of objects) {
    let size = o.data.length;
    const head = [(CODES[o.kind] << 4) | (size & 15)];
    size = Math.floor(size / 16);
    while (size > 0) {
      head[head.length - 1] |= 0x80;
      head.push(size & 0x7f);
      size = Math.floor(size / 128);
    }
    parts.push(Uint8Array.from(head), zlib(o.data));
  }
  const body = join(parts);
  return join([body, new Uint8Array(await crypto.subtle.digest('SHA-1', body))]);
}

export const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

export async function git(repo: string, token: string, service: string, body: BodyInit, target: Env, headers = {}) {
  const response = await platformFetch(
    new Request(`https://yoneda/git/${repo}.git/${service}`, { method: 'POST', headers: { authorization: `Basic ${btoa(`git:${token}`)}`, ...headers }, body }),
    target,
  );
  return new Uint8Array(await response.arrayBuffer());
}

