//! The repositories an account keeps at the top of its repository picker, by id only: the
//! adapter answers with each one's name and drops any the account can no longer read, so a
//! favorite never outlives access to its repository.
use super::op::FavoriteOp;
use super::repo_names::repo_id;
use super::*;

/// The most favorites an account keeps.
const LIMIT: i64 = 50;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: FavoriteOp, now: i64) -> Result<Value> {
    account(db)?;
    match op {
        FavoriteOp::List => {
            let favorites = db.query(
                "SELECT repo,added_at FROM account_favorites ORDER BY added_at DESC,repo",
                &[],
            )?;
            Ok(json!({ "favorites": favorites }))
        }
        FavoriteOp::Put => put(db, c, now),
        // Several at once: the adapter clears the favorites an account can no longer read.
        FavoriteOp::Remove => {
            let repos = c["repos"]
                .as_array()
                .ok_or_else(|| bad("repos must be a list of repository ids"))?;
            for repo in repos {
                let repo = repo_id(&json!({ "repo": repo }))?;
                db.query("DELETE FROM account_favorites WHERE repo=?", &[json!(repo)])?;
            }
            Ok(json!({ "removed": true }))
        }
    }
}

/// `favorite_put {repo}`: idempotent, so a repeat keeps its place and passes at the limit.
fn put<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let repo = repo_id(c)?;
    let held = db.query(
        "SELECT repo FROM account_favorites WHERE repo=?",
        &[json!(repo)],
    )?;
    if held.is_empty() {
        let count = db.query("SELECT COUNT(*) AS n FROM account_favorites", &[])?;
        if count.first().and_then(|r| r["n"].as_i64()).unwrap_or(0) >= LIMIT {
            return Err(Error::new(
                "FAVORITES_FULL",
                format!("You can keep {LIMIT} favorites: remove one first"),
            ));
        }
        db.query(
            "INSERT INTO account_favorites(repo,added_at) VALUES(?,?)",
            &[json!(repo), json!(now)],
        )?;
    }
    Ok(json!({ "repo": repo }))
}
