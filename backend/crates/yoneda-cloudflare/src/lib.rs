use serde_json::{Value, json};
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::{JsCast, prelude::*};
use worker::{SqlStorageValue, Storage};
use yoneda_app::SqlStore;
use yoneda_core::{Error, Result};

// SDK interop only: transactionSync is not exposed by workers-rs 0.8.7.
#[wasm_bindgen(
    inline_js = "export function transaction(storage, action) { return storage.transactionSync(() => { const r = JSON.parse(action()); if (r.error) throw new Error(JSON.stringify(r.error)); return r.value; }); } export async function deliver(env, repo, items) { return JSON.stringify(await env.SELF.deliver(repo, JSON.parse(items))); } export async function enqueue_projects(env, owner, items) { return JSON.stringify(await env.SELF.enqueueProjects(owner, JSON.parse(items))); }"
)]
extern "C" {
    #[wasm_bindgen(catch)]
    fn transaction(
        storage: &JsValue,
        action: &js_sys::Function,
    ) -> std::result::Result<JsValue, JsValue>;
    #[wasm_bindgen(catch)]
    pub async fn deliver(
        env: &JsValue,
        repo: &str,
        items: &str,
    ) -> std::result::Result<JsValue, JsValue>;
    #[wasm_bindgen(catch)]
    pub async fn enqueue_projects(
        env: &JsValue,
        owner: &str,
        items: &str,
    ) -> std::result::Result<JsValue, JsValue>;
}

#[derive(Clone)]
pub struct CloudStore(pub Rc<Storage>);
impl CloudStore {
    pub fn new(storage: Storage) -> Self {
        Self(Rc::new(storage))
    }
}
impl SqlStore for CloudStore {
    fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Value>> {
        let values = params
            .iter()
            .map(|v| match v {
                Value::Null => SqlStorageValue::Null,
                Value::Bool(v) => SqlStorageValue::Integer(i64::from(*v)),
                Value::Number(v) => SqlStorageValue::Integer(v.as_i64().unwrap_or_default()),
                Value::String(v) => SqlStorageValue::String(v.clone()),
                _ => SqlStorageValue::String(v.to_string()),
            })
            .collect();
        self.0
            .sql()
            .exec(sql, Some(values))
            .and_then(|c| c.to_array::<Value>())
            .map_err(|e| Error::new("DATABASE", e.to_string()))
    }
    fn transaction(&self, action: Box<dyn FnOnce() -> Result<Value>>) -> Result<Value> {
        let mut action = Some(action);
        let result = Rc::new(RefCell::new(None));
        let saved = result.clone();
        let callback = Closure::wrap(Box::new(move || {
            let r = action.take().expect("transaction called once")();
            let value = match &r {
                Ok(v) => json!({"value":v}),
                Err(e) => json!({"error":{"code":e.code,"message":e.message}}),
            };
            *saved.borrow_mut() = Some(r);
            value.to_string()
        }) as Box<dyn FnMut() -> String>);
        let invoked = transaction(self.0.as_raw().as_ref(), callback.as_ref().unchecked_ref());

        match result.borrow_mut().take() {
            Some(Err(e)) => Err(e),
            Some(Ok(v)) if invoked.is_ok() => Ok(v),
            _ => Err(Error::new(
                "DATABASE",
                format!("Storage transaction failed: {:?}", invoked.err()),
            )),
        }
    }
}
