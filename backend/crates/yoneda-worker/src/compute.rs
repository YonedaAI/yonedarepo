//! Stateless Rust compute exported to the TypeScript adapter (diffs, patches). It runs
//! in the calling Worker isolate, so it never occupies a repository Durable Object.
use worker::wasm_bindgen::prelude::wasm_bindgen;

/// JSON in, JSON out: `{"value": ...}` or `{"error": {"code", "message"}}`.
#[wasm_bindgen(js_name = platformCompute, wasm_bindgen = ::worker::wasm_bindgen)]
pub fn platform_compute(input: &str) -> String {
    let result = serde_json::from_str(input)
        .map_err(|_| yoneda_core::Error::new("INVALID_INPUT", "Compute input must be JSON"))
        .and_then(yoneda_app::platform_compute);
    match result {
        Ok(value) => serde_json::json!({ "value": value }),
        Err(e) => serde_json::json!({ "error": { "code": e.code, "message": e.message } }),
    }
    .to_string()
}
