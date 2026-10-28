//! Change requests: a working branch proposed for landing on `main`, with a conversation.
//! The change holds no commits of its own: its head is the branch's current commit, so a
//! push moves it and approvals (reviews of the head commit) follow the head as they do for
//! any commit. Landing that head on `main` marks the change landed in the landing's own
//! transaction (`landed`). A change describes the whole repository, so path-restricted
//! credentials can neither read nor write one.
use super::auth::Actor;
use super::rows::{self, branch_ref};
use super::{change_hooks, reads};
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

pub const MAX_TITLE: usize = 200;
pub const MAX_BODY: usize = 8000;
/// Branch moves `show` lists in a change's timeline.
const TIMELINE: u64 = 100;

const CHANGE: &str = "SELECT c.number,c.title,c.body,c.branch,c.base,c.author,c.status,c.created_at,\
     c.updated_at,c.landed_version,c.landed_commit,\
     (SELECT commit_id FROM refs WHERE name='refs/heads/'||c.branch) AS branch_head,\
     (SELECT COUNT(*) FROM change_comments k WHERE k.change_number=c.number) AS comment_count \
     FROM changes c";

pub fn whole_repository(actor: &Actor) -> Result<()> {
    if actor.grant.is_some() {
        return Err(Error::new(
            "FORBIDDEN",
            "Change requests describe whole branches; a path-restricted token cannot use them",
        ));
    }
    Ok(())
}

/// A change row as the API answers it: `head` is the landed commit once landed, else the
/// branch's current commit (null after the branch is deleted).
fn shaped(mut row: Value) -> Value {
    let head = if row["status"] == "landed" {
        row["landed_commit"].clone()
    } else {
        row["branch_head"].clone()
    };
    if let Some(fields) = row.as_object_mut() {
        fields.remove("branch_head");
        fields.insert("head".into(), head);
    }
    row
}

pub(super) fn get<S: SqlStore>(db: &S, number: i64) -> Result<Value> {
    db.query(&format!("{CHANGE} WHERE c.number=?"), &[json!(number)])?
        .into_iter()
        .next()
        .map(shaped)
        .ok_or_else(|| Error::new("NOT_FOUND", format!("No change #{number}")))
}

pub(super) fn number_of(c: &Value) -> Result<i64> {
    c["number"]
        .as_i64()
        .filter(|n| *n > 0)
        .ok_or_else(|| bad("number must be a change number"))
}

/// Trimmed text of at most `max` bytes, free of credentials; `None` when absent or blank.
pub(super) fn text(c: &Value, key: &str, max: usize) -> Result<Option<String>> {
    let Some(value) = c.get(key).filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let text = value
        .as_str()
        .map(str::trim)
        .filter(|s| s.len() <= max)
        .ok_or_else(|| bad(&format!("{key} must be text of at most {max} bytes")))?;
    if text.is_empty() {
        return Ok(None);
    }
    crate::secret_scan::scan(&format!("change {key}"), text.as_bytes(), &[])?;
    Ok(Some(text.to_owned()))
}

/// The open change on `branch` (a short name), if any.
fn open_on<S: SqlStore>(db: &S, branch: &str) -> Result<Option<i64>> {
    Ok(db
        .query(
            "SELECT number FROM changes WHERE branch=? AND status='open'",
            &[json!(branch)],
        )?
        .first()
        .and_then(|r| r["number"].as_i64()))
}

/// The short name of an existing working branch (never a protected one).
fn working_branch<S: SqlStore>(db: &S, name: &str) -> Result<String> {
    let refname = branch_ref(&json!({ "ref": name }))?;
    if rows::protected(&refname) {
        return Err(bad(
            "A change proposes a working branch, not main or a release branch",
        ));
    }
    if rows::projected_ref(db, &refname)?.is_none() {
        return Err(Error::new(
            "NOT_FOUND",
            format!("No branch {name}; push it first"),
        ));
    }
    Ok(refname["refs/heads/".len()..].to_owned())
}

fn already_open(branch: &str, number: i64) -> Error {
    Error::new(
        "ALREADY_EXISTS",
        format!("Branch {branch} already has open change #{number}"),
    )
}

/// `repo_change_create {branch, title, body?}`.
pub fn create<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let branch = working_branch(db, c["branch"].as_str().unwrap_or_default())?;
    let title = text(c, "title", MAX_TITLE)?.ok_or_else(|| bad("A change needs a title"))?;
    if title.chars().any(char::is_control) {
        return Err(bad("title must be one line"));
    }
    let body = text(c, "body", MAX_BODY)?.unwrap_or_default();
    if let Some(number) = open_on(db, &branch)? {
        return Err(already_open(&branch, number));
    }
    let now = number(c, "now")?;
    db.query(
        "INSERT INTO changes(title,body,branch,base,author,status,created_at,updated_at) VALUES(?,?,?,'main',?,'open',?,?)",
        &[json!(title), json!(body), json!(branch), json!(actor.principal), json!(now), json!(now)],
    )?;
    let number = db.query("SELECT last_insert_rowid() AS n", &[])?[0]["n"]
        .as_i64()
        .ok_or_else(|| rows::corrupt("change number"))?;
    let change = get(db, number)?;
    change_hooks::notify(
        db,
        "change.opened",
        "opened",
        &change,
        None,
        &actor.principal,
        now,
    )?;
    Ok(change)
}

