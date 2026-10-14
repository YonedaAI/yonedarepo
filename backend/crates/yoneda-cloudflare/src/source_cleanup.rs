//! Deliver source cleanup outside the source authority transaction.
use wasm_bindgen::prelude::*;

#[wasm_bindgen(
    inline_js = "export async function sourceCleanup(env, payload) { await env.SELF.sourceCleanup(JSON.parse(payload)); }"
)]
extern "C" {
    #[wasm_bindgen(catch, js_name = sourceCleanup)]
    pub async fn source_cleanup(env: &JsValue, payload: &str) -> Result<JsValue, JsValue>;
}
