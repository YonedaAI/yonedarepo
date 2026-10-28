//! Organizations: an account of kind `org` whose authority holds its owners, members and
//! teams. Nobody signs in as an org. Owners manage members and teams (and create the org's
//! repositories, checked by the adapter through `org_access`); members see the org and get
//! repository access only through teams or direct repository membership. A member may leave
//! on their own; an org always keeps one owner. `actor` is the calling account, set by the
//! authenticating adapter. A personal account's authority keeps hints of the orgs it joined
//! (`org_hint_*`) so the adapter knows whom to ask; hints never grant access. Deleting an
//! org (its owners, once it owns no repositories: the adapter checks the listing) leaves a
//! tombstone: the name is retired, so nothing a deleted org held can pass to a new account.
use super::*;

const MEMBER_LIMIT: i64 = 1000;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    match string(c, "op")?.as_str() {
        "org_create" => create(db, c, now),
        "org_access" => access(db, c),
        // Whether a team exists (a repository grants roles only to existing teams).
        "team_exists" => {
            org(db)?;
            let id = super::teams::id_of(db, c)?;
            Ok(json!({ "exists": id.is_some(), "id": id }))
        }
        "org_hint_add" => {
            account(db)?;
            db.query(
                "INSERT INTO account_orgs(org,added_at) VALUES(?,?) ON CONFLICT(org) DO NOTHING",
                &[json!(org_name(&string(c, "org")?)?), json!(now)],
            )?;
            Ok(json!({ "orgs": hints(db)? }))
        }
        "org_hint_remove" => {
            account(db)?;
            db.query(
                "DELETE FROM account_orgs WHERE org=?",
                &[json!(string(c, "org")?)],
            )?;
            Ok(json!({ "orgs": hints(db)? }))
        }
        op => {
            let org = org(db)?;
            let actor = string(c, "actor")?;
            let role = role_of(db, &actor)?.ok_or_else(|| {
                Error::new(
                    "FORBIDDEN",
                    format!("You are not a member of the {org} organization"),
                )
            })?;
            let leaving = op == "org_member_remove" && c["account"] == actor.as_str();
            if op != "org_show" && role != "owner" && !leaving {
                return Err(Error::new(
                    "FORBIDDEN",
                    format!("Only an owner of {org} can do this"),
                ));
            }
            let actor = format!("user:{actor}");
            match op {
                "org_show" => show(db, &org, &role),
                "org_delete" => delete(db, c, &org, now),
                "org_member_put" => member_put(db, c, &org, &actor, now),
                "org_member_remove" => member_remove(db, c, &org, now),
                "team_create" | "team_delete" | "team_member_put" | "team_member_remove" => {
                    super::teams::handle(db, c, op, &actor, now)
                }
                _ => Err(Error::new("NOT_FOUND", "Unknown organization operation")),
            }
        }
    }
}

/// The orgs a personal account joined (hints, see the module comment).
pub(super) fn hints<S: SqlStore>(db: &S) -> Result<Vec<Value>> {
    Ok(db
        .query("SELECT org FROM account_orgs ORDER BY org", &[])?
        .into_iter()
        .map(|r| r["org"].clone())
        .collect())
}

/// An org name: an account username (no email form), so orgs and people share one namespace.
pub(super) fn org_name(name: &str) -> Result<String> {
    let name = yoneda_core::account::normalize_account_identifier(name)?;
    if name.contains('@') {
        return Err(bad(
            "Organization names are 3-32 characters of a-z, 0-9 and _, starting with a letter",
        ));
    }
    Ok(name)
}

/// The org this authority holds, or NOT_FOUND (a person's account, or nothing).
fn org<S: SqlStore>(db: &S) -> Result<String> {
    match get(db, "account") {
        Ok(record) if record["kind"] == "org" && record["deleted_at"].is_null() => {
            string(&record, "username")
        }
        _ => Err(Error::new("NOT_FOUND", "No such organization")),
    }
}

pub(super) fn personal(c: &Value) -> Result<String> {
    yoneda_core::account::normalize_account_identifier(&string(c, "account")?)
}

pub(super) fn role_of<S: SqlStore>(db: &S, account: &str) -> Result<Option<String>> {
    Ok(db
        .query(
            "SELECT role FROM org_members WHERE account=?",
            &[json!(account)],
        )?
        .first()
        .and_then(|r| r["role"].as_str().map(str::to_owned)))
}

pub(super) fn count<S: SqlStore>(db: &S, sql: &str, args: &[Value]) -> Result<i64> {
    Ok(db.query(sql, args)?[0]["n"].as_i64().unwrap_or_default())
}

/// `org_create {org, actor}`: the name must be free (no person or org holds it); the creator
/// becomes its first owner.
fn create<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let name = org_name(&string(c, "org")?)?;
    let actor = yoneda_core::account::normalize_account_identifier(&string(c, "actor")?)?;
    if get(db, "account").is_ok() {
        return Err(Error::new("ALREADY_EXISTS", "That name is taken"));
    }
    put(
        db,
        "account",
        &json!({"username": name, "kind": "org", "created_at": now, "created_by": actor}),
    )?;
    db.query(
        "INSERT INTO org_members(account,role,added_by,added_at) VALUES(?,'owner',?,?)",
        &[json!(actor), json!(format!("user:{actor}")), json!(now)],
    )?;
    audit(db, "org.created", now, json!({ "org": name, "by": actor }))?;
    Ok(json!({ "org": name, "role": "owner", "created_at": now }))
}

