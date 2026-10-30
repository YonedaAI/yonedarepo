//! Repository names, held by the owner's authority (a person's or an org's): unique per
//! owner ignoring case, so `/<handle>/<name>` names one repository. A rename keeps the
//! earlier name (current=0): it resolves to the repository until another one takes it.
use super::*;

/// The name rules of a repository (repo_store `repo_init`).
fn repo_name(c: &Value) -> Result<String> {
    let name = string(c, "name")?;
    let valid = !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if !valid {
        return Err(bad(
            "Repository names are 1-100 characters of [A-Za-z0-9._-]",
        ));
    }
    Ok(name)
}

pub(super) fn repo_id(c: &Value) -> Result<String> {
    let repo = string(c, "repo")?;
    let valid = repo.len() == 21
        && repo.starts_with('r')
        && repo[1..]
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !valid {
        return Err(bad("repo must be a repository id"));
    }
    Ok(repo)
}

/// The owner held here (a person or a live org).
fn owner<S: SqlStore>(db: &S) -> Result<()> {
    match get(db, "account") {
        Ok(a) if a["deleted_at"].is_null() => Ok(()),
        _ => Err(Error::new("NOT_FOUND", "No such owner")),
    }
}

/// `owned_repo_claim {repo, name}`: `name` becomes the repository's name here (NAME_TAKEN
/// while another repository has it); its name until now stays as an earlier name.
/// Answers the name it had (`renamed_from`, null for a first claim or the same name).
pub(super) fn claim<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    owner(db)?;
    let (repo, name) = (repo_id(c)?, repo_name(c)?);
    let key = name.to_ascii_lowercase();
    let held = db.query(
        "SELECT repo FROM repo_names WHERE name_key=? AND current=1",
        &[json!(key)],
    )?;
    if held.first().is_some_and(|r| r["repo"] != repo.as_str()) {
        return Err(Error::new(
            "NAME_TAKEN",
            format!("This owner already has a repository named {name}"),
        ));
    }
    let before = db.query(
        "SELECT name FROM repo_names WHERE repo=? AND current=1",
        &[json!(repo)],
    )?;
    db.query(
        "UPDATE repo_names SET current=0 WHERE repo=? AND current=1",
        &[json!(repo)],
    )?;
    db.query(
        "INSERT INTO repo_names(name_key,name,repo,current,at) VALUES(?,?,?,1,?) \
         ON CONFLICT(name_key) DO UPDATE SET name=excluded.name,repo=excluded.repo,current=1,at=excluded.at",
        &[json!(key), json!(name), json!(repo), json!(now)],
    )?;
    let renamed_from = before
        .first()
        .map(|r| r["name"].clone())
        .filter(|n| n != &json!(name));
    Ok(json!({ "name": name, "renamed_from": renamed_from }))
}

/// `owned_repo_release {repo}`: the repository is gone (or was never made): its names are
/// free.
pub(super) fn release<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let repo = repo_id(c)?;
    db.query("DELETE FROM repo_names WHERE repo=?", &[json!(repo)])?;
    Ok(json!({ "released": true }))
}

/// `owned_repo_resolve {name}`: the repository a name (any case, current or earlier) names,
/// with its current name; `renamed_from` is the earlier name asked for. NOT_FOUND when none.
pub(super) fn resolve<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    owner(db)?;
    let key = string(c, "name")?.to_ascii_lowercase();
    let row = db
        .query(
            "SELECT name,repo,current FROM repo_names WHERE name_key=?",
            &[json!(key)],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("NOT_FOUND", "No such repository"))?;
    let current = if row["current"] == 1 {
        row["name"].clone()
    } else {
        db.query(
            "SELECT name FROM repo_names WHERE repo=? AND current=1",
            &[row["repo"].clone()],
        )?
        .first()
        .map(|r| r["name"].clone())
        .ok_or_else(|| Error::new("NOT_FOUND", "No such repository"))?
    };
    let renamed_from = (row["current"] != 1).then(|| row["name"].clone());
    Ok(json!({ "repo": row["repo"], "name": current, "renamed_from": renamed_from }))
}
