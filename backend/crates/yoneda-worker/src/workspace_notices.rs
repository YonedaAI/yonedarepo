//! Account notice dispatch only after durable membership/outbox state commits.
use serde_json::{Value, json};
use worker::*;
use yoneda_cloudflare::CloudStore;

// SDK queue serialization treats generic Rust maps as JS Maps. A struct produces
// the ordinary object envelope consumed by the TypeScript queue adapter.
#[derive(serde::Serialize)]
struct MemberNoticeJob<'a> {
    v: u8,
    kind: &'static str,
    repo_id: &'static str,
    job_id: String,
    workspace: &'a str,
    number: i64,
}
fn command(state: &State, mut c: Value) -> Result<Value> {
    c["now"] = json!(Date::now().as_millis() as i64);
    yoneda_platform::execute_workspace(&CloudStore::new(state.storage()), c)
        .map_err(|e| Error::RustError(e.to_string()))
}
pub(crate) async fn dispatch(state: &State, env: &Env) -> Result<Response> {
    let pending = command(state, json!({"op":"member_notices_pending"}))?;
    let rows = pending["notices"]
        .as_array()
        .ok_or_else(|| Error::RustError("Invalid notice dispatch state".into()))?;
    if rows.is_empty() {
        state.storage().delete_alarm().await?;
        return Response::ok("idle");
    }
    // Persist the next recovery before queue I/O. A lost/poisoned queue job cannot erase the outbox.
    state.storage().set_alarm(60_000_i64).await?;
    let queue = env.queue("PLATFORM_QUEUE")?;
    for row in rows {
        let org = row["org"]
            .as_str()
            .ok_or_else(|| Error::RustError("Invalid notice source".into()))?;
        let id = row["id"]
            .as_i64()
            .ok_or_else(|| Error::RustError("Invalid notice id".into()))?;
        queue
            .send(MemberNoticeJob {
                v: 1,
                kind: "org_member_notification",
                repo_id: "",
                job_id: format!("org-notice-{id}"),
                workspace: org,
                number: id,
            })
            .await?;
    }
    Response::ok("dispatched")
}
