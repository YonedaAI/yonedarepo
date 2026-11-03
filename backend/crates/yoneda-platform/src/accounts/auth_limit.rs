//! One global sign-in allowance per adapter-derived key; no region or raw IP is stored.
use super::*;

const WINDOW_MS: i64 = 60_000;
const LIMIT: usize = 30;

pub(super) fn admit<S: SqlStore>(db: &S, command: &Value, now: i64) -> Result<Value> {
    if now < 0 {
        return Err(bad("Invalid trusted clock"));
    }
    let request = hash(command, "request", &[32])?;
    let mut state = match get(db, "auth_rate") {
        Ok(state) => state,
        Err(e) if e.code == "NOT_FOUND" => json!({"start":now,"seen":[]}),
        Err(e) => return Err(e),
    };
    let start = state["start"]
        .as_i64()
        .ok_or_else(|| bad("Invalid rate state"))?;
    if now >= start.saturating_add(WINDOW_MS) {
        state = json!({"start":now,"seen":[]});
    }
    let seen = state["seen"]
        .as_array_mut()
        .ok_or_else(|| bad("Invalid rate state"))?;
    if seen.iter().any(|id| id == &request) {
        return Ok(json!({"success":true}));
    }
    if seen.len() >= LIMIT {
        return Ok(json!({"success":false}));
    }
    seen.push(json!(request));
    put(db, "auth_rate", &state)?;
    Ok(json!({"success":true}))
}
