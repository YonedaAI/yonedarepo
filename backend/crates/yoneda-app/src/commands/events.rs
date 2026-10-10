use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
pub(super) fn handle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    match string(&c, "op")?.as_str() {
        "outbox" => {
            let rows = db.query(
                "SELECT id,kind,payload FROM outbox WHERE delivered=0 ORDER BY rowid LIMIT 50",
                &[],
            )?;
            let jobs:Vec<_>=rows.iter().map(|r|json!({"id":r["id"],"kind":r["kind"],"payload":serde_json::from_str::<Value>(r["payload"].as_str().unwrap_or("{}")).unwrap_or(Value::Null)})).collect();
            Ok(json!({"jobs":jobs}))
        }
        "outbox_sent" => {
            db.query(
                "UPDATE outbox SET delivered=1 WHERE id=?",
                &[json!(string(&c, "id")?)],
            )?;
            Ok(json!({"ok":true}))
        }
        "outbox_prune" => prune_outbox_payloads(db, now),
        "events" => {
            let rows = db.query(
                "SELECT seq,kind,at,data FROM events WHERE seq>? ORDER BY seq LIMIT 200",
                &[json!(c["after"].as_i64().unwrap_or_default())],
            )?;
            Ok(
                json!({"events":rows.into_iter().map(|mut r|{r["data"]=serde_json::from_str(r["data"].as_str().unwrap_or("null")).unwrap_or(Value::Null);r}).collect::<Vec<_>>()}),
            )
        }
        _ => Err(Error::new("NOT_FOUND", "Unknown operation")),
    }
}
