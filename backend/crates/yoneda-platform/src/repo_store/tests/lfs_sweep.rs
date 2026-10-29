//! LFS orphans: bytes no row references (a reservation that lapsed, an upload that failed
//! verification) are queued in an outbox and swept by the platform's LFS job under a lease.
//! A claimed oid is neither reserved nor stored while its lease runs, so a sweep never
//! deletes an object's bytes; a finisher fenced by its epoch is a no-op, and one that
//! finishes after its lease demotes an object stored meanwhile so its bytes are uploaded
//! again. The first reservation and every new orphan arm the sweep job once.
use super::*;
use crate::repo_store::lfs::PENDING_MS;
use crate::repo_store::lfs::sweep::LEASE_MS;
use crate::storage::SqlStore;

const SWEEPER: &str = "platform:lfs";

fn oid(n: u8) -> String {
    format!("{n:02x}").repeat(32)
}

fn upload(h: &Harness, objects: Value) -> Value {
    h.ok(
        AGENT,
        json!({"op":"repo_lfs_batch","operation":"upload","objects":objects}),
    )
}

fn claim(h: &Harness) -> Value {
    h.ok(SWEEPER, json!({"op":"repo_lfs_sweep_claim","limit":10}))
}

fn claimed(answer: &Value) -> Vec<String> {
    answer["claims"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["oid"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn only_the_lfs_job_sweeps() {
    let h = Harness::new();
    for who in [AGENT, OWNER, SYSTEM] {
        let refused = h
            .run(who, json!({"op":"repo_lfs_sweep_claim","limit":10}))
            .unwrap_err();
        assert_eq!(refused.code, "FORBIDDEN", "{who}");
        let refused = h
            .run(who, json!({"op":"repo_lfs_sweep_done","claims":[]}))
            .unwrap_err();
        assert_eq!(refused.code, "FORBIDDEN", "{who}");
    }
}

#[test]
fn lapsed_and_failed_uploads_are_swept_under_a_lease() {
    let h = Harness::new();
    // The first reservation arms the job for when it lapses; later ones find it armed.
    let first = upload(&h, json!([{"oid": oid(1), "size": 10}]));
    let at = *h.now.borrow();
    assert_eq!(first["sweep_at"], json!(at + PENDING_MS));
    assert_eq!(
        upload(&h, json!([{"oid": oid(2), "size": 10}]))["sweep_at"],
        Value::Null
    );
    // Nothing is due yet: a live reservation is never claimed.
    let early = claim(&h);
    assert_eq!(claimed(&early), Vec::<String>::new());
    assert_eq!(early["next_at"], json!(at + PENDING_MS));

    // A failed verification orphans its bytes at once and arms the job for now.
    let discarded = h.ok(AGENT, json!({"op":"repo_lfs_discard","oid":oid(2)}));
    assert_eq!(discarded["stored"], false);
    assert_eq!(discarded["sweep_at"], json!(*h.now.borrow()));
    // A day later the other reservation lapses: both are claimed.
    *h.now.borrow_mut() += PENDING_MS;
    let swept = claim(&h);
    let mut oids = claimed(&swept);
    oids.sort();
    assert_eq!(oids, vec![oid(1), oid(2)]);
    assert_eq!(swept["next_at"], Value::Null);

    // While the lease runs, the oid can be neither reserved nor stored.
    let busy = upload(&h, json!([{"oid": oid(1), "size": 10}]));
    assert_eq!(busy["objects"][0]["error"]["code"], 409);
    let refused = h
        .run(AGENT, json!({"op":"repo_lfs_store","oid":oid(1),"size":10}))
        .unwrap_err();
    assert_eq!(refused.code, "CONFLICT");

    // Done: the outbox is empty, and done again (a redelivered job) changes nothing.
    let claims = swept["claims"].clone();
    let done = h.ok(SWEEPER, json!({"op":"repo_lfs_sweep_done","claims":claims}));
    assert_eq!(
        (done["done"].clone(), done["demoted"].clone()),
        (json!(2), json!([]))
    );
    let again = h.ok(SWEEPER, json!({"op":"repo_lfs_sweep_done","claims":claims}));
    assert_eq!(again["done"], 0);
    assert_eq!(claimed(&claim(&h)), Vec::<String>::new());
    // The oid uploads normally again.
    let fresh = upload(&h, json!([{"oid": oid(1), "size": 10}]));
    assert_eq!(fresh["objects"][0]["upload"], true);
}

#[test]
fn a_referenced_object_is_never_claimed() {
    let h = Harness::new();
    upload(
        &h,
        json!([{"oid": oid(1), "size": 10}, {"oid": oid(2), "size": 10}]),
    );
    h.ok(AGENT, json!({"op":"repo_lfs_store","oid":oid(1),"size":10}));
    // Discarding a stored object keeps it and queues nothing.
    let kept = h.ok(AGENT, json!({"op":"repo_lfs_discard","oid":oid(1)}));
    assert_eq!(
        (kept["stored"].clone(), kept["sweep_at"].clone()),
        (json!(true), Value::Null)
    );
    // An orphan whose oid is uploaded again before the sweep is no orphan any more.
    h.ok(AGENT, json!({"op":"repo_lfs_discard","oid":oid(2)}));
    upload(&h, json!([{"oid": oid(2), "size": 10}]));
    h.ok(AGENT, json!({"op":"repo_lfs_store","oid":oid(2),"size":10}));
    *h.now.borrow_mut() += 2 * PENDING_MS;
    assert_eq!(claimed(&claim(&h)), Vec::<String>::new());
    let down = h.ok(
        CI,
        json!({"op":"repo_lfs_batch","operation":"download","objects":[{"oid":oid(1),"size":10},{"oid":oid(2),"size":10}]}),
    );
    assert_eq!(down["objects"][0]["present"], true);
    assert_eq!(down["objects"][1]["present"], true);
}

#[test]
fn an_expired_lease_is_reclaimed_and_its_late_finisher_fenced() {
    let h = Harness::new();
    upload(&h, json!([{"oid": oid(1), "size": 10}]));
    h.ok(AGENT, json!({"op":"repo_lfs_discard","oid":oid(1)}));
    let first = claim(&h);
    assert_eq!(first["claims"][0]["epoch"], 1);
    // Leased: another job claims nothing, but is told when the lease ends.
    let other = claim(&h);
    assert_eq!(claimed(&other), Vec::<String>::new());
    assert_eq!(other["next_at"], first["lease_until"]);
    // The first job died; after its lease another one claims the oid again.
    *h.now.borrow_mut() += LEASE_MS;
    let second = claim(&h);
    assert_eq!(second["claims"][0]["epoch"], 2);
    // The dead job's late finish is fenced by its epoch.
    let late = h.ok(
        SWEEPER,
        json!({"op":"repo_lfs_sweep_done","claims":first["claims"]}),
    );
    assert_eq!(late["done"], 0);
    let done = h.ok(
        SWEEPER,
        json!({"op":"repo_lfs_sweep_done","claims":second["claims"]}),
    );
    assert_eq!(done["done"], 1);
}

#[test]
fn a_sweep_finished_after_its_lease_demotes_an_object_stored_meanwhile() {
    let h = Harness::new();
    upload(&h, json!([{"oid": oid(1), "size": 10}]));
    h.ok(AGENT, json!({"op":"repo_lfs_discard","oid":oid(1)}));
    let slow = claim(&h);
    // The lease ran out before the job deleted the bytes; meanwhile the object was stored.
    *h.now.borrow_mut() += LEASE_MS;
    upload(&h, json!([{"oid": oid(1), "size": 10}]));
    h.ok(AGENT, json!({"op":"repo_lfs_store","oid":oid(1),"size":10}));
    let done = h.ok(
        SWEEPER,
        json!({"op":"repo_lfs_sweep_done","claims":slow["claims"]}),
    );
    // Its bytes may be gone: it is pending again, so the next push uploads it.
    assert_eq!(done["demoted"], json!([oid(1)]));
    let up = upload(&h, json!([{"oid": oid(1), "size": 10}]));
    assert_eq!(up["objects"][0]["upload"], true);
}

#[test]
fn upgrades_from_the_visibility_schema_keeping_reservations() {
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    let before = migrations
        .iter()
        .position(|(version, _)| *version == 36)
        .unwrap();
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..before])
        .unwrap();
    db.query("INSERT INTO lfs_objects(oid,size,state,uploaded_by,reserved_at) VALUES(?,10,'pending','user:owner',1)", &[json!(oid(1))]).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    for table in ["lfs_orphans", "lfs_sweep"] {
        assert!(
            db.query(&format!("SELECT * FROM {table}"), &[])
                .unwrap()
                .is_empty()
        );
    }
    let kept = db.query("SELECT oid,state FROM lfs_objects", &[]).unwrap();
    assert_eq!(kept, vec![json!({"oid": oid(1), "state": "pending"})]);
}
