//! Initial owner assertions seed disposable studies without dispatching an agent job.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Result, context::ContextInput};

pub(super) fn initialize<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<()> {
    let Some(seed) = c.get("context_seed") else {
        return Ok(());
    };
    let id = string(seed, "intent_id")?;
    let statement = string(seed, "statement")?;
    let records = seed["records"]
        .as_array()
        .ok_or_else(|| bad("Context seed records required"))?;
    if !id.starts_with("intent:") || id.len() > 256 || statement.len() > 8192 || records.len() > 16
    {
        return Err(bad("Initial owner context must be bounded"));
    }
    node(
        db,
        &id,
        "intent",
        &statement,
        "owner",
        now,
        json!({"statement":statement,"authority":"assertion","source":"owner_bootstrap"}),
    )?;
    for value in records {
        let mut record = value.clone();
        record["intent_id"] = json!(id);
        let typed: ContextInput =
            serde_json::from_value(record.clone()).map_err(|e| bad(&e.to_string()))?;
        typed.validate()?;
        super::typed_context::handle(db, json!({"op":"context_publish","record":record}), now)?;
    }
    Ok(())
}
