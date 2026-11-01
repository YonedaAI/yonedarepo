//! An organization's audit log: a sibling authority instance (`audit:<org>`) whose
//! `workspace_events` rows are hash-chained, apart from the org's authority so that a full
//! log can't break org access. Sources are the authorities whose own events commit with the
//! state they record: the org's, the personal accounts of its members, whose events name the
//! orgs they concern (`orgs`), and its repositories (`repo_store/audit_outbox.rs`, `repo:<id>`).
//! The adapter copies events across after the action; a copy
//! that fails is taken up by the next one, since a source keeps its events and the log keeps
//! a cursor per source (`workspace_events` has no unique index, so the cursor is the dedupe).
//! Rows use `seq`, `kind` and `at` as they are; everything else is in `data`.
use super::audit_details::{actor, details};
use super::op::AuditOp;
use super::repo_names::repo_id;
use super::*;

const HEAD: &str = "audit_head";
const CURSOR: &str = "audit_cursor:";
/// Rows a read or a copy moves at once.
const PAGE: i64 = 200;
const VERIFY_PAGE: i64 = 2000;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: AuditOp) -> Result<Value> {
    match op {
        AuditOp::Targets => Ok(json!({ "orgs": super::orgs::hints(db)? })),
        AuditOp::Pending => pending(db, c),
        AuditOp::Cursor => Ok(json!({ "cursor": cursor(db, &source(c)?)? })),
        AuditOp::Append => append(db, c),
        AuditOp::Read => read(db, c),
        AuditOp::Verify => verify(db, c),
    }
}

/// The orgs a personal token's events go to: its org, if the account belongs to it. A
/// stranger can limit a token to any org name, and that says nothing to the org.
pub(super) fn token_orgs<S: SqlStore>(db: &S, org: &Value) -> Result<Vec<Value>> {
    let member = super::orgs::hints(db)?.contains(org);
    Ok(if member {
        vec![org.clone()]
    } else {
        Vec::new()
    })
}

fn source(c: &Value) -> Result<String> {
    let source = string(c, "source")?;
    let repo = source.strip_prefix("repo:").map(|id| json!({ "repo": id }));
    if !source.starts_with("account:") && !repo.is_some_and(|c| repo_id(&c).is_ok()) {
        return Err(bad("An audit source is an account or repository authority"));
    }
    Ok(source)
}

/// An event's data as its source vouches for it: a repository names itself by being the source.
fn sourced(event: &Value, source: &str) -> Value {
    let mut data = event["data"].clone();
    if let Some(repo) = source.strip_prefix("repo:") {
        data["repo"] = json!(repo);
    }
    data
}

fn limit(c: &Value, most: i64) -> i64 {
    c["limit"].as_i64().unwrap_or(most).clamp(1, most)
}

fn parsed(row: &Value) -> Result<Value> {
    serde_json::from_str(row["data"].as_str().unwrap_or_default())
        .map_err(|_| Error::new("DATABASE", "Corrupt audit row"))
}

/// `audit_pending {org, after}` on a source: its events after `after` that the org should
/// see, as stored. What may enter the log is decided by `append`, not here.
fn pending<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let org = string(c, "org")?;
    let after = crate::storage::number(c, "after")?;
    let own = get(db, "account").is_ok_and(|a| a["kind"] == "org" && a["username"] == org.as_str());
    let rows = if own {
        db.query(
            "SELECT seq,kind,at,data FROM workspace_events WHERE seq>? ORDER BY seq LIMIT ?",
            &[json!(after), json!(limit(c, PAGE))],
        )?
    } else {
        db.query(
            "SELECT seq,kind,at,data FROM workspace_events e WHERE seq>? AND EXISTS \
             (SELECT 1 FROM json_each(e.data,'$.orgs') WHERE value=?) ORDER BY seq LIMIT ?",
            &[json!(after), json!(org), json!(limit(c, PAGE))],
        )?
    };
    let events = rows
        .iter()
        .map(|row| {
            Ok(json!({"seq":row["seq"],"kind":row["kind"],"at":row["at"],"data":parsed(row)?}))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({ "events": events }))
}

fn cursor<S: SqlStore>(db: &S, source: &str) -> Result<i64> {
    Ok(match get(db, &format!("{CURSOR}{source}")) {
        Ok(record) => record["seq"].as_i64().unwrap_or_default(),
        Err(_) => 0,
    })
}

/// The last row's `(seq, hash)`, held apart from the rows so that losing the newest ones
/// shows. The first row's `previous` is empty.
fn head<S: SqlStore>(db: &S) -> Result<(i64, String)> {
    Ok(match get(db, HEAD) {
        Ok(head) => (
            head["seq"].as_i64().unwrap_or_default(),
            head["hash"].as_str().unwrap_or_default().to_owned(),
        ),
        Err(_) => (0, String::new()),
    })
}

/// A row's hash: the digest of the row and the previous row's hash, as `txlog` chains.
fn chained(previous: &str, row: &Value) -> Result<String> {
    yoneda_core::fingerprint(&json!({ "previous": previous, "row": row }))
}

/// The chained part of a stored row.
fn body(row: &Value, data: &Value) -> Value {
    json!({
        "seq": row["seq"], "kind": row["kind"], "at": row["at"], "actor": data["actor"],
        "source": data["source"], "source_seq": data["source_seq"], "details": data["details"],
    })
}

