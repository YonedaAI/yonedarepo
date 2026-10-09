use serde_json::{Value, json};
use worker::*;
use yoneda_cloudflare::CloudStore;

#[durable_object]
pub struct WorkspaceAuthority {
    state: State,
    env: Env,
}
impl WorkspaceAuthority {
    async fn ensure_alarm(&self) -> Result<()> {
        let storage = self.state.storage();
        let now = Date::now().as_millis() as i64;
        if storage
            .get_alarm()
            .await?
            .is_none_or(|at| at > now + 15_000)
        {
            storage
                .set_alarm(std::time::Duration::from_secs(15))
                .await?;
        }
        Ok(())
    }
}
impl DurableObject for WorkspaceAuthority {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }
    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let mut command: Value = req.json().await?;
        command["now"] = json!(Date::now().as_millis() as i64);
        if command["op"]
            .as_str()
            .is_some_and(|op| op == "projects" || op.starts_with("project_"))
        {
            // Arm before committing dispatch intent, so termination cannot strand a reservation.
            self.ensure_alarm().await?;
        }
        match yoneda_app::execute_workspace(&CloudStore::new(self.state.storage()), command) {
            Ok(value) => Response::from_json(&value),
            Err(error) => {
                Response::from_json(&json!({"error":{"code":error.code,"message":error.message}}))
                    .map(|r| r.with_status(409))
            }
        }
    }
    async fn alarm(&self) -> Result<Response> {
        self.ensure_alarm().await?;
        let db = CloudStore::new(self.state.storage());
        let pending = yoneda_app::execute_workspace(
            &db,
            json!({"op":"project_dispatches","now":Date::now().as_millis() as i64}),
        )
        .map_err(|error| Error::RustError(error.to_string()))?;
        if pending["active"] != true {
            self.state.storage().delete_alarm().await?;
            return Response::ok("idle");
        }
        let delivered = yoneda_cloudflare::enqueue_projects(
            self.env.as_ref(),
            pending["workspace"].as_str().unwrap_or_default(),
            &pending["projects"].to_string(),
        )
        .await
        .map_err(Error::from)?;
        let ids: Vec<String> = serde_json::from_str(&delivered.as_string().unwrap_or_default())?;
        for project in pending["projects"].as_array().into_iter().flatten() {
            if project["id"]
                .as_str()
                .is_some_and(|id| ids.iter().any(|sent| sent == id))
            {
                yoneda_app::execute_workspace(&db, json!({"op":"project_dispatch_sent","id":project["id"],"epoch":project["epoch"],"now":Date::now().as_millis() as i64}))
                    .map_err(|error| Error::RustError(error.to_string()))?;
            }
        }
        Response::ok("dispatched")
    }
}
