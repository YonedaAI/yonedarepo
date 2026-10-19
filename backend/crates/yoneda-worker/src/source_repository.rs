//! The source platform's authority for one repository: commits, refs, the transaction log,
//! checks, reviews and landing. Independent of runs and agents (RepositoryAuthority).
use serde_json::{Value, json};
use worker::*;
use yoneda_cloudflare::CloudStore;

#[durable_object]
pub struct SourceRepository {
    state: State,
}

impl DurableObject for SourceRepository {
    fn new(state: State, _: Env) -> Self {
        Self { state }
    }

    async fn fetch(&self, mut request: Request) -> Result<Response> {
        let mut command: Value = request.json().await?;
        if !command.is_object() {
            return Response::from_json(
                &json!({"error":{"code":"INVALID_INPUT","message":"Command must be an object"}}),
            )
            .map(|r| r.with_status(400));
        }
        // `_principal` and `_workspace` come from the authenticating adapter; time is ours.
        command["now"] = json!(Date::now().as_millis() as i64);
        match yoneda_platform::execute_repo_store(&CloudStore::new(self.state.storage()), command) {
            Ok(value) => Response::from_json(&value),
            Err(e) => Response::from_json(&json!({"error":{"code":e.code,"message":e.message}}))
                .map(|r| r.with_status(409)),
        }
    }
}
