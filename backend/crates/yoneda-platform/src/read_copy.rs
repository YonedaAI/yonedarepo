//! Disposable, epoch-fenced regional read copies. History and authorization stay at
//! the repository authority; this store holds only content-verified immutable objects.
use crate::platform_objects::{entries_json, supplied_tree};
mod registry;
use crate::repo_store::migration::migrate_with;
use crate::storage::{SqlStore, bad, number, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, ObjectKind, hash_object},
};

pub(crate) const MIGRATIONS: [(i64, &str); 1] =
    [(1, include_str!("migrations/read_copy/0001_copy.sql"))];
/// A copy is optional. Larger objects and full copies continue through the authority.
const OBJECT_BYTES: usize = 1_048_576;
const STORE_BYTES: u64 = 512 * 1024 * 1024;

pub fn migrate_read_copy<S: SqlStore>(db: &S) -> Result<()> {
    migrate_with(db, "read_copy_migrations", &MIGRATIONS)
}

/// One private adapter command. Epoch comparison and byte deletion commit together,
/// so an object fetched before a purge cannot arrive after its fence and resurrect it.
pub fn execute_read_copy<S: SqlStore>(db: &S, command: Value) -> Result<Value> {
    if command["_system"] != "local-copy" {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the platform maintains read copies",
        ));
    }
    let owned = db.clone();
    db.transaction(Box::new(move || execute(&owned, &command)))
}

