//! Server-issued MCP sessions freeze attribution at the time a successful read is recorded.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    let id = string(&c, "session_id")?;
    let grant = string(&c, "_grant")?;
    if c["op"] == "context_session_begin" {
        if id.len() > 80 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(bad("Invalid server-issued session ID"));
        }
        let expires = number(&c, "expires_at")?;
        let maximum = now
            .checked_add(86_400_000)
            .ok_or_else(|| bad("Invalid session time"))?;
        if expires <= now || expires > maximum {
            return Err(bad(
                "Session must expire within 24 hours and the grant lifetime",
            ));
        }
        let protocol = string(&c, "protocol_version")?;
        if !["2025-03-26", "2025-06-18"].contains(&protocol.as_str()) {
            return Err(bad("Unsupported MCP protocol version"));
        }
        if get(db, "context_sessions", &id).is_ok() {
            let existing = session(db, &c, now)?;
            if existing["expires_at"] != expires || existing["protocol_version"] != protocol {
                return Err(Error::new(
                    "IDEMPOTENCY_CONFLICT",
                    "Session configuration is immutable",
                ));
            }
            return Ok(existing);
        }
        let value = json!({"id":id,"grant_id":grant,"created_at":now,"expires_at":expires,
            "protocol_version":protocol,"status":"active","run_id":null,"execution_id":null,"job_id":null,"epoch":null});
        create(db, "context_sessions", &id, &value)?;
        return Ok(value);
    }
    let mut value = session(db, &c, now)?;
    if c["op"] == "context_session_end" {
        value["status"] = json!("ended");
        value["ended_at"] = json!(now);
        save(db, "context_sessions", &id, &value)?;
    }
    Ok(value)
}

pub(super) fn session<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let unavailable = || {
        Error::new(
            "SESSION_NOT_FOUND",
            "MCP session is unavailable; initialize a new session",
        )
    };
    let id = c["session_id"].as_str().ok_or_else(unavailable)?;
    let value = get(db, "context_sessions", id).map_err(|_| unavailable())?;
    if value["grant_id"] != c["_grant"]
        || value["status"] != "active"
        || value["expires_at"]
            .as_i64()
            .is_none_or(|expires| expires <= now)
    {
        return Err(unavailable());
    }
    Ok(value)
}

pub(super) fn bind<S: SqlStore>(db: &S, c: &Value, job: &Value, now: i64) -> Result<()> {
    if c.get("session_id").is_none() {
        return Ok(());
    }
    let mut value = session(db, c, now)?;
    if value["job_id"] == job["id"] && value["epoch"] == job["epoch"] {
        return Ok(());
    }
    if let Some(previous_id) = value["job_id"].as_str() {
        let previous = get(db, "jobs", previous_id)?;
        if (previous["status"] == "running" || previous["status"] == "queued")
            && previous["deadline"]
                .as_i64()
                .is_none_or(|deadline| deadline > now)
        {
            return Err(Error::new(
                "SESSION_BOUND",
                "This session already has an active contribution",
            ));
        }
    }
    if job["external"] != true || job["external_grant"] != c["_grant"] {
        return Err(Error::new(
            "FORBIDDEN",
            "Session contribution belongs to another grant",
        ));
    }
    value["job_id"] = job["id"].clone();
    value["epoch"] = job["epoch"].clone();
    value["execution_id"] = job["payload"]["execution"]["id"].clone();
    value["run_id"] = job["payload"]["execution"]["run_id"].clone();
    value["bound_at"] = json!(now);
    save(db, "context_sessions", &string(&value, "id")?, &value)
}

pub(super) fn identity<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    if c.get("job_id").is_some() {
        let job = active(db, c, now)?;
        if job["kind"] != "agent" {
            return Err(Error::new(
                "FORBIDDEN",
                "Context access requires an agent attempt",
            ));
        }
        return Ok(json!({"run_id":job["payload"]["execution"]["run_id"],
            "execution_id":job["payload"]["execution"]["id"],"job_id":job["id"],"epoch":job["epoch"],
            "grant_id":job["external_grant"],"session_id":null}));
    }
    if c.get("session_id").is_some() {
        let value = session(db, c, now)?;
        return Ok(
            json!({"run_id":value["run_id"],"execution_id":value["execution_id"],
            "job_id":value["job_id"],"epoch":value["epoch"],"grant_id":value["grant_id"],"session_id":value["id"]}),
        );
    }
    Ok(
        json!({"run_id":null,"execution_id":null,"job_id":null,"epoch":null,
        "grant_id":c.get("_grant").cloned().unwrap_or(Value::Null),"session_id":null}),
    )
}
