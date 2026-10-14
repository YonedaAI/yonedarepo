//! Attempt-scoped staged source. Git capture and repository decisions stay separate.
use serde_json::{Value, json};
use worker::*;
use yoneda_cloudflare::CloudStore;

#[durable_object]
pub struct SourceWorkspaceAuthority {
    state: State,
    env: Env,
}

impl SourceWorkspaceAuthority {
    fn signing_key(&self) -> Result<String> {
        let vault = self.env.secret("VAULT_KEY")?.to_string();
        Ok(yoneda_core::digest(
            format!("yoneda:source-grant:v1:{vault}").as_bytes(),
        ))
    }

    async fn arm_cleanup(&self) -> Result<()> {
        let storage = self.state.storage();
        let now = Date::now().as_millis() as i64;
        if storage
            .get_alarm()
            .await?
            .is_none_or(|at| at > now + 30_000)
        {
            storage
                .set_alarm(std::time::Duration::from_secs(30))
                .await?;
        }
        Ok(())
    }
}

impl DurableObject for SourceWorkspaceAuthority {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&self, mut request: Request) -> Result<Response> {
        let mut command: Value = request.json().await?;
        let Some(object) = command.as_object_mut() else {
            return Response::from_json(&json!({"error":{
                "code":"INVALID_INPUT", "message":"Source command must be an object"
            }}))
            .map(|response| response.with_status(400));
        };
        object.remove("_source_signing_key");
        command["now"] = json!(Date::now().as_millis() as i64);
        command["_source_signing_key"] = json!(self.signing_key()?);
        if matches!(
            command["op"].as_str(),
            Some("source_init" | "source_upload_ticket")
        ) {
            // Persist the wakeup before an upload reservation can commit.
            self.arm_cleanup().await?;
        }
        match yoneda_app::execute_source_workspace(&CloudStore::new(self.state.storage()), command)
        {
            Ok(value) => Response::from_json(&value),
            Err(error) => Response::from_json(&json!({
                "error": {"code": error.code, "message": error.message}
            }))
            .map(|response| response.with_status(409)),
        }
    }

    async fn alarm(&self) -> Result<Response> {
        self.arm_cleanup().await?;
        let result = yoneda_app::execute_source_workspace(
            &CloudStore::new(self.state.storage()),
            json!({"op":"source_gc_due", "now":Date::now().as_millis() as i64,
                "_source_signing_key":self.signing_key()?}),
        )
        .map_err(|error| Error::RustError(error.to_string()))?;
        let pending = result["pending"] == true
            || result["tickets"]
                .as_array()
                .is_some_and(|tickets| !tickets.is_empty())
            || !result["next_due_at"].is_null();
        if !pending {
            self.state.storage().delete_alarm().await?;
            return Response::ok("idle");
        }
        // Object deletion is delivered through a service binding outside the SQL transaction.
        yoneda_cloudflare::source_cleanup(self.env.as_ref(), &result.to_string())
            .await
            .map_err(Error::from)?;
        Response::ok("cleanup delivered")
    }
}
