use serde_json::{Value, json};
use worker::*;
use yoneda_cloudflare::CloudStore;

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
        match yoneda_app::execute_workspace(&CloudStore::new(self.state.storage()), command) {
            Ok(value) => Response::from_json(&value),
            Err(error) => {
                Response::from_json(&json!({"error":{"code":error.code,"message":error.message}}))
                    .map(|r| r.with_status(409))
            }
        }
    }
}
