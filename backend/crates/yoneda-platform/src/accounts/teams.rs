//! Teams of an organization: named groups of its members that repositories grant a role
//! to (`team:<org>/<team>`). Only the org's owners manage them (checked by `orgs`).
use super::orgs::{count, personal, role_of};
use super::*;

const TEAM_LIMIT: i64 = 100;
const TEAM_SIZE_LIMIT: i64 = 1000;

pub(super) fn handle<S: SqlStore>(
    db: &S,
    c: &Value,
    op: &str,
    actor: &str,
    now: i64,
) -> Result<Value> {
    match op {
        "team_create" => create(db, c, actor, now),
        "team_delete" => delete(db, c, now),
        "team_member_put" => member_put(db, c, actor, now),
        _ => member_remove(db, c, now),
    }
}

fn team_name(c: &Value) -> Result<String> {
    let name = string(c, "team")?;
    if !crate::repo_store::members::valid_team_name(&name) {
        return Err(bad(
            "Team names are 1-32 characters of a-z, 0-9, _ and -, starting with a letter or digit",
        ));
    }
    Ok(name)
}

fn delete<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let team = existing_team(db, c)?;
    db.query("DELETE FROM org_teams WHERE name=?", &[json!(team)])?;
    db.query("DELETE FROM org_team_members WHERE team=?", &[json!(team)])?;
    audit(db, "org.team_deleted", now, json!({ "team": team }))?;
    Ok(json!({ "team": team, "deleted": true }))
}

fn member_remove<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let team = existing_team(db, c)?;
    let account = personal(c)?;
    let found = db.query(
        "SELECT account FROM org_team_members WHERE team=? AND account=?",
        &[json!(team), json!(account)],
    )?;
    if found.is_empty() {
        return Err(Error::new(
            "NOT_FOUND",
            format!("{account} is not in the {team} team"),
        ));
    }
    db.query(
        "DELETE FROM org_team_members WHERE team=? AND account=?",
        &[json!(team), json!(account)],
    )?;
    audit(
        db,
        "org.team_member_removed",
        now,
        json!({ "team": team, "account": account }),
    )?;
    Ok(json!({ "team": team, "account": account, "removed": true }))
}

pub(super) fn exists<S: SqlStore>(db: &S, c: &Value) -> Result<bool> {
    let team = team_name(c)?;
    Ok(!db
        .query("SELECT name FROM org_teams WHERE name=?", &[json!(team)])?
        .is_empty())
}

fn existing_team<S: SqlStore>(db: &S, c: &Value) -> Result<String> {
    if !exists(db, c)? {
        return Err(Error::new(
            "NOT_FOUND",
            format!("No team named {}", string(c, "team")?),
        ));
    }
    team_name(c)
}

fn create<S: SqlStore>(db: &S, c: &Value, actor: &str, now: i64) -> Result<Value> {
    let team = team_name(c)?;
    if !db
        .query("SELECT name FROM org_teams WHERE name=?", &[json!(team)])?
        .is_empty()
    {
        return Err(Error::new(
            "ALREADY_EXISTS",
            format!("A team named {team} exists"),
        ));
    }
    if count(db, "SELECT COUNT(*) AS n FROM org_teams", &[])? >= TEAM_LIMIT {
        return Err(bad("Team limit reached"));
    }
    db.query(
        "INSERT INTO org_teams(name,created_by,created_at) VALUES(?,?,?)",
        &[json!(team), json!(actor), json!(now)],
    )?;
    audit(db, "org.team_created", now, json!({ "team": team }))?;
    Ok(json!({ "team": team, "created_at": now }))
}

/// `team_member_put {team, account}`: only members of the org join its teams.
fn member_put<S: SqlStore>(db: &S, c: &Value, actor: &str, now: i64) -> Result<Value> {
    let team = existing_team(db, c)?;
    let account = personal(c)?;
    if role_of(db, &account)?.is_none() {
        return Err(bad(&format!(
            "{account} is not a member of this organization; add them first"
        )));
    }
    if count(
        db,
        "SELECT COUNT(*) AS n FROM org_team_members WHERE team=?",
        &[json!(team)],
    )? >= TEAM_SIZE_LIMIT
    {
        return Err(bad("Team size limit reached"));
    }
    db.query(
        "INSERT INTO org_team_members(team,account,added_by,added_at) VALUES(?,?,?,?) \
         ON CONFLICT(team,account) DO NOTHING",
        &[json!(team), json!(account), json!(actor), json!(now)],
    )?;
    audit(
        db,
        "org.team_member_added",
        now,
        json!({ "team": team, "account": account }),
    )?;
    Ok(json!({ "team": team, "account": account, "added": true }))
}