/// `audit_append {org, source, events}`: appends a source's events, each once. Events the
/// allow-list doesn't know move the cursor and leave no row.
fn append<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    if get(db, "account").is_ok() {
        return Err(bad("An account's authority holds no audit log"));
    }
    let org = string(c, "org")?;
    let source = source(c)?;
    let mut events = c["events"].as_array().cloned().unwrap_or_default();
    if events.len() as i64 > PAGE {
        return Err(bad("Too many audit events at once"));
    }
    events.sort_by_key(|event| event["seq"].as_i64());
    let mut seen = cursor(db, &source)?;
    let (mut seq, mut previous) = head(db)?;
    let mut appended = 0;
    for event in &events {
        let source_seq = crate::storage::number(event, "seq")?;
        if source_seq <= seen {
            continue;
        }
        seen = source_seq;
        let kind = string(event, "kind")?;
        let at = crate::storage::number(event, "at")?;
        let sent = sourced(event, &source);
        let Some(details) = details(&kind, &sent) else {
            continue;
        };
        seq += 1;
        let data = json!({
            "actor": actor(&sent, &org, &source), "source": source,
            "source_seq": source_seq, "details": details, "previous": previous,
        });
        let row = json!({ "seq": seq, "kind": kind, "at": at });
        let hash = chained(&previous, &body(&row, &data))?;
        let mut stored = data;
        stored["hash"] = json!(hash);
        db.query(
            "INSERT INTO workspace_events(seq,kind,at,data) VALUES(?,?,?,?)",
            &[
                json!(seq),
                json!(kind),
                json!(at),
                json!(stored.to_string()),
            ],
        )?;
        previous = hash;
        appended += 1;
    }
    put(db, &format!("{CURSOR}{source}"), &json!({ "seq": seen }))?;
    if appended > 0 {
        put(db, HEAD, &json!({ "seq": seq, "hash": previous }))?;
    }
    Ok(json!({ "appended": appended, "cursor": seen }))
}

/// `audit_read {before?, kind?, actor?, limit?}`: newest first; `next` is the `before` of
/// the next page. Pages by `seq`: many rows can share a time.
fn read<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let limit = limit(c, PAGE);
    let mut filters = Vec::new();
    let mut args = Vec::new();
    if let Some(before) = c["before"].as_i64() {
        filters.push(" AND seq<?");
        args.push(json!(before));
    }
    if let Some(kind) = c["kind"].as_str() {
        filters.push(" AND kind=?");
        args.push(json!(kind));
    }
    if let Some(actor) = c["actor"].as_str() {
        filters.push(" AND json_extract(data,'$.actor')=?");
        args.push(json!(actor));
    }
    args.push(json!(limit + 1));
    let mut rows = db.query(
        &format!(
            "SELECT seq,kind,at,data FROM workspace_events WHERE 1=1{} ORDER BY seq DESC LIMIT ?",
            filters.concat()
        ),
        &args,
    )?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let items = rows
        .iter()
        .map(|row| {
            let data = parsed(row)?;
            let mut item = body(row, &data);
            item["previous"] = data["previous"].clone();
            item["hash"] = data["hash"].clone();
            Ok(item)
        })
        .collect::<Result<Vec<_>>>()?;
    let next = more.then(|| items.last().map(|item| item["seq"].clone()));
    Ok(json!({ "items": items, "next": next.flatten() }))
}

/// `audit_verify {after?}`: walks the chain from the row after `after`, up to a page. A row
/// edited, removed or moved answers `broken_at`, its `seq`; so does losing the newest rows.
/// `next` continues a walk a page didn't finish.
fn verify<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let after = c["after"].as_i64().unwrap_or_default();
    let mut previous = String::new();
    if after > 0 {
        let start = db.query(
            "SELECT seq,data FROM workspace_events WHERE seq=?",
            &[json!(after)],
        )?;
        let Some(row) = start.first() else {
            return Ok(json!({ "ok": false, "broken_at": after, "checked": 0, "next": null }));
        };
        previous = parsed(row)?["hash"].as_str().unwrap_or_default().to_owned();
    }
    let page = limit(c, VERIFY_PAGE);
    let rows = db.query(
        "SELECT seq,kind,at,data FROM workspace_events WHERE seq>? ORDER BY seq LIMIT ?",
        &[json!(after), json!(page)],
    )?;
    let broken = |seq: i64, checked: usize| {
        Ok(json!({ "ok": false, "broken_at": seq, "checked": checked, "next": null }))
    };
    let mut seq = after;
    for (checked, row) in rows.iter().enumerate() {
        seq += 1;
        let Ok(data) = parsed(row) else {
            return broken(seq, checked);
        };
        let hash = chained(&previous, &body(row, &data))?;
        if row["seq"] != seq || data["previous"] != previous.as_str() || data["hash"] != hash {
            return broken(seq, checked);
        }
        previous = hash;
    }
    if rows.len() as i64 == page {
        return Ok(json!({ "ok": true, "checked": rows.len(), "next": seq }));
    }
    let (last, hash) = head(db)?;
    if seq != last || previous != hash {
        return broken(seq + 1, rows.len());
    }
    Ok(json!({ "ok": true, "checked": rows.len(), "next": null }))
}
