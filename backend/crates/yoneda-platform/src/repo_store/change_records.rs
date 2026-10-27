//! Change records for analytics: one per landed log version, one per commit a platform
//! merge landed along with it, and one per refused queued landing. The derive job reads
//! them after landing and streams them off the commit path. Records carry identifiers,
//! counts and times only: never file contents, paths, messages or credentials.
use super::rows::{self, current_version};
use super::symbols;
use crate::storage::SqlStore;
use serde_json::{Map, Value, json};
use yoneda_core::{Result, git_object::ObjectId, txlog::TxEntry};

const MAX_RECORDS: u64 = 100;

/// Records for versions after `after_version` (at most `limit` versions) and refusals of
/// tickets after `after_ticket`. Returns the cursors to resume from: `version` and
/// `ticket`, the highest ticket below which every queued landing has finished.
pub fn records<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let after = c["after_version"].as_u64().unwrap_or(0);
    let limit = c["limit"]
        .as_u64()
        .unwrap_or(MAX_RECORDS)
        .clamp(1, MAX_RECORDS);
    let head = current_version(db)?;
    let until = head.min(after.saturating_add(limit));
    let mut lands = Vec::new();
    for entry in rows::entries(db, after, until, None)? {
        lands.extend(version_records(db, &entry)?);
    }
    let (refusals, ticket) = refusals(db, c["after_ticket"].as_i64().unwrap_or(0), limit)?;
    Ok(json!({
        "records": lands.into_iter().chain(refusals).collect::<Vec<_>>(),
        "version": until, "head_version": head, "ticket": ticket,
    }))
}

/// The entry's own record plus a `merged` record per commit landed in the same version.
fn version_records<S: SqlStore>(db: &S, entry: &TxEntry) -> Result<Vec<Value>> {
    let landed = db.query(
        "SELECT commit_id FROM landings WHERE version=? ORDER BY commit_id",
        &[json!(entry.version)],
    )?;
    let head = entry.new.map(|id| id.hex());
    let merged: Vec<ObjectId> = landed
        .iter()
        .filter_map(|r| r["commit_id"].as_str())
        .filter(|id| Some(*id) != head.as_deref())
        .map(ObjectId::parse)
        .collect::<Result<_>>()?;
    let mut own = Map::new();
    own.insert("event".into(), json!("land"));
    own.insert("kind".into(), json!(entry.kind));
    own.insert("actor".into(), json!(entry.actor));
    own.insert("paths_changed".into(), json!(entry.paths.len()));
    own.insert("read_set_size".into(), json!(entry.read_set.len()));
    own.insert("base_version".into(), json!(entry.base_version));
    own.insert(
        "base_lag".into(),
        json!(entry.version.saturating_sub(entry.base_version + 1)),
    );
    own.insert("merged_landings".into(), json!(merged.len()));
    if let Some(id) = entry.new {
        commit_facts(db, &id, &entry.refname, &mut own)?;
    }
    let mut out = vec![finish(own, entry)];
    for id in merged {
        let mut record = Map::new();
        record.insert("event".into(), json!("merged"));
        commit_facts(db, &id, &entry.refname, &mut record)?;
        let writer = record.get("writer").cloned().unwrap_or(Value::Null);
        // The landing was requested by whoever queued it; the writer made the commit.
        let actor = record.get("queued_by").cloned().unwrap_or(writer);
        record.insert("actor".into(), actor);
        out.push(finish(record, entry));
    }
    Ok(out)
}

/// Fields every landed record shares, and the times derived from them.
fn finish(mut record: Map<String, Value>, entry: &TxEntry) -> Value {
    record.insert("version".into(), json!(entry.version));
    record.insert("ref".into(), json!(entry.refname));
    record.insert("occurred_at_ms".into(), json!(entry.committed_at_ms));
    if let Some(recorded) = record.get("recorded_at_ms").and_then(Value::as_i64) {
        record.insert(
            "land_latency_ms".into(),
            json!(entry.committed_at_ms - recorded),
        );
    }
    labelled(record)
}

/// Adds the actor's kind: the principal's prefix (`token`, `platform`, `user`, ...).
fn labelled(mut record: Map<String, Value>) -> Value {
    let kind = record
        .get("actor")
        .and_then(Value::as_str)
        .map(|actor| actor.split_once(':').map_or("other", |(kind, _)| kind))
        .unwrap_or("other")
        .to_owned();
    record.insert("actor_kind".into(), json!(kind));
    Value::Object(record)
}

