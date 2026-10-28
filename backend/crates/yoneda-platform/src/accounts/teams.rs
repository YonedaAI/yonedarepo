//! Teams of an organization: named groups of its members that repositories grant a role
//! to (`team:<org>/<team>#<id>`). Each team gets an id from the org's counter that is never
//! reused, so a repository grant made to a deleted team never reaches a later team of the
//! same name. Only the org's owners manage them (checked by `orgs`).
use super::orgs::{count, personal, role_of};
use super::*;

const TEAM_LIMIT: i64 = 100;
const TEAM_SIZE_LIMIT: i64 = 1000;

fn team_name(c: &Value) -> Result<String> {
    let name = string(c, "team")?;
    if !crate::repo_store::members::valid_team_name(&name) {
        return Err(bad(
            "Team names are 1-32 characters of a-z, 0-9, _ and -, starting with a letter or digit",
        ));
    }
    Ok(name)
}

pub(super) fn delete<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let team = existing_team(db, c)?;
    db.query("DELETE FROM org_teams WHERE name=?", &[json!(team)])?;
    db.query("DELETE FROM org_team_members WHERE team=?", &[json!(team)])?;
    audit(db, "org.team_deleted", now, json!({ "team": team }))?;
    Ok(json!({ "team": team, "deleted": true }))
}

pub(super) fn member_remove<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
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

/// The id of the team named by `c`, if it exists.
pub(super) fn id_of<S: SqlStore>(db: &S, c: &Value) -> Result<Option<i64>> {
    let team = team_name(c)?;
    Ok(db
        .query("SELECT id FROM org_teams WHERE name=?", &[json!(team)])?
        .first()
        .and_then(|r| r["id"].as_i64()))
}

fn existing_team<S: SqlStore>(db: &S, c: &Value) -> Result<String> {
    if id_of(db, c)?.is_none() {
        return Err(Error::new(
            "NOT_FOUND",
            format!("No team named {}", string(c, "team")?),
        ));
    }
    team_name(c)
}

pub(super) fn create<S: SqlStore>(db: &S, c: &Value, actor: &str, now: i64) -> Result<Value> {
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
    let id = get(db, "team_seq").map_or(0, |seq| seq["last"].as_i64().unwrap_or(0)) + 1;
    put(db, "team_seq", &json!({ "last": id }))?;
    db.query(
        "INSERT INTO org_teams(name,id,created_by,created_at) VALUES(?,?,?,?)",
        &[json!(team), json!(id), json!(actor), json!(now)],
    )?;
    audit(
        db,
        "org.team_created",
        now,
        json!({ "team": team, "id": id }),
    )?;
    Ok(json!({ "team": team, "id": id, "created_at": now }))
}

/// `team_member_put {team, account}`: only members of the org join its teams.
pub(super) fn member_put<S: SqlStore>(db: &S, c: &Value, actor: &str, now: i64) -> Result<Value> {
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
