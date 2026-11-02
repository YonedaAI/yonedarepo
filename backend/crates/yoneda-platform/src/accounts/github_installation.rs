//! The GitHub App installation an account connected. The adapter proves it against GitHub before
//! it writes here, and again on every use: an installation id is no secret and no proof, and a
//! connection can be removed on GitHub at any time. An account links one GitHub identity, so it
//! holds one installation, and connecting again replaces it.
use super::op::GitHubOp;
use super::*;

/// GitHub's longest login.
const LOGIN_MAX: usize = 39;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: GitHubOp, now: i64) -> Result<Value> {
    account(db)?;
    match op {
        GitHubOp::Get => {
            let rows = db.query(
                "SELECT installation,login,connected_at FROM account_github_installation",
                &[],
            )?;
            Ok(rows.into_iter().next().unwrap_or(json!({})))
        }
        GitHubOp::Put => {
            let installation = c["installation"]
                .as_i64()
                .filter(|id| *id > 0)
                .ok_or_else(|| bad("installation must be a GitHub installation id"))?;
            let login = string(c, "login")?;
            if login.is_empty() || login.len() > LOGIN_MAX {
                return Err(bad("login must be a GitHub login"));
            }
            db.query("DELETE FROM account_github_installation", &[])?;
            db.query(
                "INSERT INTO account_github_installation(installation,login,connected_at) VALUES(?,?,?)",
                &[json!(installation), json!(login), json!(now)],
            )?;
            Ok(json!({ "connected": true }))
        }
    }
}
