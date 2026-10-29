//! Stateless Rust compute exported to the TypeScript adapter (diffs, patches). It runs
//! in the calling Worker isolate, so it never occupies a repository Durable Object.
use worker::wasm_bindgen::prelude::wasm_bindgen;

/// JSON in, JSON out: `{"value": ...}` or `{"error": {"code", "message"}}`.
#[wasm_bindgen(js_name = platformCompute, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn platform_compute(input: &str) -> String {
    let result = serde_json::from_str(input)
        .map_err(|_| yoneda_core::Error::new("INVALID_INPUT", "Compute input must be JSON"))
        .and_then(yoneda_platform::platform_compute);
    match result {
        Ok(value) => serde_json::json!({ "value": value }),
        Err(e) => serde_json::json!({ "error": { "code": e.code, "message": e.message } }),
    }
    .to_string()
}

/// Takes nothing and does nothing: the adapter calls it at once after a call into Rust
/// failed, so the fresh instance a trap scheduled (a panic, the stack or memory exhausted)
/// starts here. wasm-bindgen's glue copies a call's string and byte arguments into memory
/// before it switches instances, and only exports returning a string switch on the way
/// out: after a trap in one returning bytes, the next call carrying a string handed the
/// fresh instance a pointer into the old one's memory (`memory access out of bounds`).
#[wasm_bindgen(js_name = wasmSettle, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn wasm_settle() {}
