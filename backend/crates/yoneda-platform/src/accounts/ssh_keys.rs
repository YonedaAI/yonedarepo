//! SSH public keys for Git over SSH. An account authority holds its own keys (add, list,
//! check, remove); a separate authority instance per fingerprint (`sshkey:<fingerprint>`)
//! maps a key to the one account that registered it, so the gateway's lookup is strongly
//! consistent. The account's own row stays the authority: a lookup that finds a claim still
//! checks the key with its account, so removal takes effect at once and a stale claim
//! grants nothing.
use super::op::SshOp;
use super::*;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
};
use sha2::{Digest, Sha256};

const LIVE_LIMIT: i64 = 50;
/// `last_used_at` is written at most this often, so checks rarely write.
const USE_RESOLUTION: i64 = 60_000;
const RSA_MIN_BITS: usize = 2048;
const RSA_MAX_BITS: usize = 16384;

/// A validated OpenSSH public key: its algorithm, normalized line (no comment) and
/// `SHA256:` fingerprint as `ssh-keygen -l` prints it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PublicKey {
    pub algorithm: String,
    pub line: String,
    pub fingerprint: String,
}

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: SshOp, now: i64) -> Result<Value> {
    match op {
        SshOp::KeyAdd => add(db, c, now),
        SshOp::KeyList => {
            account(db)?;
            let rows = db.query(
                "SELECT * FROM account_ssh_keys WHERE removed_at IS NULL ORDER BY created_at,id",
                &[],
            )?;
            Ok(json!({"keys": rows.iter().map(public).collect::<Vec<_>>()}))
        }
        SshOp::KeyCheck => {
            super::access::refuse_suspended(db)?;
            let id = key_id(c)?;
            let row = db
                .query(
                    "SELECT * FROM account_ssh_keys WHERE id=? AND removed_at IS NULL",
                    &[json!(id)],
                )?
                .into_iter()
                .next()
                .ok_or_else(|| Error::new("UNAUTHORIZED", "Unknown or removed SSH key"))?;
            if let Some(expected) = c.get("fingerprint").and_then(Value::as_str)
                && row["fingerprint"] != expected
            {
                return Err(Error::new("UNAUTHORIZED", "Unknown or removed SSH key"));
            }
            if row["last_used_at"]
                .as_i64()
                .is_none_or(|at| at + USE_RESOLUTION <= now)
            {
                db.query(
                    "UPDATE account_ssh_keys SET last_used_at=? WHERE id=?",
                    &[json!(now), json!(id)],
                )?;
            }
            let username = account(db)?["username"].clone();
            let orgs = super::orgs::hints(db)?;
            Ok(json!({"id":id,"fingerprint":row["fingerprint"],"username":username,"orgs":orgs}))
        }
        SshOp::KeyRemove => {
            account(db)?;
            let id = key_id(c)?;
            let found = db.query(
                "SELECT fingerprint FROM account_ssh_keys WHERE id=? AND removed_at IS NULL",
                &[json!(id)],
            )?;
            let row = found
                .first()
                .ok_or_else(|| Error::new("NOT_FOUND", "Unknown SSH key"))?;
            db.query(
                "UPDATE account_ssh_keys SET removed_at=? WHERE id=?",
                &[json!(now), json!(id)],
            )?;
            audit(db, "ssh_key.removed", now, json!({"id":id}))?;
            Ok(json!({"id":id,"deleted":true,"fingerprint":row["fingerprint"]}))
        }
        SshOp::FpClaim => {
            let fingerprint = fingerprint(c)?;
            let (account, key) = (string(c, "account")?, key_id(c)?);
            let held = claim(db, &fingerprint)?;
            if let Some(held) = held.filter(|h| h["account"] != account || h["key_id"] != key)
                && c["replace"] != true
            {
                return Ok(json!({"claimed":false,"holder":held}));
            }
            db.query(
                "INSERT INTO ssh_fingerprints(fingerprint,account,key_id,claimed_at) VALUES(?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET account=excluded.account,key_id=excluded.key_id,claimed_at=excluded.claimed_at",
                &[json!(fingerprint), json!(account), json!(key), json!(now)],
            )?;
            Ok(json!({"claimed":true}))
        }
        SshOp::FpGet => {
            claim(db, &fingerprint(c)?)?.ok_or_else(|| Error::new("NOT_FOUND", "Unknown SSH key"))
        }
        SshOp::FpRelease => {
            db.query(
                "DELETE FROM ssh_fingerprints WHERE fingerprint=? AND account=? AND key_id=?",
                &[
                    json!(fingerprint(c)?),
                    json!(string(c, "account")?),
                    json!(key_id(c)?),
                ],
            )?;
            Ok(json!({"released":true}))
        }
    }
}

fn claim<S: SqlStore>(db: &S, fingerprint: &str) -> Result<Option<Value>> {
    let rows = db.query(
        "SELECT account,key_id FROM ssh_fingerprints WHERE fingerprint=?",
        &[json!(fingerprint)],
    )?;
    Ok(rows
        .into_iter()
        .next()
        .map(|r| json!({"account":r["account"],"key_id":r["key_id"]})))
}

