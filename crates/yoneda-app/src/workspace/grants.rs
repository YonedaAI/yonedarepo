use super::*;
use crate::storage::{create, hash, number};
use subtle::ConstantTimeEq;
pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    account(db)?;
    match string(c, "op")?.as_str() {
        "grants" => {
            let rows=db.query("SELECT payload FROM workspace_records WHERE id LIKE 'grant:%' ORDER BY id LIMIT 128",&[])?;
            let mut grants = Vec::new();
            for row in rows {
                let value: Value = serde_json::from_str(
                    row["payload"]
                        .as_str()
                        .ok_or_else(|| bad("Corrupt grant"))?,
                )
                .map_err(|e| bad(&e.to_string()))?;
                if c["repo"].is_null() || c["repo"] == value["repo"] {
                    grants.push(public(&value));
                }
            }
            Ok(json!({"grants":grants}))
        }
        "grant_issue" => {
            let id = string(c, "id")?;
            if !(16..=80).contains(&id.len())
                || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            {
                return Err(bad("Invalid grant ID"));
            }
            let repo = string(c, "repo")?;
            let project = get(db, TABLE, &format!("project:{repo}"))?;
            if project["status"] != "ready" {
                return Err(bad("Repository is not ready"));
            }
            let scope = string(c, "scope")?;
            if !["read", "contribute"].contains(&scope.as_str()) {
                return Err(bad("Grant scope must be read or contribute"));
            }
            let expires = number(c, "expires")?;
            if expires <= now || expires > now + 31 * 24 * 60 * 60 * 1000 {
                return Err(bad("Grant lifetime must be within 31 days"));
            }
            if db
                .query(
                    "SELECT id FROM workspace_records WHERE id LIKE 'grant:%' LIMIT 128",
                    &[],
                )?
                .len()
                >= 128
            {
                return Err(bad("Workspace grant limit reached"));
            }
            let value = json!({"id":id,"repo":repo,"scope":scope,"label":string(c,"label")?,"token_hash":hash(c,"token_hash",&[64])?,"expires":expires,"created_at":now,"revoked":false});
            create(db, TABLE, &format!("grant:{id}"), &value)?;
            audit(db, "grant.issued", now, public(&value))?;
            Ok(public(&value))
        }
        "grant_check" => {
            let value = get(db, TABLE, &format!("grant:{}", string(c, "id")?))?;
            let supplied = hash(c, "token_hash", &[64])?;
            let expected = value["token_hash"].as_str().unwrap_or_default();
            if value["revoked"] == true
                || number(&value, "expires")? <= now
                || !bool::from(supplied.as_bytes().ct_eq(expected.as_bytes()))
            {
                return Err(Error::new("UNAUTHORIZED", "Grant expired or revoked"));
            }
            Ok(public(&value))
        }
        "grant_revoke" => {
            let id = string(c, "id")?;
            let key = format!("grant:{id}");
            let mut value = get(db, TABLE, &key)?;
            value["revoked"] = json!(true);
            put(db, &key, &value)?;
            audit(db, "grant.revoked", now, json!({"id":id}))?;
            Ok(public(&value))
        }
        _ => Err(bad("Unknown grant command")),
    }
}
fn public(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(object) = value.as_object_mut() {
        object.remove("token_hash");
    }
    value
}
