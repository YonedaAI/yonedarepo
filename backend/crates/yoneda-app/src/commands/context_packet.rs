//! Deterministic ranked retrieval frozen at run approval, with explicit bounded coverage.
use crate::storage::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_agents_core::Result;
mod ranking;
mod scope;
use ranking::{Selection, ranked};
pub(super) use scope::get_for_job;
const MAX_PACKET_BYTES: usize = 64 * 1024;

pub(super) fn search<S: SqlStore>(db: &S, c: &Value, job: Option<&Value>) -> Result<Value> {
    let run = job.map(|job| scope::run(db, job)).transpose()?;
    let query = c.get("query").and_then(Value::as_str).unwrap_or("");
    let file = c.get("file_path").and_then(Value::as_str);
    let authority = c.get("authority").and_then(Value::as_str);
    let lineage = c
        .get("lineage")
        .and_then(Value::as_str)
        .or_else(|| run.as_ref().and_then(|run| run["id"].as_str()));
    let count = c.get("limit").and_then(Value::as_u64).unwrap_or(25);
    if !(1..=50).contains(&count) {
        return Err(bad("Ranked context limit is 1–50"));
    }
    let kind = c.get("kind").and_then(Value::as_str);
    let mut identity =
        json!({"query":query,"file":file,"authority":authority,"lineage":lineage,"kind":kind});
    if let Some(run) = &run {
        identity["run_id"] = run["id"].clone();
        identity["study"] = run["context_study"].clone();
    }
    let fingerprint = yoneda_agents_core::fingerprint(&identity)?;
    let latest = db.query("SELECT COALESCE(MAX(rowid),0) AS watermark FROM nodes", &[])?;
    let latest = number(&latest[0], "watermark")?;
    let (offset, watermark) = if let Some(cursor) = c["cursor"].as_str().filter(|v| !v.is_empty()) {
        if cursor.len() > 256 {
            return Err(bad("Context cursor exceeds limit"));
        }
        let parsed: Value =
            serde_json::from_str(cursor).map_err(|_| bad("Invalid ranked context cursor"))?;
        if parsed["fingerprint"] != fingerprint {
            return Err(bad("Context cursor does not match the query"));
        }
        let watermark = number(&parsed, "watermark")?;
        if watermark < 0 || watermark > latest {
            return Err(bad("Invalid context watermark"));
        }
        (
            usize::try_from(
                parsed["offset"]
                    .as_u64()
                    .filter(|v| *v <= 200)
                    .ok_or_else(|| bad("Invalid context offset"))?,
            )
            .map_err(|_| bad("Invalid context offset"))?,
            watermark,
        )
    } else {
        (0, latest)
    };
    let count = usize::try_from(count).map_err(|_| bad("Invalid context count"))?;
    let records = run
        .as_ref()
        .map(|run| scope::records(db, run, watermark))
        .transpose()?
        .flatten();
    let all = ranked(
        db,
        &Selection {
            query,
            file,
            authority,
            lineage,
            kind,
            watermark,
            records: records.as_deref(),
        },
        200,
    )?;
    let items = all
        .iter()
        .skip(offset)
        .take(count)
        .cloned()
        .collect::<Vec<_>>();
    let more = offset + items.len() < all.len();
    let cursor = more.then(|| {
        json!({"offset":offset+items.len(),"fingerprint":fingerprint,"watermark":watermark})
            .to_string()
    });
    Ok(
        json!({"items":items,"next_cursor":cursor,"coverage":if records.is_some(){"ranked frozen study corpus and bounded current-run authored context"}else{"ranked top 200 matches from most recent 1000 context records"},"bounded":true,"watermark":watermark}),
    )
}

pub(super) fn freeze<S: SqlStore>(db: &S, run: &mut Value, branch: Option<&Value>) -> Result<()> {
    let mut records = run["context_records"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut ids: BTreeSet<String> = records
        .iter()
        .filter_map(|v| v["id"].as_str().map(str::to_owned))
        .collect();
    let mut bytes = serde_json::to_vec(&records)
        .map_err(|e| bad(&e.to_string()))?
        .len();
    if bytes > MAX_PACKET_BYTES {
        return Err(bad("Assigned context exceeds the 64 KiB packet budget"));
    }
    let previous = branch
        .and_then(|b| b["latest_candidate_id"].as_str())
        .map(|id| get(db, "candidates", id))
        .transpose()?;
    let prior_run = previous
        .as_ref()
        .and_then(|v| v["run_id"].as_str())
        .unwrap_or("");
    let goal: String = string(run, "intent")?.chars().take(128).collect();
    let watermark = number(
        &db.query("SELECT COALESCE(MAX(rowid),0) AS watermark FROM nodes", &[])?[0],
        "watermark",
    )?;
    let rows = ranked(
        db,
        &Selection {
            query: &goal,
            file: None,
            authority: None,
            lineage: (!prior_run.is_empty()).then_some(prior_run),
            kind: None,
            watermark,
            records: None,
        },
        200,
    )?;
    let mut omitted = 0;
    for value in rows {
        let id = string(&value, "id")?;
        if ids.contains(&id) {
            continue;
        }
        let size = serde_json::to_vec(&value)
            .map_err(|e| bad(&e.to_string()))?
            .len();
        if records.len() >= 50 || bytes + size > MAX_PACKET_BYTES {
            omitted += 1;
            continue;
        }
        ids.insert(id);
        bytes += size;
        records.push(value);
    }
    run["context"] = json!(records.iter().map(|r| r["id"].clone()).collect::<Vec<_>>());
    run["context_records"] = json!(records);
    run["context_packet"] = json!({"version":1,"digest":yoneda_agents_core::fingerprint(&run["context_records"])?
        ,"source_revision":run["base"],"prior_run_id":(!prior_run.is_empty()).then_some(prior_run),"record_count":ids.len(),"bytes":bytes,"max_bytes":MAX_PACKET_BYTES,"omitted_ranked_records":omitted,"coverage":"ranked retrieval; not the complete repository history"});
    Ok(())
}
