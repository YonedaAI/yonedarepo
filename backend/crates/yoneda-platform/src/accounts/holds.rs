//! Legal holds, kept in the owner's account authority: `legal_hold` covers everything the
//! account owns, `legal_hold:<repo>` one repository. No migration: both are records.
//!
//! A hold has up to two layers, each with who set it and when: `owner` (an org's owners, for
//! the org and its repositories) and `operator` (the platform's operators, also on a
//! personal account's repository). A hold stands while either layer does, and each side
//! lifts only its own, so an owner can never release an operator's hold. Setting a layer
//! twice keeps the first; releasing one that is not there changes nothing. Every change
//! writes a `legal_hold.*` event, which an org's audit log takes up (`audit_details`), and
//! the adapter adds `admin_audit` for operators.
//!
//! `hold_check` is the answer a repository's destructive ops wait for
//! (`repo_store::legal_hold`). Deleting an org checks here directly, in its own transaction.
use super::op::HoldOp;
use super::*;

const ORG: &str = "legal_hold";
const OWNER: &str = "owner";
const OPERATOR: &str = "operator";

/// The record of `repo` when the command names one, of the whole account otherwise.
fn record_id(c: &Value) -> Result<String> {
    match &c["repo"] {
        Value::Null => Ok(ORG.to_owned()),
        Value::String(repo)
            if repo.len() == 21
                && repo.starts_with('r')
                && repo[1..]
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) =>
        {
            Ok(format!("{ORG}:{repo}"))
        }
        _ => Err(bad("repo must be a repository id")),
    }
}

fn parsed(row: &Value) -> Result<Value> {
    let payload = row["payload"].as_str().ok_or_else(|| bad("Corrupt hold"))?;
    serde_json::from_str(payload).map_err(|e| Error::new("DATABASE", e.to_string()))
}

fn read<S: SqlStore>(db: &S, id: &str) -> Result<Value> {
    let rows = db.query(
        &format!("SELECT payload FROM {TABLE} WHERE id=?"),
        &[json!(id)],
    )?;
    rows.first().map_or(Ok(json!({})), parsed)
}

/// Whether any hold stands on this account or anything it owns.
fn any<S: SqlStore>(db: &S) -> Result<bool> {
    let rows = db.query(
        &format!("SELECT 1 AS x FROM {TABLE} WHERE id=?1 OR id GLOB ?1||':*' LIMIT 1"),
        &[json!(ORG)],
    )?;
    Ok(!rows.is_empty())
}

/// `LEGAL_HOLD` when a hold stands here, unless the adapter's switch is off.
pub(super) fn refuse_org_delete<S: SqlStore>(db: &S, c: &Value) -> Result<()> {
    if c["_hold"] != "off" && any(db)? {
        return Err(Error::new(
            "LEGAL_HOLD",
            "This organization is under a legal hold: it cannot be deleted until the hold is \
             released",
        ));
    }
    Ok(())
}

fn set<S: SqlStore>(db: &S, c: &Value, layer: &str, by: &str, now: i64) -> Result<Value> {
    let id = record_id(c)?;
    let mut hold = read(db, &id)?;
    if hold[layer].is_null() {
        hold[layer] = json!({ "at": now, "by": by });
        put(db, &id, &hold)?;
        let event = json!({ "repo": c["repo"], "layer": layer, "actor": by });
        audit(db, "legal_hold.set", now, event)?;
    }
    Ok(json!({ "hold": hold }))
}

fn release<S: SqlStore>(db: &S, c: &Value, layer: &str, by: &str, now: i64) -> Result<Value> {
    let id = record_id(c)?;
    let mut hold = read(db, &id)?;
    let Some(layers) = hold.as_object_mut().filter(|h| h.contains_key(layer)) else {
        return Ok(json!({ "released": false, "hold": hold }));
    };
    layers.remove(layer);
    if layers.is_empty() {
        db.query(&format!("DELETE FROM {TABLE} WHERE id=?"), &[json!(id)])?;
    } else {
        put(db, &id, &hold)?;
    }
    let event = json!({ "repo": c["repo"], "layer": layer, "actor": by });
    audit(db, "legal_hold.released", now, event)?;
    Ok(json!({ "released": true, "hold": hold }))
}

/// `org_hold_set {repo?}`: an owner holds the org, or one of its repositories (the adapter
/// has checked that the org owns it). `by` is the owner.
pub(super) fn owner_set<S: SqlStore>(db: &S, c: &Value, by: &str, now: i64) -> Result<Value> {
    set(db, c, OWNER, by, now)
}

/// `org_hold_release {repo?}`: an owner lifts the owners' layer. An operator's alone is not
/// theirs to touch, and saying so beats answering that nothing was released.
pub(super) fn owner_release<S: SqlStore>(db: &S, c: &Value, by: &str, now: i64) -> Result<Value> {
    let hold = read(db, &record_id(c)?)?;
    if hold[OWNER].is_null() && !hold[OPERATOR].is_null() {
        return Err(Error::new(
            "FORBIDDEN",
            "An operator set this hold; only an operator can release it",
        ));
    }
    release(db, c, OWNER, by, now)
}

/// `org_hold_show`: the org's hold and its repositories' (empty layers: none), for members.
pub(super) fn show<S: SqlStore>(db: &S) -> Result<Value> {
    let rows = db.query(
        &format!("SELECT id,payload FROM {TABLE} WHERE id=?1 OR id GLOB ?1||':*'"),
        &[json!(ORG)],
    )?;
    let mut org = Value::Null;
    let mut repos = serde_json::Map::new();
    for row in &rows {
        let id = row["id"].as_str().unwrap_or_default();
        match id.strip_prefix(ORG).and_then(|r| r.strip_prefix(':')) {
            Some(repo) => {
                repos.insert(repo.to_owned(), parsed(row)?);
            }
            None => org = parsed(row)?,
        }
    }
    Ok(json!({ "org": org, "repos": repos }))
}

/// `hold_check {repo}`: whether `repo` of this owner is held, and by what. One statement.
fn check<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let repo = record_id(c)?;
    let rows = db.query(
        &format!("SELECT id,payload FROM {TABLE} WHERE id IN (?,?)"),
        &[json!(ORG), json!(repo)],
    )?;
    let of = |id: &str| {
        rows.iter()
            .find(|r| r["id"] == id)
            .map_or(Ok(Value::Null), parsed)
    };
    let (org, own) = (of(ORG)?, of(&repo)?);
    Ok(json!({ "held": !(org.is_null() && own.is_null()), "org": org, "repo": own }))
}

/// An operator's hold on a whole account is for orgs; on a repository, for any owner. Runs
/// `change`, and says whether an org holds it (its audit log has this event to copy).
fn operator<S: SqlStore>(
    db: &S,
    c: &Value,
    change: impl FnOnce(&str) -> Result<Value>,
) -> Result<Value> {
    let org = super::orgs::org(db);
    if c["repo"].is_null() {
        org.clone()?;
    }
    let mut answer = change(&string(c, "operator")?)?;
    answer["org_owned"] = json!(org.is_ok());
    Ok(answer)
}

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: HoldOp, now: i64) -> Result<Value> {
    match op {
        HoldOp::Check => check(db, c),
        HoldOp::OperatorSet => operator(db, c, |by| set(db, c, OPERATOR, by, now)),
        HoldOp::OperatorRelease => operator(db, c, |by| release(db, c, OPERATOR, by, now)),
    }
}