/// `org_access {account}`: the account's role and teams here, for the adapter's
/// credentials (role null: not a member).
fn access<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let org = org(db)?;
    let account = string(c, "account")?;
    let role = role_of(db, &account)?;
    let teams: Vec<Value> = if role.is_some() {
        db.query(
            "SELECT t.name,t.id FROM org_team_members m JOIN org_teams t ON t.name=m.team \
             WHERE m.account=? ORDER BY t.name",
            &[json!(account)],
        )?
        .into_iter()
        .map(|r| json!({ "name": r["name"], "id": r["id"] }))
        .collect()
    } else {
        Vec::new()
    };
    Ok(json!({ "org": org, "role": role, "teams": teams }))
}

fn show<S: SqlStore>(db: &S, org: &str, role: &str) -> Result<Value> {
    let record = get(db, "account")?;
    let members = db.query(
        "SELECT account,role,added_by,added_at FROM org_members ORDER BY account",
        &[],
    )?;
    let mut teams = Vec::new();
    for team in db.query(
        "SELECT name,id,created_by,created_at FROM org_teams ORDER BY name",
        &[],
    )? {
        let accounts: Vec<Value> = db
            .query(
                "SELECT account FROM org_team_members WHERE team=? ORDER BY account",
                &[team["name"].clone()],
            )?
            .into_iter()
            .map(|r| r["account"].clone())
            .collect();
        teams.push(json!({
            "name": team["name"], "id": team["id"], "created_by": team["created_by"],
            "created_at": team["created_at"], "members": accounts,
        }));
    }
    Ok(json!({
        "org": org, "created_at": record["created_at"], "created_by": record["created_by"],
        "role": role, "members": members, "teams": teams,
    }))
}

fn owners<S: SqlStore>(db: &S) -> Result<i64> {
    count(
        db,
        "SELECT COUNT(*) AS n FROM org_members WHERE role='owner'",
        &[],
    )
}

/// `org_member_put {account, role}`: adds a member or changes its role (the adapter has
/// checked that the account is a person). The last owner stays an owner.
fn member_put<S: SqlStore>(db: &S, c: &Value, org: &str, actor: &str, now: i64) -> Result<Value> {
    let account = personal(c)?;
    if account == org {
        return Err(bad("An organization cannot be its own member"));
    }
    let role = string(c, "role")?;
    if !matches!(role.as_str(), "owner" | "member") {
        return Err(bad("Organization roles are owner or member"));
    }
    let previous = role_of(db, &account)?;
    if previous.is_none()
        && count(db, "SELECT COUNT(*) AS n FROM org_members", &[])? >= MEMBER_LIMIT
    {
        return Err(bad("Member limit reached"));
    }
    if previous.as_deref() == Some("owner") && role == "member" && owners(db)? == 1 {
        return Err(Error::new(
            "FORBIDDEN",
            "An organization keeps at least one owner",
        ));
    }
    db.query(
        "INSERT INTO org_members(account,role,added_by,added_at) VALUES(?,?,?,?) \
         ON CONFLICT(account) DO UPDATE SET role=excluded.role",
        &[json!(account), json!(role), json!(actor), json!(now)],
    )?;
    audit(
        db,
        "org.member_put",
        now,
        json!({ "account": account, "role": role }),
    )?;
    Ok(json!({ "account": account, "role": role, "previous": previous }))
}

/// `org_member_remove {account}`: by an owner, or the member leaving. Their teams go with it.
fn member_remove<S: SqlStore>(db: &S, c: &Value, org: &str, now: i64) -> Result<Value> {
    let account = personal(c)?;
    let Some(role) = role_of(db, &account)? else {
        return Err(Error::new(
            "NOT_FOUND",
            format!("{account} is not a member of {org}"),
        ));
    };
    if role == "owner" && owners(db)? == 1 {
        return Err(Error::new(
            "FORBIDDEN",
            "An organization keeps at least one owner",
        ));
    }
    db.query("DELETE FROM org_members WHERE account=?", &[json!(account)])?;
    db.query(
        "DELETE FROM org_team_members WHERE account=?",
        &[json!(account)],
    )?;
    audit(db, "org.member_removed", now, json!({ "account": account }))?;
    Ok(json!({ "account": account, "removed": true }))
}

/// `org_delete {confirm}`: an owner retires the org. Its members and teams go; the record
/// stays as a tombstone that holds the name (no person or org can take it again). Answers
/// the former members, whose hints the adapter then drops.
fn delete<S: SqlStore>(db: &S, c: &Value, org: &str, now: i64) -> Result<Value> {
    if string(c, "confirm")? != org {
        return Err(bad("confirm must be the organization's name"));
    }
    let members: Vec<Value> = db
        .query("SELECT account FROM org_members ORDER BY account", &[])?
        .into_iter()
        .map(|r| r["account"].clone())
        .collect();
    for table in ["org_members", "org_teams", "org_team_members"] {
        db.query(&format!("DELETE FROM {table}"), &[])?;
    }
    let mut record = get(db, "account")?;
    record["deleted_at"] = json!(now);
    put(db, "account", &record)?;
    audit(db, "org.deleted", now, json!({ "org": org }))?;
    Ok(json!({ "org": org, "deleted": true, "members": members }))
}
