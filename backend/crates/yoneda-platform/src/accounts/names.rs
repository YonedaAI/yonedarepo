//! The name a person goes by: one line they set in Settings, or that a sign-in provider filled
//! in while they had none. It labels their own session only, so it is no one else's to read.
//! It is never an email address: the app shows it where an address would leak.
use super::op::NameOp;
use super::*;

const MAX_CHARS: usize = 80;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: NameOp, now: i64) -> Result<Value> {
    account(db)?;
    match op {
        NameOp::Set => {
            let name = c["name"]
                .as_str()
                .and_then(usable)
                .ok_or_else(|| bad("Use one line of up to 80 characters, not an email address"))?;
            db.query(
                "INSERT INTO account_name(id,name,updated_at) VALUES(1,?,?)
                 ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at",
                &[json!(name), json!(now)],
            )?;
            audit(db, "name.changed", now, json!({}))?;
            Ok(json!({ "display_name": shown(&name) }))
        }
    }
}

/// The account's name, if it has one.
pub(super) fn own<S: SqlStore>(db: &S) -> Result<Option<String>> {
    Ok(db
        .query("SELECT name FROM account_name WHERE id=1", &[])?
        .first()
        .and_then(|row| row["name"].as_str())
        .and_then(shown)
        .map(str::to_string))
}

/// Takes a sign-in provider's `name` for an account that has never had one. An unusable name is
/// no name: it never blocks the sign-in.
pub(super) fn prefill<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<()> {
    let Some(name) = c["name"]
        .as_str()
        .and_then(usable)
        .filter(|n| !n.is_empty())
    else {
        return Ok(());
    };
    db.query(
        "INSERT OR IGNORE INTO account_name(id,name,updated_at) VALUES(1,?,?)",
        &[json!(name), json!(now)],
    )?;
    Ok(())
}

fn shown(name: &str) -> Option<&str> {
    (!name.is_empty()).then_some(name)
}

/// `raw` trimmed, if it is one line of plain text and no email address. Empty clears the name.
fn usable(raw: &str) -> Option<String> {
    let name = raw.trim();
    let plain = name.chars().all(|c| !c.is_control() && !reorders(c));
    (plain && name.chars().count() <= MAX_CHARS && !name.contains('@')).then(|| name.to_string())
}

/// Characters that reorder or hide the text around them.
fn reorders(c: char) -> bool {
    matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')
}
