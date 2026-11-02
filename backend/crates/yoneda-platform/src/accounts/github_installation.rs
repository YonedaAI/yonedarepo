//! The GitHub App installations an account connected: its own, and any organizations' it proved
//! it owns. The adapter proves each against GitHub before it writes here, and again on every use:
//! an installation id is no secret and no proof, and a connection can be removed on GitHub at any
//! time. An account links one GitHub identity, so connecting its own again replaces that one.
//!
//! A ticket carries an organization's installation across the OAuth round that proves an owner:
//! the platform can read the installation and the sign-in Worker can't. It holds no token.
use super::op::GitHubOp;
use super::*;

/// GitHub's longest login.
const LOGIN_MAX: usize = 39;
const TICKET_MS: i64 = 10 * 60 * 1000;
const COLUMNS: &str = "installation,login,connected_at,target_type,target_id,connected_by";

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: GitHubOp, now: i64) -> Result<Value> {
    account(db)?;
    match op {
        GitHubOp::Get => {
            let rows = held(db)?;
            let wanted = c["installation"].as_i64();
            let row = rows
                .into_iter()
                .find(|r| wanted.is_none() || r["installation"].as_i64() == wanted);
            Ok(row.unwrap_or(json!({})))
        }
        GitHubOp::List => Ok(json!({ "installations": held(db)? })),
        GitHubOp::Put => put(db, c, now),
        GitHubOp::TicketPut => {
            let (installation, login) = (installation(c)?, login(c)?);
            let target = target_id(c)?;
            db.query(
                "DELETE FROM account_github_org_tickets WHERE expires_at<=?",
                &[json!(now)],
            )?;
            db.query(
                "INSERT INTO account_github_org_tickets(ticket_hash,installation,login,target_id,expires_at) VALUES(?,?,?,?,?)",
                &[
                    json!(hash(c, "ticket_hash", &[64])?),
                    json!(installation),
                    json!(login),
                    json!(target),
                    json!(now + TICKET_MS),
                ],
            )?;
            Ok(json!({ "expires_at": now + TICKET_MS }))
        }
        GitHubOp::TicketGet => ticket(db, c, now),
        GitHubOp::TicketTake => {
            let found = ticket(db, c, now)?;
            db.query(
                "DELETE FROM account_github_org_tickets WHERE ticket_hash=?",
                &[json!(hash(c, "ticket_hash", &[64])?)],
            )?;
            Ok(found)
        }
    }
}

/// Its own first, then the organizations by name.
fn held<S: SqlStore>(db: &S) -> Result<Vec<Value>> {
    db.query(
        &format!(
            "SELECT {COLUMNS} FROM account_github_installation \
             ORDER BY target_type='Organization',login COLLATE NOCASE"
        ),
        &[],
    )
}

fn put<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let (installation, login) = (installation(c)?, login(c)?);
    let target = match c.get("target_type") {
        None | Some(Value::Null) => "User",
        Some(kind) if kind == "Organization" => "Organization",
        Some(_) => return Err(bad("target_type must be Organization")),
    };
    let (target_id, connected_by) = if target == "Organization" {
        (json!(target_id(c)?), json!(string(c, "connected_by")?))
    } else {
        db.query(
            "DELETE FROM account_github_installation WHERE target_type='User'",
            &[],
        )?;
        (Value::Null, Value::Null)
    };
    db.query(
        "INSERT INTO account_github_installation(installation,login,connected_at,target_type,target_id,connected_by) VALUES(?,?,?,?,?,?)
         ON CONFLICT(installation) DO UPDATE SET login=excluded.login,connected_at=excluded.connected_at,
         target_type=excluded.target_type,target_id=excluded.target_id,connected_by=excluded.connected_by",
        &[
            json!(installation),
            json!(login),
            json!(now),
            json!(target),
            target_id,
            connected_by,
        ],
    )?;
    Ok(json!({ "connected": true }))
}

fn ticket<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let rows = db.query(
        "SELECT installation,login,target_id FROM account_github_org_tickets \
         WHERE ticket_hash=? AND expires_at>?",
        &[json!(hash(c, "ticket_hash", &[64])?), json!(now)],
    )?;
    Ok(rows.into_iter().next().unwrap_or(json!({})))
}

fn installation(c: &Value) -> Result<i64> {
    c["installation"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or_else(|| bad("installation must be a GitHub installation id"))
}

fn target_id(c: &Value) -> Result<i64> {
    c["target_id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or_else(|| bad("target_id must be a GitHub account id"))
}

fn login(c: &Value) -> Result<String> {
    let login = string(c, "login")?;
    if login.is_empty() || login.len() > LOGIN_MAX {
        return Err(bad("login must be a GitHub login"));
    }
    Ok(login)
}
