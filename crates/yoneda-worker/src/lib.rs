use serde_json::{Value, json};
use worker::*;
use yoneda_app::{SqlStore, execute};
use yoneda_cloudflare::CloudStore;
mod workspace;
pub use workspace::WorkspaceAuthority;

fn now() -> i64 {
    Date::now().as_millis() as i64
}

#[durable_object]
pub struct RepositoryAuthority {
    state: State,
    env: Env,
}

impl RepositoryAuthority {
    async fn ensure_alarm(&self) -> Result<()> {
        let storage = self.state.storage();
        if storage
            .get_alarm()
            .await?
            .is_none_or(|at| at > now() + 15_000)
        {
            // workers-rs treats i64 as an OFFSET; Duration makes that intent explicit.
            storage
                .set_alarm(std::time::Duration::from_secs(15))
                .await?;
        }
        Ok(())
    }
    async fn flush(&self) -> Result<()> {
        let db = CloudStore::new(self.state.storage());
        if db
            .query("SELECT id FROM repository LIMIT 1", &[])
            .map_err(|e| Error::RustError(e.to_string()))?
            .is_empty()
        {
            self.state.storage().delete_alarm().await?;
            return Ok(());
        }
        let repository = execute(&db, json!({"op":"repository_status"}))
            .map_err(|e| Error::RustError(e.to_string()))?;
        for _ in 0..8 {
            let mut pending = execute(&db, json!({"op":"outbox"}))
                .map_err(|e| Error::RustError(e.to_string()))?;
            if pending["jobs"].as_array().is_none_or(|v| v.is_empty()) {
                break;
            }
            if repository["status"] == "deleted"
                && let Some(entries) = pending["jobs"].as_array_mut()
            {
                for entry in entries {
                    entry["repository_deleted"] = json!(true);
                }
            }
            let ids = yoneda_cloudflare::deliver(
                self.env.as_ref(),
                repository["id"].as_str().unwrap_or_default(),
                &pending["jobs"].to_string(),
            )
            .await
            .map_err(Error::from)?;
            let ids: Vec<String> = serde_json::from_str(&ids.as_string().unwrap_or_default())?;
            if ids.is_empty() {
                break;
            }
            for id in ids {
                execute(&db, json!({"op":"outbox_sent","id":id}))
                    .map_err(|e| Error::RustError(e.to_string()))?;
            }
        }
        let active=db.query("SELECT id FROM jobs WHERE json_extract(payload,'$.status') IN ('queued','running') LIMIT 1",&[]).map_err(|e|Error::RustError(e.to_string()))?;
        let pending = db
            .query("SELECT id FROM outbox WHERE delivered=0 LIMIT 1", &[])
            .map_err(|e| Error::RustError(e.to_string()))?;
        if !active.is_empty() || !pending.is_empty() {
            self.ensure_alarm().await?;
        } else if repository["status"] == "deleted"
            && !repository["deletion_remotes"]
                .as_array()
                .is_none_or(|names| names.is_empty())
        {
            let at = repository["next_cleanup_at"].as_i64().unwrap_or_else(now);
            self.state
                .storage()
                .set_alarm(std::time::Duration::from_millis(
                    u64::try_from(at.saturating_sub(now()).max(1_000)).unwrap_or(1_000),
                ))
                .await?;
        } else {
            self.state.storage().delete_alarm().await?;
        }
        Ok(())
    }
}
impl DurableObject for RepositoryAuthority {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }
    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let mut command: Value = req.json().await?;
        command["now"] = json!(now());
        self.ensure_alarm().await?;
        let result = execute(&CloudStore::new(self.state.storage()), command);
        if let Err(e) = self.flush().await {
            console_error!("Outbox delivery deferred: {e}");
        }
        match result {
            Ok(value) => Response::from_json(&value),
            Err(error) => {
                Response::from_json(&json!({"error":{"code":error.code,"message":error.message}}))
                    .map(|r| r.with_status(409))
            }
        }
    }
    async fn alarm(&self) -> Result<Response> {
        self.ensure_alarm().await?;
        execute(
            &CloudStore::new(self.state.storage()),
            json!({"op":"recover","now":now()}),
        )
        .map_err(|e| Error::RustError(e.to_string()))?;
        self.flush().await?;
        Response::ok("recovered")
    }
}

#[durable_object]
pub struct LiveRoom {
    state: State,
}
impl DurableObject for LiveRoom {
    fn new(state: State, _: Env) -> Self {
        Self { state }
    }
    async fn fetch(&self, req: Request) -> Result<Response> {
        if req.method() == Method::Post {
            // Sockets carry wakeups only. Every data read reauthenticates through
            // the Worker, including after recovery, logout and session expiry.
            for ws in self.state.get_websockets() {
                let _ = ws.send_with_str("{\"type\":\"resync\"}");
            }
            return Response::ok("notified");
        }
        let pair = WebSocketPair::new()?;
        self.state.accept_web_socket(&pair.server);
        Response::from_websocket(pair.client)
    }
    async fn websocket_message(&self, ws: WebSocket, _: WebSocketIncomingMessage) -> Result<()> {
        ws.send_with_str("{\"type\":\"resync\"}")
    }
    async fn websocket_close(
        &self,
        ws: WebSocket,
        code: usize,
        reason: String,
        _: bool,
    ) -> Result<()> {
        ws.close(Some(code as u16), Some(reason))
    }
    async fn websocket_error(&self, _: WebSocket, _: Error) -> Result<()> {
        Ok(())
    }
}

#[event(fetch)]
pub async fn fetch(_req: Request, _env: Env, _ctx: Context) -> Result<Response> {
    Response::error("Use the authenticated SDK entrypoint", 404)
}
