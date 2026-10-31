//! Change requests: a working branch proposed for landing on a base branch (`main` unless
//! another existing branch is named), with a conversation. The change holds no commits of
//! its own: its head is the branch's current commit, so a push moves it and approvals
//! (reviews of the head commit) follow the head as they do for any commit. Landing that head
//! on the base (by `repo_land`, whose gates apply when the base is protected, or by a branch
//! move to it) marks the change landed in that transaction (`landed`). A change describes the whole repository, so path-restricted
//! credentials can neither read nor write one.
use super::auth::Actor;
use super::rows::{self, branch_ref};
use super::{change_adopt, change_hooks, flight_plans, go_around, reads};
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

pub const MAX_TITLE: usize = 200;
pub const MAX_BODY: usize = 8000;
const ORIGINS: [&str; 2] = ["explicit", "auto"];
/// Branch moves `show` lists in a change's timeline.
const TIMELINE: u64 = 100;

/// `c.*`, so `origin` is answered wherever the schema has it (`change_adopt`).
const CHANGE: &str = "SELECT c.*,\
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

/// A change's title: `text` on one line.
pub(super) fn title_of(c: &Value) -> Result<Option<String>> {
    let title = text(c, "title", MAX_TITLE)?;
    if title
        .as_ref()
        .is_some_and(|t| t.chars().any(char::is_control))
    {
        return Err(bad("title must be one line"));
    }
    Ok(title)
}

/// The open change on `branch` (a short name), if any.
pub(super) fn open_on<S: SqlStore>(db: &S, branch: &str) -> Result<Option<i64>> {
    Ok(db
        .query(
            "SELECT number FROM changes WHERE branch=? AND status='open'",
            &[json!(branch)],
        )?
        .first()
        .and_then(|r| r["number"].as_i64()))
}

/// The short name of an existing working branch (never a protected one).
pub(super) fn working_branch<S: SqlStore>(db: &S, name: &str) -> Result<String> {
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

/// The short name of the existing branch `name` a change on `branch` lands on (default
/// `main`); never the change's own branch.
pub(super) fn base_branch<S: SqlStore>(db: &S, name: Option<&str>, branch: &str) -> Result<String> {
    let refname = branch_ref(&json!({ "ref": name.unwrap_or("main") }))?;
    let base = refname["refs/heads/".len()..].to_owned();
    if base == branch {
        return Err(bad("A change cannot land a branch on itself"));
    }
    if rows::projected_ref(db, &refname)?.is_none() {
        return Err(Error::new("NOT_FOUND", format!("No base branch {base}")));
    }
    Ok(base)
}

pub(super) fn already_open(branch: &str, number: i64) -> Error {
    Error::new(
        "ALREADY_EXISTS",
        format!("Branch {branch} already has open change #{number}"),
    )
}

/// `repo_change_create {branch, base?, title, body?, source_repo?, source_branch?}`: `base`
/// (default main) must be another existing branch. A change from a fork names the fork and
/// its branch, and proposes the mirror `forks/<fork>/<branch>`.
pub fn create<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let branch = working_branch(db, c["branch"].as_str().unwrap_or_default())?;
    let base = base_branch(db, c["base"].as_str(), &branch)?;
    let source = (c["source_repo"].as_str(), c["source_branch"].as_str());
    if let (Some(repo), from) = source
        && from.is_none_or(|from| branch != format!("forks/{repo}/{from}"))
    {
        return Err(bad(
            "A change from a fork proposes the fork branch's mirror",
        ));
    }
    let title = title_of(c)?.ok_or_else(|| bad("A change needs a title"))?;
    let body = text(c, "body", MAX_BODY)?.unwrap_or_default();
    let now = number(c, "now")?;
    if let Some(open) = open_on(db, &branch)? {
        if !change_adopt::unclaimed(db, open)? {
            return Err(already_open(&branch, open));
        }
        let proposal = change_adopt::Proposal {
            title: &title,
            body: &body,
            base: &base,
        };
        return change_adopt::adopt(db, open, &proposal, actor, now);
    }
    db.query(
        "INSERT INTO changes(title,body,branch,base,author,status,created_at,updated_at,source_repo,source_branch) VALUES(?,?,?,?,?,'open',?,?,?,?)",
        &[json!(title), json!(body), json!(branch), json!(base), json!(actor.principal), json!(now), json!(now), json!(source.0), json!(source.1)],
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

/// `repo_changes {status?, limit?, branch?, origin?, direct?}`: newest first; `status` defaults
/// to open. `direct` adds the landings no change names, to a list that holds landed rows.
pub fn list<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let status = c["status"].as_str().unwrap_or("open");
    if !["open", "landed", "closed", "all"].contains(&status) {
        return Err(bad("status must be open, landed, closed or all"));
    }
    if c["origin"].as_str().is_some_and(|o| !ORIGINS.contains(&o)) {
        return Err(bad("origin must be explicit or auto"));
    }
    let limit = c["limit"].as_u64().unwrap_or(50).clamp(1, 200);
    let mut params = vec![json!(status), json!(limit)];
    let mut only = String::new();
    for (key, column) in [("branch", "c.branch"), ("origin", "c.origin")] {
        if let Some(value) = c[key].as_str() {
            params.push(json!(value));
            only.push_str(&format!(" AND {column}=?{}", params.len()));
        }
    }
    let rows = db.query(
        &format!("{CHANGE} WHERE (?1='all' OR c.status=?1){only} ORDER BY c.number DESC LIMIT ?2"),
        &params,
    )?;
    let mut answer = json!({ "changes": rows.into_iter().map(shaped).collect::<Vec<_>>() });
    if c["direct"] == true && ["landed", "all"].contains(&status) {
        answer["direct"] = json!(super::direct_landings::recent(db, limit)?);
    }
    Ok(answer)
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
        Some(id) => reads::commit(
            db,
            &json!({ "commit": id, "ref": change["base"] }),
            settings,
        )?,
        None => Value::Null,
    };
    change["comments"] = json!(super::change_comments::of(db, &change["number"])?);
    change["flight_plan"] = flight_plans::newest(db, &change["number"], &change["branch"])?;
    change["go_around"] = if change["status"] == "open" {
        go_around::of_change(db, &change["number"], &change["head"])?
    } else {
        Value::Null
    };
    // Landing on a protected base needs the head's gates; any other base moves with `write`.
    change["base_protected"] = json!(rows::protected(&format!(
        "refs/heads/{}",
        change["base"].as_str().unwrap_or_default()
    )));
    change["timeline"] = json!(super::change_comments::timeline(
        db,
        change["branch"].as_str().unwrap_or_default(),
        TIMELINE
    )?);
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

/// The open change on branch `refname` (`refs/heads/…`): its number, or null.
pub(super) fn open_on_ref<S: SqlStore>(db: &S, refname: &str) -> Result<Value> {
    let branch = refname.strip_prefix("refs/heads/").unwrap_or(refname);
    Ok(json!(open_on(db, branch)?))
}
