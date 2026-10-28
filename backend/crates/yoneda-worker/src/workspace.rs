use serde_json::{Value, json};
use worker::*;
use yoneda_cloudflare::CloudStore;

/// The account authority: one instance per account (`account:<name>`) and per device code.
#[durable_object]
pub struct WorkspaceAuthority {
    state: State,
}
impl DurableObject for WorkspaceAuthority {
    fn new(state: State, _: Env) -> Self {
        Self { state }
    }
    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let mut command: Value = req.json().await?;
        command["now"] = json!(Date::now().as_millis() as i64);
        match yoneda_platform::execute_workspace(&CloudStore::new(self.state.storage()), command) {
            Ok(value) => Response::from_json(&value),
            Err(error) => {
                Response::from_json(&json!({"error":{"code":error.code,"message":error.message}}))
                    .map(|r| r.with_status(409))
            }
        }
    }
    /// Accounts once armed alarms to dispatch project setup; one still pending just ends.
    async fn alarm(&self) -> Result<Response> {
        self.state.storage().delete_alarm().await?;
        Response::ok("idle")
    }
}
