//! A project's platform repository and the agent layer's sealed token for it. The token is
//! kept in its own record so project reads (which reach the browser) never include it.
use super::*;

fn credential_key(id: &str) -> String {
    format!("platform-credential:{id}")
}

fn platform_repo(c: &Value) -> Result<String> {
    let repo = string(c, "platform_repo")?;
    if repo.len() != 21
        || !repo.starts_with('r')
        || !repo[1..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(bad("Invalid platform repository"));
    }
    Ok(repo)
}

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, key: &str, now: i64) -> Result<Value> {
    let id = string(c, "id")?;
    let mut project = get(db, TABLE, key)?;
    if project["status"] == "deleted" {
        return Err(Error::new(
            "REPOSITORY_DELETED",
            "This repository has been deleted",
        ));
    }
    match string(c, "op")?.as_str() {
        "project_platform_bind" => {
            let repo = platform_repo(c)?;
            let sealed = &c["sealed"];
            if ![&sealed["iv"], &sealed["ciphertext"]]
                .iter()
                .all(|v| v.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 4096))
                || sealed["v"] != 2
            {
                return Err(bad("Invalid sealed platform credential"));
            }
            // First binding wins; a concurrent setup's repository is left unused.
            if let Some(bound) = project["platform"]["repo"].as_str() {
                return Ok(json!({"id":id,"platform":{"repo":bound}}));
            }
            put(
                db,
                &credential_key(&id),
                &json!({"repo":repo,"sealed":sealed}),
            )?;
            project["platform"] = json!({"repo":repo});
            project["updated_at"] = json!(now);
            put(db, key, &project)?;
            audit(
                db,
                "project.platform_bound",
                now,
                json!({"id":id,"repo":repo}),
            )?;
            Ok(json!({"id":id,"platform":{"repo":repo}}))
        }
        "project_platform_credential" => get(db, TABLE, &credential_key(&id)),
        _ => Err(bad("Unknown platform credential operation")),
    }
}
