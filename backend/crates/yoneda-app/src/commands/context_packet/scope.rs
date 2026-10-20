//! Study retrieval uses frozen selected records, never an unrestricted page filtered afterward.
use super::*;
use yoneda_agents_core::Error;

pub(super) fn run<S: SqlStore>(db: &S, job: &Value) -> Result<Value> {
    let run = get(db, "runs", &string(&job["payload"]["execution"], "run_id")?)?;
    if let Some(study) = run.get("context_study")
        && study["arm"] != "graph"
    {
        return Err(Error::new(
            "FORBIDDEN",
            "CONTEXT_STUDY_RESTRICTED: historical retrieval is unavailable in this trial",
        ));
    }
    Ok(run)
}

pub(super) fn records<S: SqlStore>(
    db: &S,
    run: &Value,
    watermark: i64,
) -> Result<Option<Vec<Value>>> {
    let Some(study) = run.get("context_study") else {
        return Ok(None);
    };
    let corpus = study["corpus"]
        .as_array()
        .ok_or_else(|| bad("Missing frozen study corpus"))?;
    let frozen = study["records"]
        .as_array()
        .ok_or_else(|| bad("Missing frozen study records"))?;
    let mut records = Vec::new();
    let mut ids = BTreeSet::new();
    for id in corpus {
        let value = frozen
            .iter()
            .find(|record| record["id"] == *id)
            .ok_or_else(|| bad("Selected study record is not frozen"))?;
        ids.insert(string(value, "id")?);
        records.push(value.clone());
    }
    let rows=db.query("SELECT n.payload FROM nodes n JOIN executions e ON e.id=json_extract(n.payload,'$.author') WHERE json_extract(e.payload,'$.run_id')=? AND json_extract(n.payload,'$.data.intent_id')=? AND n.rowid<=? ORDER BY CAST(json_extract(n.payload,'$.recorded_at') AS INTEGER) DESC,n.id LIMIT 1000",&[run["id"].clone(),json!(format!("intent:{}",string(run,"id")?)),json!(watermark)])?;
    for row in rows {
        let value: Value = serde_json::from_str(
            row["payload"]
                .as_str()
                .ok_or_else(|| bad("Corrupt current context"))?,
        )
        .map_err(|e| bad(&e.to_string()))?;
        if ids.insert(string(&value, "id")?) {
            records.push(value);
        }
    }
    Ok(Some(records))
}

pub(in crate::commands) fn get_for_job<S: SqlStore>(
    db: &S,
    job: &Value,
    id: &str,
) -> Result<Value> {
    let run = run(db, job)?;
    let watermark = number(
        &db.query("SELECT COALESCE(MAX(rowid),0) AS watermark FROM nodes", &[])?[0],
        "watermark",
    )?;
    if let Some(records) = records(db, &run, watermark)? {
        return records
            .into_iter()
            .find(|record| record["id"] == id)
            .ok_or_else(|| {
                Error::new(
                    "FORBIDDEN",
                    "Context record is outside the frozen study corpus and current run",
                )
            });
    }
    get(db, "nodes", id)
}