fn add<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    account(db)?;
    let id = key_id(c)?;
    let title = string(c, "title")?;
    if title.trim().is_empty() || title.chars().count() > 64 || title.chars().any(char::is_control)
    {
        return Err(bad("Key titles are 1-64 printable characters"));
    }
    let key = parse_public_key(&string(c, "public_key")?)?;
    let live = db.query(
        "SELECT fingerprint FROM account_ssh_keys WHERE removed_at IS NULL",
        &[],
    )?;
    if live.iter().any(|r| r["fingerprint"] == key.fingerprint) {
        return Err(Error::new(
            "ALREADY_EXISTS",
            "This key is already added to the account",
        ));
    }
    if live.len() as i64 >= LIVE_LIMIT {
        return Err(bad("SSH key limit reached; remove one first"));
    }
    db.query(
        "INSERT INTO account_ssh_keys(id,title,fingerprint,algorithm,public_key,created_at) VALUES(?,?,?,?,?,?)",
        &[json!(id), json!(title), json!(key.fingerprint), json!(key.algorithm), json!(key.line), json!(now)],
    )?;
    audit(
        db,
        "ssh_key.added",
        now,
        json!({"id":id,"fingerprint":key.fingerprint}),
    )?;
    let row = db.query("SELECT * FROM account_ssh_keys WHERE id=?", &[json!(id)])?;
    Ok(public(
        row.first().ok_or_else(|| bad("Key was not stored"))?,
    ))
}

/// Removes every live key (account recovery: a key added by whoever held the account
/// must not outlive the recovery).
pub(super) fn remove_all<S: SqlStore>(db: &S, now: i64) -> Result<()> {
    db.query(
        "UPDATE account_ssh_keys SET removed_at=? WHERE removed_at IS NULL",
        &[json!(now)],
    )?;
    Ok(())
}

fn public(row: &Value) -> Value {
    json!({
        "id": row["id"], "title": row["title"], "fingerprint": row["fingerprint"],
        "algorithm": row["algorithm"], "created_at": row["created_at"],
        "last_used_at": row["last_used_at"],
    })
}

/// `ssh_<16 hex>`.
fn key_id(c: &Value) -> Result<String> {
    let id = c
        .get("key_id")
        .or_else(|| c.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| bad("key id required"))?;
    if id.len() != 20
        || !id.starts_with("ssh_")
        || !id[4..]
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(bad("Invalid SSH key id"));
    }
    Ok(id.to_owned())
}

/// `SHA256:` and 43 unpadded base64 characters.
fn fingerprint(c: &Value) -> Result<String> {
    let fp = string(c, "fingerprint")?;
    let valid = fp.strip_prefix("SHA256:").is_some_and(|b| {
        b.len() == 43
            && b.bytes()
                .all(|x| x.is_ascii_alphanumeric() || x == b'+' || x == b'/')
    });
    if !valid {
        return Err(bad("Invalid SSH key fingerprint"));
    }
    Ok(fp)
}

/// Parses one OpenSSH public key line (`<type> <base64> [comment]`). Accepted: Ed25519,
/// ECDSA on NIST P-256/384/521 and RSA of 2048-16384 bits; the blob must be exactly the
/// structure its type names.
pub(crate) fn parse_public_key(text: &str) -> Result<PublicKey> {
    let invalid = || bad("Not an OpenSSH public key (ssh-ed25519, ecdsa-sha2-nistp* or ssh-rsa)");
    let mut parts = text.split_whitespace();
    let (Some(kind), Some(data)) = (parts.next(), parts.next()) else {
        return Err(invalid());
    };
    if text.len() > 16 * 1024 {
        return Err(invalid());
    }
    let blob = STANDARD.decode(data).map_err(|_| invalid())?;
    let mut r = Reader(&blob);
    if r.string()? != kind.as_bytes() {
        return Err(invalid());
    }
    match kind {
        "ssh-ed25519" => {
            if r.string()?.len() != 32 {
                return Err(invalid());
            }
        }
        "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ecdsa-sha2-nistp521" => {
            let curve = &kind["ecdsa-sha2-".len()..];
            let point = (r.string()? == curve.as_bytes())
                .then(|| r.string())
                .ok_or_else(invalid)??;
            let coordinate = match curve {
                "nistp256" => 32,
                "nistp384" => 48,
                _ => 66,
            };
            if point.len() != 1 + 2 * coordinate || point[0] != 4 {
                return Err(invalid());
            }
        }
        "ssh-rsa" => {
            let e = r.string()?;
            let n = r.string()?;
            let bits = significant(n).map_or(0, |m| m.len() * 8 - m[0].leading_zeros() as usize);
            if significant(e).is_none() || !(RSA_MIN_BITS..=RSA_MAX_BITS).contains(&bits) {
                return Err(bad("RSA keys must be 2048-16384 bits"));
            }
        }
        _ => return Err(invalid()),
    }
    if !r.0.is_empty() {
        return Err(invalid());
    }
    Ok(PublicKey {
        algorithm: kind.to_owned(),
        line: format!("{kind} {data}"),
        fingerprint: format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(&blob))),
    })
}

/// An mpint's magnitude without leading zero bytes; `None` for zero.
fn significant(m: &[u8]) -> Option<&[u8]> {
    m.iter().position(|&b| b != 0).map(|i| &m[i..])
}

/// SSH wire-format strings (`uint32` length, bytes).
struct Reader<'a>(&'a [u8]);
impl<'a> Reader<'a> {
    fn string(&mut self) -> Result<&'a [u8]> {
        let invalid = || bad("Truncated SSH public key");
        let (len, rest) = self.0.split_first_chunk::<4>().ok_or_else(invalid)?;
        let len = u32::from_be_bytes(*len) as usize;
        if rest.len() < len {
            return Err(invalid());
        }
        let (value, rest) = rest.split_at(len);
        self.0 = rest;
        Ok(value)
    }
}
