//! A change request's conversation. A comment is free text (credentials refused) and may be
//! anchored to one line of the change's diff at a commit: `path`, `line` and `side` (`old`
//! is the base file, `new` the head file, numbered as the patch shows them). Resolving an
//! anchor marks all its unresolved comments resolved; a later push leaves earlier anchors on
//! the commit they were made against.
use super::auth::Actor;
use super::changes::{self, MAX_BODY, number_of, whole_repository};
use super::{change_hooks, rows};
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

/// Comments one change holds.
const MAX_COMMENTS: i64 = 2000;
const MAX_LINE: i64 = 10_000_000;

const COMMENT: &str = "SELECT id,commit_id AS \"commit\",path,line,side,body,principal,at,resolved_at FROM change_comments";

/// A change's comments, oldest first.
pub(super) fn of<S: SqlStore>(db: &S, number: &Value) -> Result<Vec<Value>> {
    db.query(
        &format!("{COMMENT} WHERE change_number=? ORDER BY id"),
        std::slice::from_ref(number),
    )
}

/// The optional `{path, line, side}` anchor: all three or none.
fn anchor(c: &Value) -> Result<Option<(String, i64, &'static str)>> {
    let given = ["path", "line", "side"].map(|k| !c[k].is_null());
    if given == [false; 3] {
        return Ok(None);
    }
    if given != [true; 3] {
        return Err(bad(
            "An anchored comment needs path, line and side together",
        ));
    }
    let path = c["path"].as_str().unwrap_or_default();
    yoneda_core::validate_path(path)?;
    let line = c["line"]
        .as_i64()
        .filter(|l| (1..=MAX_LINE).contains(l))
        .ok_or_else(|| bad("line must be a positive line number"))?;
    let side = match c["side"].as_str() {
        Some("old") => "old",
        Some("new") => "new",
        _ => return Err(bad("side must be old or new")),
    };
    Ok(Some((path.to_owned(), line, side)))
}

/// `repo_change_comment {number, body?, commit?, path?, line?, side?, resolve?}`.
pub fn comment<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let change = changes::get(db, number_of(c)?)?;
    let body = changes::text(c, "body", MAX_BODY)?;
    let anchor = anchor(c)?;
    let resolve = c["resolve"] == true;
    if body.is_none() && !resolve {
        return Err(bad("A comment needs a body (or resolve with an anchor)"));
    }
    if resolve && anchor.is_none() {
        return Err(bad("resolve needs the anchor's path, line and side"));
    }
    let commit = match c.get("commit").filter(|v| !v.is_null()) {
        Some(_) => rows::object_id(c, "commit")?,
        None => ObjectId::parse(change["head"].as_str().ok_or_else(|| {
            bad("This change has no head commit; name the commit to comment on")
        })?)?,
    };
    rows::recorded(db, &commit)?;
    let now = number(c, "now")?;
    let (path, line, side) = match &anchor {
        Some((path, line, side)) => (json!(path), json!(line), json!(side)),
        None => (Value::Null, Value::Null, Value::Null),
    };
    let mut posted = Value::Null;
    if let Some(body) = &body {
        let held = db.query(
            "SELECT COUNT(*) AS n FROM change_comments WHERE change_number=?",
            &[change["number"].clone()],
        )?[0]["n"]
            .as_i64()
            .unwrap_or(0);
        if held >= MAX_COMMENTS {
            return Err(Error::new(
                "TOO_LARGE",
                format!("A change holds at most {MAX_COMMENTS} comments"),
            ));
        }
        db.query(
            "INSERT INTO change_comments(change_number,commit_id,path,line,side,body,principal,at) VALUES(?,?,?,?,?,?,?,?)",
            &[change["number"].clone(), json!(commit.hex()), path.clone(), line.clone(), side.clone(),
              json!(body), json!(actor.principal), json!(now)],
        )?;
        posted = db
            .query(&format!("{COMMENT} WHERE id=last_insert_rowid()"), &[])?
            .into_iter()
            .next()
            .unwrap_or(Value::Null);
    }
    let mut resolved = 0;
    if resolve {
        let open = "change_number=? AND commit_id=? AND path=? AND line=? AND side=? AND resolved_at IS NULL";
        let key = [
            change["number"].clone(),
            json!(commit.hex()),
            path,
            line,
            side,
        ];
        resolved = db.query(
            &format!("SELECT COUNT(*) AS n FROM change_comments WHERE {open}"),
            &key,
        )?[0]["n"]
            .as_i64()
            .unwrap_or(0);
        let mut params = vec![json!(now)];
        params.extend(key);
        db.query(
            &format!("UPDATE change_comments SET resolved_at=? WHERE {open}"),
            &params,
        )?;
        // The posted comment, when there is one, was resolved with its anchor.
        if !posted.is_null() {
            posted["resolved_at"] = json!(now);
        }
    }
    db.query(
        "UPDATE changes SET updated_at=? WHERE number=?",
        &[json!(now), change["number"].clone()],
    )?;
    if !posted.is_null() {
        change_hooks::notify(
            db,
            "change.commented",
            "commented",
            &change,
            Some(&posted),
            &actor.principal,
            now,
        )?;
    }
    Ok(json!({ "comment": posted, "resolved": resolved }))
}