/// What the authority knows about a landed commit: graph, writer, review and checks.
fn commit_facts<S: SqlStore>(
    db: &S,
    id: &ObjectId,
    refname: &str,
    out: &mut Map<String, Value>,
) -> Result<()> {
    let key = [json!(id.hex())];
    out.insert("commit".into(), json!(id));
    if let Some(row) = rows::commit_row(db, id)? {
        out.insert("parents".into(), json!(row.parents));
        out.insert("writer".into(), json!(row.principal));
        out.entry("read_set_size")
            .or_insert(json!(row.read_set.len()));
    }
    if let Some(row) = db
        .query("SELECT recorded_at FROM commits WHERE id=?", &key)?
        .first()
    {
        out.insert("recorded_at_ms".into(), row["recorded_at"].clone());
    } else if let Some(row) = db
        .query(
            "SELECT parents,writer,recorded_at FROM changesets WHERE commit_id=? AND parents IS NOT NULL",
            &key,
        )?
        .first()
    {
        // Landed from its shard record, never adopted: the facts its changeset kept.
        let parents: Value = serde_json::from_str(row["parents"].as_str().unwrap_or("[]"))
            .map_err(|_| rows::corrupt("changeset parents"))?;
        out.insert("parents".into(), parents);
        out.insert("writer".into(), row["writer"].clone());
        out.insert("recorded_at_ms".into(), row["recorded_at"].clone());
    }
    out.entry("paths_changed")
        .or_insert(json!(rows::touches(db, id)?.len()));
    let touches = symbols::for_commit(db, id)?;
    if !touches.is_empty() {
        let written: usize = touches.iter().map(|t| t.symbols.len()).sum();
        out.insert("write_set_size".into(), json!(written));
    }
    if let Some(row) = db
        .query("SELECT overall FROM commit_classes WHERE commit_id=?", &key)?
        .first()
    {
        out.insert("review_class".into(), row["overall"].clone());
    }
    // Latest result per check name, whatever policy it was recorded under.
    let mut checks: Vec<(String, String)> = Vec::new();
    for row in db.query(
        "SELECT name,status FROM checks WHERE commit_id=? ORDER BY name,recorded_at",
        &key,
    )? {
        let (name, status) = (
            row["name"].as_str().unwrap_or_default().to_owned(),
            row["status"].as_str().unwrap_or_default().to_owned(),
        );
        match checks.last_mut() {
            Some(last) if last.0 == name => last.1 = status,
            _ => checks.push((name, status)),
        }
    }
    let count = |want: &str| checks.iter().filter(|(_, s)| s == want).count();
    out.insert("checks_passed".into(), json!(count("pass")));
    out.insert("checks_failed".into(), json!(count("fail")));
    out.insert(
        "checks".into(),
        json!(
            checks
                .iter()
                .map(|(n, s)| format!("{n}:{s}"))
                .collect::<Vec<_>>()
        ),
    );
    let runs = &db.query(
        "SELECT COUNT(*) AS n, COALESCE(SUM(finished_at-created_at),0) AS ms FROM check_runs WHERE commit_id=? AND finished_at IS NOT NULL",
        &key,
    )?[0];
    out.insert("check_runs".into(), runs["n"].clone());
    out.insert("check_run_ms".into(), runs["ms"].clone());
    let repairs = &db.query("SELECT COUNT(*) AS n FROM repairs WHERE commit_id=?", &key)?[0];
    out.insert("repairs".into(), repairs["n"].clone());
    if let Some(row) = db
        .query(
            "SELECT ticket,principal,requested_at,finished_at FROM land_queue WHERE commit_id=? AND refname=? AND status='landed' ORDER BY ticket DESC LIMIT 1",
            &[json!(id.hex()), json!(refname)],
        )?
        .first()
    {
        out.insert("ticket".into(), row["ticket"].clone());
        out.insert("queued_by".into(), row["principal"].clone());
        if let (Some(start), Some(end)) = (row["requested_at"].as_i64(), row["finished_at"].as_i64()) {
            out.insert("queue_wait_ms".into(), json!(end - start));
        }
    }
    Ok(())
}

/// Failed queued landings after `after`, and the next ticket watermark. A ticket above the
/// lowest still-pending one can be read again later; consumers dedupe on the ticket.
pub(super) fn refusals<S: SqlStore>(db: &S, after: i64, limit: u64) -> Result<(Vec<Value>, i64)> {
    let rows = db.query(
        "SELECT ticket,refname,commit_id,principal,requested_at,finished_at,result FROM land_queue WHERE status='failed' AND ticket>? ORDER BY ticket LIMIT ?",
        &[json!(after), json!(limit)],
    )?;
    let pending = db.query(
        "SELECT MIN(ticket) AS t FROM land_queue WHERE status='pending'",
        &[],
    )?[0]["t"]
        .as_i64();
    let highest = db.query("SELECT COALESCE(MAX(ticket),0) AS t FROM land_queue", &[])?[0]["t"]
        .as_i64()
        .unwrap_or(0);
    let mut watermark = pending.map_or(highest, |t| t - 1).max(after);
    if rows.len() as u64 == limit
        && let Some(last) = rows.last().and_then(|r| r["ticket"].as_i64())
    {
        watermark = watermark.min(last);
    }
    let records = rows
        .iter()
        .map(|row| {
            let code = row["result"]
                .as_str()
                .and_then(|r| serde_json::from_str::<Value>(r).ok())
                .and_then(|r| r["code"].as_str().map(str::to_owned));
            let mut record = Map::new();
            record.insert("event".into(), json!("refused"));
            record.insert("ticket".into(), row["ticket"].clone());
            record.insert("ref".into(), row["refname"].clone());
            record.insert("commit".into(), row["commit_id"].clone());
            record.insert("actor".into(), row["principal"].clone());
            record.insert("occurred_at_ms".into(), row["finished_at"].clone());
            record.insert("error_code".into(), json!(code));
            if let (Some(start), Some(end)) =
                (row["requested_at"].as_i64(), row["finished_at"].as_i64())
            {
                record.insert("queue_wait_ms".into(), json!(end - start));
            }
            labelled(record)
        })
        .collect();
    Ok((records, watermark))
}
