// Stateless Rust compute (diffs, patches) running in this Worker isolate, not in the
// repository Durable Object. Inputs are verified in Rust before use.
//
// worker-build publishes `#[wasm_bindgen]` free functions as methods of the Rust
// module's default entrypoint class rather than as named exports. `platformCompute`
// does not use `this`, so it is called from the prototype; the guard fails loudly if a
// worker-build upgrade changes that shape.
import RustWorker from '../../backend/crates/yoneda-worker/build/worker/shim.mjs';

type Json = Record<string, any>;
const entry = (RustWorker as unknown as { prototype?: { platformCompute?: unknown } }).prototype
  ?.platformCompute;

/** Bytes this isolate has passed into Wasm (each call's JSON input): Wasm memory grows to
 * a few times a call's input and never shrinks, so large inputs are what to watch. */
export const computeInput = { bytes: 0, calls: 0 };

export function compute(input: Json): Json {
  if (typeof entry !== 'function')
    throw Object.assign(new Error('Rust compute is unavailable in this build'), {
      code: 'COMPUTE_UNAVAILABLE',
    });
  const text = JSON.stringify(input);
  computeInput.bytes += text.length;
  computeInput.calls++;
  const result = JSON.parse(entry(text));
  if (result.error)
    throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value;
}