/// `repo_changes {status?, limit?}`: newest first; `status` defaults to open.
pub fn list<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let status = c["status"].as_str().unwrap_or("open");
    if !["open", "landed", "closed", "all"].contains(&status) {
        return Err(bad("status must be open, landed, closed or all"));
    }
    let limit = c["limit"].as_u64().unwrap_or(50).clamp(1, 200);
    let rows = db.query(
        &format!("{CHANGE} WHERE ?1='all' OR c.status=?1 ORDER BY c.number DESC LIMIT ?2"),
        &[json!(status), json!(limit)],
    )?;
    Ok(json!({ "changes": rows.into_iter().map(shaped).collect::<Vec<_>>() }))
}

/// `repo_change_show {number}`: the change, its head's commit record (checks, reviews and
/// gates), comments and its branch's moves. The adapter adds the diff from object storage.
pub fn show<S: SqlStore>(
    db: &S,
    c: &Value,
    actor: &Actor,
    settings: &rows::Settings,
) -> Result<Value> {
    whole_repository(actor)?;
    let mut change = get(db, number_of(c)?)?;
    let head = match change["head"].as_str() {
        Some(id) => rows::commit_row(db, &ObjectId::parse(id)?)?.map(|_| id.to_owned()),
        None => None,
    };
    change["head_commit"] = match head {
        Some(id) => reads::commit(db, &json!({ "commit": id }), settings)?,
        None => Value::Null,
    };
    change["comments"] = json!(super::change_comments::of(db, &change["number"])?);
    let refname = format!(
        "refs/heads/{}",
        change["branch"].as_str().unwrap_or_default()
    );
    let moves = db.query(
        "SELECT entry FROM txlog WHERE refname=? ORDER BY version DESC LIMIT ?",
        &[json!(refname), json!(TIMELINE)],
    )?;
    let mut timeline = Vec::with_capacity(moves.len());
    for row in moves {
        let entry: yoneda_core::txlog::TxEntry =
            serde_json::from_str(row["entry"].as_str().unwrap_or_default())
                .map_err(|_| rows::corrupt("log entry"))?;
        let action = match (entry.old, entry.new) {
            (_, None) => "deleted",
            (None, _) => "created",
            _ => "moved",
        };
        timeline.push(
            json!({ "version": entry.version, "action": action, "before": entry.old,
            "after": entry.new, "actor": entry.actor, "at": entry.committed_at_ms }),
        );
    }
    change["timeline"] = json!(timeline);
    Ok(change)
}

/// `repo_change_close` and `repo_change_reopen {number}`: by the change's author, the owner
/// or a holder of the `land` scope.
pub fn set_open<S: SqlStore>(db: &S, c: &Value, actor: &Actor, open: bool) -> Result<Value> {
    whole_repository(actor)?;
    let change = get(db, number_of(c)?)?;
    if change["author"] != actor.principal.as_str() && !actor.owner && !actor.can("land") {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the change's author, the owner or a lander can close or reopen it",
        ));
    }
    let (from, to) = if open {
        ("closed", "open")
    } else {
        ("open", "closed")
    };
    if change["status"] == to {
        return Ok(change);
    }
    if change["status"] != from {
        return Err(Error::new(
            "CONFLICT",
            format!("Change #{} is {}", change["number"], change["status"]),
        ));
    }
    let branch = change["branch"].as_str().unwrap_or_default();
    if open {
        working_branch(db, branch)?;
        if let Some(number) = open_on(db, branch)? {
            return Err(already_open(branch, number));
        }
    }
    let now = number(c, "now")?;
    db.query(
        "UPDATE changes SET status=?,updated_at=? WHERE number=?",
        &[json!(to), json!(now), change["number"].clone()],
    )?;
    let change = get(db, change["number"].as_i64().unwrap_or_default())?;
    let (event, action) = if open {
        ("change.opened", "reopened")
    } else {
        ("change.closed", "closed")
    };
    change_hooks::notify(db, event, action, &change, None, &actor.principal, now)?;
    Ok(change)
}

/// Called wherever a landing is recorded: when `commit` lands on a change's base and is
/// still its branch's head, the open change is landed at `version`, in this transaction.
pub(super) fn landed<S: SqlStore>(
    db: &S,
    commit: &ObjectId,
    refname: &str,
    version: u64,
    at: i64,
) -> Result<()> {
    db.query(
        "UPDATE changes SET status='landed',landed_version=?1,landed_commit=?2,updated_at=?3 \
         WHERE status='open' AND 'refs/heads/'||base=?4 \
         AND (SELECT commit_id FROM refs WHERE name='refs/heads/'||changes.branch)=?2",
        &[
            json!(version),
            json!(commit.hex()),
            json!(at),
            json!(refname),
        ],
    )?;
    Ok(())
}

/// For a push's branch moves: each moved branch's open change number, or null (the
/// adapter then suggests opening one).
pub(super) fn for_moves<S: SqlStore>(db: &S, moved: &[Value]) -> Result<Vec<Value>> {
    let mut found = Vec::new();
    for item in moved {
        let Some(refname) = item["ref"].as_str() else {
            continue;
        };
        let Some(branch) = refname.strip_prefix("refs/heads/") else {
            continue;
        };
        if item["deleted"] == true {
            continue;
        }
        found.push(json!({ "ref": refname, "change": open_on(db, branch)? }));
    }
    Ok(found)
}
