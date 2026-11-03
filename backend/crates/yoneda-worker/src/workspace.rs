use serde_json::{Value, json};
use worker::*;
use yoneda_cloudflare::CloudStore;

/// The account authority: one instance per account (`account:<name>`) and per device code.
#[durable_object]
pub struct WorkspaceAuthority {
    state: State,
    env: Env,
}
impl DurableObject for WorkspaceAuthority {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }
    async fn fetch(&self, mut req: Request) -> Result<Response> {
        // The adapter's path, never client input, asked only with REGION_HINT_TEST on.
        if req.path() == "/where" {
            return yoneda_cloudflare::colo_trace().await;
        }
        let mut command: Value = req.json().await?;
        if command["op"] == "org_member_put" {
            // Arm recovery before the durable grant can commit; failed grants leave an idle alarm.
            self.state.storage().set_alarm(1_000_i64).await?;
        }
        crate::telemetry::serving(&req);
        command["now"] = json!(Date::now().as_millis() as i64);
        match yoneda_platform::execute_workspace(&CloudStore::new(self.state.storage()), command) {
            Ok(value) => Response::from_json(&value),
            Err(error) => {
                crate::telemetry::command_failed(&error);
                Response::from_json(&json!({"error":{"code":error.code,"message":error.message}}))
                    .map(|r| r.with_status(409))
            }
        }
    }
    /// Deliver committed membership notices; legacy/empty account alarms settle idle.
    async fn alarm(&self) -> Result<Response> {
        crate::workspace_notices::dispatch(&self.state, &self.env).await
    }
}
