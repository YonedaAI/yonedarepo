// A real panic in the real Wasm: the hook writes where it happened before `rustCall` resets the
// instance, and the fresh instance serves on, with the hook in place again.
import { afterEach, expect, it, vi } from 'vitest';
import RustWorker from '../../backend/crates/yoneda-worker/build/worker/shim.mjs';
import { compute, rustCall } from '../../cloudflare/worker/repo-compute';
import { inScope } from '../../cloudflare/worker/request-scope';

const probe = (RustWorker as unknown as { prototype: { wasmPanicProbe: () => string } }).prototype.wasmPanicProbe;

afterEach(() => vi.restoreAllMocks());

it('logs a panic, then says which request trapped, and the next call works', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  // worker-build's glue writes a plain "Critical" line of its own around a trap.
  const lines = () => logged.mock.calls.map(([line]) => String(line)).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  const req = new Request('https://yoneda/', { headers: { 'cf-ray': '8f1c2d3e4a5b6c7d-SJC' } });
  for (let round = 1; round <= 2; round++) {
    logged.mockClear();
    await inScope({ req }, async () => expect(() => rustCall(probe)).toThrow());
    expect(lines()).toEqual([
      expect.objectContaining({ event: 'wasm.panic', level: 'error', message: 'wasm panic probe', path: expect.stringMatching(/compute\.rs:\d+$/) }),
      expect.objectContaining({ event: 'wasm.trap', level: 'error', request_id: '8f1c2d3e4a5b6c7d-SJC' }),
    ]);
    expect(compute({ op: 'memory' }).wasm_bytes).toBeGreaterThan(0);
  }
});
