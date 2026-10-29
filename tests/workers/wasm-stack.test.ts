// The stack guard (yoneda-worker stack.rs) resets an instance whose Wasm stack a call cut
// off midway left short. It must never fire on a healthy one: every call from JavaScript
// starts within 64 KiB of the 1 MiB stack's top, before and after heavy work.
import { expect, it } from 'vitest';
import { compute } from '../../cloudflare/worker/repo-compute';
import { toBase64 } from '../../cloudflare/worker/repo-objects';

const TOP = 1024 * 1024;
const stack = () => Number(compute({ op: 'memory' }).stack_bytes);

async function facts(path: string, source: string) {
  const data = new TextEncoder().encode(source);
  const head = new TextEncoder().encode(`blob ${data.length}\0`);
  const digest = await crypto.subtle.digest('SHA-1', new Uint8Array([...head, ...data]));
  const id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return compute({ op: 'code_facts', path, id, blobs: { [id]: toBase64(data) } });
}

it('starts every call near the top of the stack, so the guard never fires on its own', async () => {
  const before = stack();
  expect(before).toBeLessThanOrEqual(TOP);
  expect(TOP - before).toBeLessThan(64 * 1024);
  // Parsing recurses deeply (up to the nesting limit) and diffs allocate: the stack is
  // back where it was afterwards.
  const nested = `fn f() ${'{'.repeat(120)}${'}'.repeat(120)}\n`;
  expect((await facts('src/lib.rs', nested)).symbols).toHaveLength(1);
  for (let i = 0; i < 3; i++) compute({ op: 'memory', pad: 'x'.repeat(8 << 20) });
  expect(stack()).toBe(before);
});
