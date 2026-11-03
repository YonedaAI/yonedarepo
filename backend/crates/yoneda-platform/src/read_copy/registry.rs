//! Which regional stores exist, and their common publication epoch. A durable purge
//! fences this registry before deleting every registered store; late fills cannot enroll
//! a region that the purge missed or obtain a new publication epoch after sealing.
use crate::storage::{SqlStore, bad, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

pub(super) fn execute<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let repo = string(c, "repo")?;
    if repo.len() != 21
        || !repo.starts_with('r')
        || !repo[1..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(bad("Invalid repository id"));
    }
    let rows = db.query(
        "SELECT repo,region,epoch,sealed FROM copy_identity WHERE id=1",
        &[],
    )?;
    if let Some(row) = rows.first() {
        if row["repo"] != repo || row["region"] != "registry" {
            return Err(Error::new(
                "COPY_FENCED",
                "This is another repository's registry",
            ));
        }
    } else {
        db.query(
            "INSERT INTO copy_identity(id,repo,region,epoch) VALUES(1,?,'registry',1)",
            &[json!(repo)],
        )?;
    }
    match string(c, "op")?.as_str() {
        "registry_permit" => {
            let sealed = db.query("SELECT sealed FROM copy_identity WHERE id=1", &[])?;
            if sealed[0]["sealed"] == 1 {
                return Err(Error::new("COPY_FENCED", "The repository copy was deleted"));
            }
            let region = string(c, "region")?;
            if !["enam", "weur"].contains(&region.as_str()) {
                return Err(bad("Unsupported copy region"));
            }
            db.query(
                "INSERT INTO copy_regions(region) VALUES(?) ON CONFLICT DO NOTHING",
                &[json!(region)],
            )?;
        }
        "registry_fence" => {
            let ids = c["ids"]
                .as_array()
                .filter(|ids| ids.len() <= 1000)
                .ok_or_else(|| bad("A fence needs at most 1000 ids"))?;
            for id in ids {
                let id = ObjectId::parse(id.as_str().ok_or_else(|| bad("Invalid object id"))?)?;
                db.query(
                    "INSERT INTO copy_blocked(id) VALUES(?) ON CONFLICT DO NOTHING",
                    &[json!(id)],
                )?;
            }
            db.query(
                "UPDATE copy_identity SET epoch=epoch+1,sealed=MAX(sealed,?) WHERE id=1",
                &[json!(i64::from(c["seal"] == true))],
            )?;
        }
        _ => return Err(bad("Unknown copy-registry command")),
    }
    let meta = db.query("SELECT epoch,sealed FROM copy_identity WHERE id=1", &[])?;
    let regions = db.query("SELECT region FROM copy_regions ORDER BY region", &[])?;
    // A repository with many withheld objects uses its authoritative path; it cannot
    // silently omit a target from a publication permit.
    let blocked = db.query("SELECT id FROM copy_blocked ORDER BY id LIMIT 1001", &[])?;
    Ok(
        json!({"epoch":meta[0]["epoch"],"sealed":meta[0]["sealed"]==1,"regions":regions.iter().map(|r|&r["region"]).collect::<Vec<_>>(),"blocked":blocked.iter().map(|r|&r["id"]).collect::<Vec<_>>(),"disabled":blocked.len()>1000}),
    )
}