fn execute<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    if c["op"]
        .as_str()
        .is_some_and(|op| op.starts_with("registry_"))
    {
        return registry::execute(db, c);
    }
    let op = string(c, "op")?;
    if !["copy_get", "copy_put", "copy_fence"].contains(&op.as_str()) {
        return Err(bad("Unknown read-copy command"));
    }
    let repo = string(c, "repo")?;
    if repo.len() != 21
        || !repo.starts_with('r')
        || !repo[1..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(bad("Invalid repository id"));
    }
    let region = string(c, "region")?;
    if !["enam", "weur"].contains(&region.as_str()) {
        return Err(bad("Unsupported copy region"));
    }
    let epoch = number(c, "epoch")?;
    if epoch <= 0 {
        return Err(bad("A copy needs a positive epoch"));
    }
    let held = db.query(
        "SELECT repo,region,epoch,sealed FROM copy_identity WHERE id=1",
        &[],
    )?;
    if let Some(row) = held.first() {
        if row["repo"] != repo || row["region"] != region {
            return Err(Error::new(
                "COPY_FENCED",
                "This is another repository's copy",
            ));
        }
        let previous = row["epoch"]
            .as_i64()
            .ok_or_else(|| Error::new("DATABASE", "Invalid read-copy epoch"))?;
        if op != "copy_fence" && (epoch != previous || row["sealed"] == 1) {
            return Err(Error::new("COPY_FENCED", "The read copy was invalidated"));
        }
    } else {
        // Only a fresh epoch can first publish. A fence may create an empty, sealed copy.
        if epoch != 1 && op != "copy_fence" {
            return Err(Error::new(
                "COPY_FENCED",
                "The read copy needs its current fence",
            ));
        }
        db.query(
            "INSERT INTO copy_identity(id,repo,region,epoch) VALUES(1,?,?,?)",
            &[json!(repo), json!(region), json!(epoch)],
        )?;
    }
    if op == "copy_fence" {
        let seal = c["seal"] == true;
        db.query(
            "UPDATE copy_identity SET epoch=MAX(epoch,?),sealed=MAX(sealed,?) WHERE id=1",
            &[json!(epoch), json!(i64::from(seal))],
        )?;
        if seal {
            db.query("DELETE FROM copy_objects", &[])?;
        } else {
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
                "DELETE FROM copy_objects WHERE id IN (SELECT value FROM json_each(?))",
                &[json!(ids.to_owned())],
            )?;
        }
        let state = db.query("SELECT epoch,sealed FROM copy_identity WHERE id=1", &[])?;
        return Ok(json!({"epoch":state[0]["epoch"],"sealed":state[0]["sealed"]==1}));
    }
    if op == "copy_get" {
        let id = ObjectId::parse(&string(c, "id")?)?;
        let kind = string(c, "kind")?;
        let found = db.query(
            "SELECT payload FROM copy_objects WHERE id=? AND kind=? AND NOT EXISTS (SELECT 1 FROM copy_blocked WHERE copy_blocked.id=copy_objects.id)",
            &[json!(id), json!(kind)],
        )?;
        let object = found
            .first()
            .map(|r| serde_json::from_str::<Value>(r["payload"].as_str().unwrap_or_default()))
            .transpose()
            .map_err(|_| Error::new("DATABASE", "Invalid read-copy payload"))?;
        return Ok(json!({"object":object,"epoch":epoch}));
    }
    let object = &c["object"];
    let payload = serde_json::to_string(object).map_err(|_| bad("Invalid read-copy object"))?;
    // Check encoded length before decoding: no large allocation is needed to refuse it.
    if payload.len() > OBJECT_BYTES * 4 / 3 + 256 {
        return Err(Error::new(
            "COPY_TOO_LARGE",
            "The object uses its authoritative store",
        ));
    }
    let id = ObjectId::parse(&string(object, "id")?)?;
    let kind = string(object, "kind")?;
    if !db
        .query("SELECT 1 FROM copy_blocked WHERE id=?", &[json!(id)])?
        .is_empty()
    {
        return Err(Error::new(
            "COPY_FENCED",
            "The object was purged from this copy",
        ));
    }
    let normalized = match kind.as_str() {
        "tree" => {
            let entries = supplied_tree(&id, object)?;
            json!({"id":id,"kind":kind,"entries":entries_json(&entries)})
        }
        "blob" => {
            let text = object["data_b64"]
                .as_str()
                .ok_or_else(|| bad("A blob needs data_b64"))?;
            let bytes = STANDARD
                .decode(text)
                .map_err(|_| bad("Invalid blob base64"))?;
            if bytes.len() > OBJECT_BYTES {
                return Err(Error::new(
                    "COPY_TOO_LARGE",
                    "The object uses its authoritative store",
                ));
            }
            if hash_object(ObjectKind::Blob, &bytes) != id {
                return Err(Error::new("OBJECT_INVALID", "The blob differs from its id"));
            }
            json!({"id":id,"kind":kind,"data_b64":STANDARD.encode(bytes)})
        }
        _ => return Err(bad("A read copy holds blobs and trees")),
    };
    let payload = normalized.to_string();
    if db.database_size()? >= STORE_BYTES {
        return Err(Error::new(
            "COPY_FULL",
            "The object uses its authoritative store",
        ));
    }
    db.query(
        "INSERT INTO copy_objects(id,kind,payload) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
        &[json!(id), json!(kind), json!(payload)],
    )?;
    Ok(json!({"stored":true,"epoch":epoch}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::NativeStore;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use serde_json::json;
    use yoneda_core::git_object::{ObjectKind, hash_object};
    fn command(op: &str, epoch: i64) -> Value {
        json!({"op":op,"repo":"r01234567890123456789","region":"weur","epoch":epoch,"_system":"local-copy"})
    }
    fn blob(text: &str) -> Value {
        json!({"id":hash_object(ObjectKind::Blob,text.as_bytes()),"kind":"blob","data_b64":STANDARD.encode(text)})
    }
    fn put(db: &NativeStore, epoch: i64, text: &str) -> Result<Value> {
        let mut c = command("copy_put", epoch);
        c["object"] = blob(text);
        execute_read_copy(db, c)
    }
    #[test]
    fn registry_enrolls_all_regions_before_fencing_and_seals_against_late_enrollment() {
        let db = NativeStore::memory().unwrap();
        migrate_read_copy(&db).unwrap();
        let mut p = command("registry_permit", 1);
        p["region"] = json!("weur");
        assert_eq!(execute_read_copy(&db, p.clone()).unwrap()["epoch"], 1);
        p["region"] = json!("enam");
        execute_read_copy(&db, p.clone()).unwrap();
        let mut fence = command("registry_fence", 1);
        fence["ids"] = json!([blob("withheld")["id"]]);
        let fenced = execute_read_copy(&db, fence.clone()).unwrap();
        assert_eq!(fenced["regions"], json!(["enam", "weur"]));
        assert_eq!(fenced["epoch"], 2);
        assert_eq!(
            execute_read_copy(&db, p.clone()).unwrap()["blocked"],
            fenced["blocked"]
        );
        fence["seal"] = json!(true);
        execute_read_copy(&db, fence).unwrap();
        assert_eq!(execute_read_copy(&db, p).unwrap_err().code, "COPY_FENCED");
    }

    #[test]
    fn a_fence_before_a_regions_first_copy_rejects_old_fills() {
        let db = NativeStore::memory().unwrap();
        migrate_read_copy(&db).unwrap();
        let mut fence = command("copy_fence", 2);
        fence["ids"] = json!([]);
        execute_read_copy(&db, fence).unwrap();
        assert_eq!(put(&db, 1, "late").unwrap_err().code, "COPY_FENCED");
        put(&db, 2, "current").unwrap();
    }

    #[test]
    fn reversed_fences_still_delete_every_target_and_prevent_new_epoch_resurrection() {
        let db = NativeStore::memory().unwrap();
        migrate_read_copy(&db).unwrap();
        put(&db, 1, "first").unwrap();
        put(&db, 1, "second").unwrap();
        for (epoch, text) in [(3, "second"), (2, "first")] {
            let mut fence = command("copy_fence", epoch);
            fence["ids"] = json!([blob(text)["id"]]);
            execute_read_copy(&db, fence).unwrap();
        }
        let mut get = command("copy_get", 3);
        get["id"] = blob("first")["id"].clone();
        get["kind"] = json!("blob");
        assert!(execute_read_copy(&db, get).unwrap()["object"].is_null());
        assert_eq!(put(&db, 3, "first").unwrap_err().code, "COPY_FENCED");
        assert_eq!(put(&db, 3, "second").unwrap_err().code, "COPY_FENCED");
    }

    #[test]
    fn an_older_whole_purge_seals_a_copy_already_at_a_newer_epoch() {
        let db = NativeStore::memory().unwrap();
        migrate_read_copy(&db).unwrap();
        put(&db, 1, "gone").unwrap();
        let mut newer = command("copy_fence", 3);
        newer["ids"] = json!([]);
        execute_read_copy(&db, newer).unwrap();
        let mut older = command("copy_fence", 2);
        older["seal"] = json!(true);
        execute_read_copy(&db, older).unwrap();
        assert_eq!(put(&db, 3, "gone").unwrap_err().code, "COPY_FENCED");
    }

    #[test]
    fn read_copy_checks_content_and_reopens_from_durable_state() {
        let db = NativeStore::memory().unwrap();
        migrate_read_copy(&db).unwrap();
        put(&db, 1, "nearby").unwrap();
        migrate_read_copy(&db).unwrap();
        let mut c = command("copy_get", 1);
        c["id"] = blob("nearby")["id"].clone();
        c["kind"] = json!("blob");
        assert_eq!(execute_read_copy(&db, c).unwrap()["object"], blob("nearby"));
        let mut bad = command("copy_put", 1);
        bad["object"] = blob("nearby");
        bad["object"]["data_b64"] = json!(STANDARD.encode("changed"));
        assert_eq!(
            execute_read_copy(&db, bad).unwrap_err().code,
            "OBJECT_INVALID"
        );
    }
    #[test]
    fn read_copy_fence_prevents_late_publication_and_survives_retry() {
        let db = NativeStore::memory().unwrap();
        migrate_read_copy(&db).unwrap();
        put(&db, 1, "erase me").unwrap();
        let mut fence = command("copy_fence", 2);
        fence["ids"] = json!([blob("erase me")["id"]]);
        execute_read_copy(&db, fence.clone()).unwrap();
        execute_read_copy(&db, fence).unwrap();
        assert_eq!(put(&db, 1, "erase me").unwrap_err().code, "COPY_FENCED");
        let mut c = command("copy_get", 2);
        c["id"] = blob("erase me")["id"].clone();
        c["kind"] = json!("blob");
        assert!(execute_read_copy(&db, c).unwrap()["object"].is_null());
        put(&db, 2, "other").unwrap();
    }
    #[test]
    fn read_copy_seal_cannot_be_reopened_or_recreated_by_an_old_job() {
        let db = NativeStore::memory().unwrap();
        migrate_read_copy(&db).unwrap();
        put(&db, 1, "gone").unwrap();
        let mut fence = command("copy_fence", 2);
        fence["seal"] = json!(true);
        execute_read_copy(&db, fence).unwrap();
        for epoch in [1, 2, 3] {
            assert_eq!(put(&db, epoch, "gone").unwrap_err().code, "COPY_FENCED");
        }
    }
    #[test]
    fn read_copy_refuses_untrusted_callers_and_bounds_payloads() {
        let db = NativeStore::memory().unwrap();
        migrate_read_copy(&db).unwrap();
        let mut c = command("copy_put", 1);
        c["_system"] = json!("projection");
        c["object"] = blob("x");
        assert_eq!(execute_read_copy(&db, c).unwrap_err().code, "FORBIDDEN");
        assert_eq!(
            put(&db, 1, &"x".repeat(1_048_577)).unwrap_err().code,
            "COPY_TOO_LARGE"
        );
    }
}
