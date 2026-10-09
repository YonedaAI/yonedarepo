//! Paginated access receipts and full-run evidence counts for agents and developers.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    context_usage::{UsageCounts, UsageCoverage, UsagePage},
};

pub(super) fn read<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    repo(db)?;
    let identity = super::context_sessions::identity(db, &c, now)?;
    let requested = c
        .get("run_id")
        .filter(|v| !v.is_null())
        .map(|_| string(&c, "run_id"))
        .transpose()?;
    if c.get("job_id").is_some()
        && requested
            .as_ref()
            .is_some_and(|id| identity["run_id"] != *id)
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Hosted context usage is scoped to the current run",
        ));
    }
    let run_id = requested.or_else(|| identity["run_id"].as_str().map(str::to_owned));
    if run_id.is_none() && identity["grant_id"].is_null() {
        return Err(bad("Choose a run for context usage"));
    }
    let cursor = integer(&c, "cursor", 0, 0, i64::MAX)?;
    let limit = integer(&c, "limit", 50, 1, 100)?;
    let epoch = c
        .get("epoch")
        .filter(|_| c.get("job_id").is_none())
        .map(|_| integer(&c, "epoch", 1, 1, i64::MAX))
        .transpose()?;
    // Hosted epoch authenticates the caller. A separate filter never alters its identity.
    let filter_epoch = c
        .get("filter_epoch")
        .map(|_| integer(&c, "filter_epoch", 1, 1, i64::MAX))
        .transpose()?
        .or(epoch);
    let execution_id = c
        .get("execution_id")
        .filter(|v| !v.is_null())
        .map(|_| string(&c, "execution_id"))
        .transpose()?;
    if let Some(id) = &execution_id {
        let execution = get(db, "executions", id)?;
        if run_id
            .as_ref()
            .is_none_or(|run| execution["run_id"] != *run)
        {
            return Err(Error::new("FORBIDDEN", "Execution belongs to another run"));
        }
    }
    let (scope, params) = if let Some(run) = &run_id {
        ("run_id=?", vec![json!(run)])
    } else {
        (
            "run_id IS NULL AND grant_id=?",
            vec![identity["grant_id"].clone()],
        )
    };
    let counts = db.query(
        &format!("SELECT COUNT(*) AS read_calls FROM context_access WHERE {scope}"),
        &params,
    )?;
    let returned = distinct(db, scope, &params, "returned")?;
    let opened = distinct(db, scope, &params, "opened")?;
    let (assigned, assigned_count, citations, cited_count, checked, tracked, citations_truncated) =
        if let Some(id) = &run_id {
            let run = get(db, "runs", id)?;
            let executions = run_executions(db, id)?;
            let checked = super::context_evidence::checked(db, id)?;
            let (assigned, assigned_count) =
                super::context_evidence::assigned(db, &run, &executions)?;
            let (citations, cited_count, truncated) =
                super::context_evidence::citations(db, &executions, &checked)?;
            (
                assigned,
                assigned_count,
                citations,
                cited_count,
                checked,
                run["context_usage_version"] == 1,
                truncated,
            )
        } else {
            (vec![], 0, vec![], 0, vec![], false, false)
        };
    let mut page_params = params.clone();
    page_params.extend([
        json!(cursor),
        json!(execution_id),
        json!(execution_id),
        json!(filter_epoch),
        json!(filter_epoch),
        json!(limit + 1),
    ]);
    let rows = db.query(&format!("SELECT seq,at,data FROM context_access WHERE {scope} AND seq>? AND (? IS NULL OR execution_id=?) AND (? IS NULL OR epoch=?) ORDER BY seq LIMIT ?"), &page_params)?;
    let has_more =
        rows.len() > usize::try_from(limit).map_err(|_| bad("Invalid access page size"))?;
    let mut entries = Vec::new();
    for row in rows
        .into_iter()
        .take(usize::try_from(limit).map_err(|_| bad("Invalid access page size"))?)
    {
        let mut entry: Value = serde_json::from_str(
            row["data"]
                .as_str()
                .ok_or_else(|| bad("Corrupt access receipt"))?,
        )
        .map_err(|_| bad("Corrupt access receipt"))?;
        let mut targets = Vec::new();
        for target in entry["targets"].as_array().into_iter().flatten() {
            targets.push(super::context_evidence::target(
                db,
                &string(target, "id")?,
                target["digest"].as_str(),
            )?);
        }
        entry["seq"] = row["seq"].clone();
        entry["at"] = row["at"].clone();
        entry["targets"] = json!(targets);
        if let Some(fields) = entry.as_object_mut() {
            fields.remove("grant_id");
        }
        entries.push(entry);
    }
    let next_cursor = entries
        .last()
        .map_or(cursor, |entry| entry["seq"].as_i64().unwrap_or(cursor));
    let read_calls = u64::try_from(number(&counts[0], "read_calls")?)
        .map_err(|_| bad("Invalid access count"))?;
    let coverage = UsageCoverage { status: if tracked { "recorded" } else if read_calls > 0 { "partial" } else { "unavailable" }.into(),
        reason: if tracked { "Successful MCP delivery has been tracked since this run began; delivery does not prove model use." }
        else if run_id.is_none() { "These grant reads were not assigned to a run. Session binding never reassigns earlier reads." }
        else { "This run predates access tracking. Assigned inputs, explicit citations and checks remain evidence; earlier reads are unknown." }.into(),
        activated_at: super::context_access::activation(db, now)? };
    let page = UsagePage {
        version: 1,
        run_id,
        coverage,
        counts: UsageCounts {
            assigned: assigned_count as u64,
            returned,
            opened,
            cited: cited_count as u64,
            checked: checked.len() as u64,
            read_calls,
        },
        assigned: decode(assigned)?,
        entries: decode(entries)?,
        citations: decode(citations)?,
        checked: decode(checked)?,
        next_cursor,
        has_more,
        citations_truncated,
    };
    serde_json::to_value(page).map_err(|_| bad("Cannot serialize context usage"))
}
fn integer(c: &Value, key: &str, default: i64, min: i64, max: i64) -> Result<i64> {
    c.get(key).map_or(Ok(default), |value| {
        value
            .as_i64()
            .filter(|value| (min..=max).contains(value))
            .ok_or_else(|| bad("Invalid context usage cursor, filter or page size"))
    })
}
fn distinct<S: SqlStore>(db: &S, scope: &str, params: &[Value], stage: &str) -> Result<u64> {
    let mut params = params.to_vec();
    params.push(json!(stage));
    let rows = db.query(&format!("SELECT COUNT(DISTINCT json_extract(target.value,'$.id')) AS count FROM context_access,json_each(context_access.data,'$.targets') target WHERE {scope} AND stage=?"), &params)?;
    u64::try_from(number(&rows[0], "count")?).map_err(|_| bad("Invalid context access count"))
}
fn decode<T: serde::de::DeserializeOwned>(values: Vec<Value>) -> Result<Vec<T>> {
    values
        .into_iter()
        .map(|value| {
            serde_json::from_value(value).map_err(|_| bad("Invalid recorded context evidence"))
        })
        .collect()
}
