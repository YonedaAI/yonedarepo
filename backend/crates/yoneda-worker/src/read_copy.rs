//! Private read-copy transport; Rust platform owns validation, fencing and SQL state.
use serde_json::{Value, json};
use std::cell::Cell;
use worker::*;
use yoneda_cloudflare::CloudStore;

#[durable_object]
pub struct RepositoryReadCopy {
    state: State,
    migrated: Cell<bool>,
}
impl DurableObject for RepositoryReadCopy {
    fn new(state: State, _: Env) -> Self {
        Self {
            state,
            migrated: Cell::new(false),
        }
    }
    async fn fetch(&self, mut request: Request) -> Result<Response> {
        if request.path() == "/where" {
            return yoneda_cloudflare::colo_trace().await;
        }
        let command: Value = request.json().await?;
        let db = CloudStore::new(self.state.storage());
        let result = (|| {
            if !self.migrated.get() {
                yoneda_platform::migrate_read_copy(&db)?;
                self.migrated.set(true);
            }
            yoneda_platform::execute_read_copy(&db, command)
        })();
        match result {
            Ok(value) => Response::from_json(&value),
            Err(error) => {
                Response::from_json(&json!({"error":{"code":error.code,"message":error.message}}))
                    .map(|r| r.with_status(409))
            }
        }
    }
}
