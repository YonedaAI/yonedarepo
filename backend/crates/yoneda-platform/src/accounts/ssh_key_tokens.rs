//! Which personal token added which SSH key: one record per key (`ssh_key_token:<key id>`),
//! written with the key. Revoking the token removes its live keys in the same transaction.
//! A key added by a signed-in person has no record, nor has one from before records began,
//! so neither ever goes with a token. A key id is never reused: adding a key again after
//! removing it makes a new id, with the adder's record.
use super::*;

const RECORD: &str = "ssh_key_token:";

pub(super) fn record<S: SqlStore>(db: &S, key: &str, token: &str) -> Result<()> {
    put(db, &format!("{RECORD}{key}"), &json!({"token":token}))
}

/// Forgets a removed key's record.
pub(super) fn forget<S: SqlStore>(db: &S, key: &str) -> Result<()> {
    db.query(
        &format!("DELETE FROM {TABLE} WHERE id=?"),
        &[json!(format!("{RECORD}{key}"))],
    )?;
    Ok(())
}

pub(super) fn forget_all<S: SqlStore>(db: &S) -> Result<()> {
    db.query(
        &format!("DELETE FROM {TABLE} WHERE id LIKE '{RECORD}%'"),
        &[],
    )?;
    Ok(())
}

/// The live keys `token` added: `{id, title, fingerprint}`, oldest first.
pub(super) fn added_by<S: SqlStore>(db: &S, token: &str) -> Result<Vec<Value>> {
    db.query(
        &format!(
            "SELECT k.id,k.title,k.fingerprint FROM account_ssh_keys k JOIN {TABLE} r ON r.id='{RECORD}'||k.id WHERE k.removed_at IS NULL AND json_extract(r.payload,'$.token')=? ORDER BY k.created_at,k.id"
        ),
        &[json!(token)],
    )
}

/// Removes the live keys `token` added and answers with them. Runs inside the revocation's
/// transaction; the fingerprint claims are the caller's to release afterwards.
pub(super) fn remove_added_by<S: SqlStore>(db: &S, token: &str, now: i64) -> Result<Vec<Value>> {
    let keys = added_by(db, token)?;
    for key in &keys {
        let id = key["id"].as_str().ok_or_else(|| bad("Corrupt SSH key"))?;
        db.query(
            "UPDATE account_ssh_keys SET removed_at=? WHERE id=?",
            &[json!(now), json!(id)],
        )?;
        forget(db, id)?;
        audit(
            db,
            "ssh_key.removed",
            now,
            json!({"id":id,"reason":"token_revoked","token":token}),
        )?;
    }
    Ok(keys)
}
