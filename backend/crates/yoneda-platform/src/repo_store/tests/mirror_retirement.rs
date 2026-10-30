//! Retiring an Artifacts mirror after a purge: the first blob purge of a mirrored
//! repository requests it in the purge's transaction; the quarantine job leases it (fenced
//! by epoch), records copied commits, switches the store (projection stops for good) and
//! closes it once the mirror is deleted. Records show it; no other store is touched.
use super::*;
use crate::storage::SqlStore;

const REPLACEMENT: &str = "platform:r0123456789abcdef0123";

fn job(h: &Harness, mut c: Value) -> yoneda_core::Result<Value> {
    *h.now.borrow_mut() += 1_000;
    c["now"] = json!(*h.now.borrow());
    c["_system"] = json!("quarantine");
    execute_repo_store(&h.db, c)
}

fn store(h: &Harness) -> String {
    h.db.query("SELECT object_store FROM repo_settings", &[])
        .unwrap()[0]["object_store"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Quarantines the blob of `text` and purges it at once, as the owner's purge does.
fn purge(h: &Harness, text: &str) -> (i64, Value) {
    let blob = hash_object(ObjectKind::Blob, text.as_bytes()).hex();
    let made = h.ok(
        OWNER,
        json!({"op":"repo_quarantine","target":{"kind":"blob","id":blob},"reason":"leaked"}),
    );
    let id = made["record"]["id"].as_i64().unwrap();
    let claimed = h.ok(
        OWNER,
        json!({"op":"repo_quarantine_purge","id":id,"confirm":blob}),
    );
    let claims: Vec<Value> = claimed["claims"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| json!({"id": c["id"], "epoch": c["epoch"]}))
        .collect();
    let done = h.ok(
        OWNER,
        json!({"op":"repo_quarantine_purged","claims":claims,"replacement":REPLACEMENT}),
    );
    (id, done)
}

fn record(h: &Harness) -> Value {
    h.ok(OWNER, json!({"op":"repo_quarantines"}))
}

/// Prepares a commit too large to stage would be: answered with its push (no `stage`).
fn prepare(h: &Harness, parent: &str) -> Value {
    let mut trees = serde_json::Map::new();
    loop {
        let prepared = h.ok(
            AGENT,
            json!({"op":"repo_prepare_commit","parent":parent,"base_version":1,
                   "changes":[file("src/b.rs","pub fn b() {}\n")],"read_set":[],"trees":trees,
                   "blobs":{},"message":"m","author":{"name":"A","email":"a@example.com"}}),
        );
        match prepared["need_trees"].as_array() {
            Some(need) => {
                for id in need {
                    let id = id.as_str().unwrap();
                    trees.insert(id.into(), h.tree_json(id));
                }
            }
            None => return prepared,
        }
    }
}

#[test]
fn a_blob_purge_retires_the_mirror_through_a_fenced_switch() {
    let (h, root) = seeded();
    assert_eq!(record(&h)["mirror"], Value::Null);
    let early = prepare(&h, &root);
    assert!(early["push_b64"].is_string());
    assert!(early.get("push_store").is_none());
    let (id, done) = purge(&h, "pub fn a() {}\n");
    assert_eq!(done["mirror"], true);
    let listed = record(&h);
    assert_eq!(listed["records"][0]["mirror"], "retiring");
    assert_eq!(listed["mirror"]["state"], "copying");
    // A commit prepared for a push to the mirror can no longer be recorded.
    assert_eq!(
        code(h.run(
            AGENT,
            json!({"op":"repo_record_commit","commit":early["commit"],"push_report_b64":"","readback":{}})
        )),
        "NOT_FOUND"
    );
    // While copying, reads stay on the mirror; large commits push to the replacement.
    assert_eq!(store(&h), "artifacts:test/demo");
    assert_eq!(prepare(&h, &root)["push_store"], REPLACEMENT);

    // Only the quarantine job works through it.
    for who in [OWNER, CI, "platform:projection"] {
        assert_eq!(
            code(h.run(who, json!({"op":"repo_mirror_claim"}))),
            "FORBIDDEN"
        );
    }
    let claim = job(&h, json!({"op":"repo_mirror_claim"})).unwrap();
    assert_eq!(
        claim["retirement"]["mirror"], "artifacts:test/demo",
        "{claim}"
    );
    assert_eq!(claim["retirement"]["replacement"], REPLACEMENT);
    let epoch = claim["epoch"].clone();
    job(
        &h,
        json!({"op":"repo_mirror_copied","epoch":epoch,"commits":[root]}),
    )
    .unwrap();
    // Deleting before the switch is refused.
    assert_eq!(
        code(job(&h, json!({"op":"repo_mirror_retired","epoch":epoch}))),
        "CONFLICT"
    );
    let pending = || {
        h.ok(
            "platform:projection",
            json!({"op":"repo_projection_pending"}),
        )["pending"]
            .as_array()
            .unwrap()
            .len()
    };
    let child = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("x.txt", "x\n")]),
            json!([]),
        )
        .unwrap();
    h.approve_and_check(&child);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":child}));
    assert_eq!(pending(), 1);

    let switched = job(&h, json!({"op":"repo_mirror_switch","epoch":epoch})).unwrap();
    assert_eq!(switched["object_store"], REPLACEMENT);
    assert_eq!(store(&h), REPLACEMENT);
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_status"}))["object_store"],
        REPLACEMENT
    );
    // Projection stops for good: nothing pending, a late report changes nothing, and a
    // later landing records no target.
    assert_eq!(pending(), 0);
    let late = h.ok(
        "platform:projection",
        json!({"op":"repo_projection_result","refname":"refs/heads/main","version":2,
               "outcome":"ok","commit":child}),
    );
    assert_eq!(late["ignored"], true);
    assert!(
        h.ok(OWNER, json!({"op":"repo_status"}))["projections"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let next = h
        .commit(
            AGENT,
            Some(&child),
            2,
            json!([file("y.txt", "y\n")]),
            json!([]),
        )
        .unwrap();
    h.approve_and_check(&next);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":next}));
    assert_eq!(pending(), 0);
    assert!(prepare(&h, &next).get("push_store").is_none());
    // Repeatable (a run that died after the switch runs it again).
    job(&h, json!({"op":"repo_mirror_switch","epoch":epoch})).unwrap();
    assert_eq!(store(&h), REPLACEMENT);

    job(&h, json!({"op":"repo_mirror_retired","epoch":epoch})).unwrap();
    let listed = record(&h);
    assert_eq!(listed["records"][0]["id"], id);
    assert_eq!(listed["records"][0]["mirror"], "retired");
    assert_eq!(listed["mirror"]["state"], "retired");
    assert_eq!(
        job(&h, json!({"op":"repo_mirror_claim"})).unwrap()["retirement"],
        Value::Null
    );
    // A later purge needs no mirror retired.
    let (_, again) = purge(&h, "# demo\n");
    assert_eq!(again["mirror"], false);
    assert_eq!(record(&h)["records"][0]["mirror"], Value::Null);
}

#[test]
fn a_retirement_resumes_under_a_new_lease_and_fences_the_run_it_replaced() {
    let (h, root) = seeded();
    purge(&h, "pub fn a() {}\n");
    let first = job(&h, json!({"op":"repo_mirror_claim"})).unwrap();
    let late = first["epoch"].clone();
    job(
        &h,
        json!({"op":"repo_mirror_copied","epoch":late,"commits":[root]}),
    )
    .unwrap();
    // Leased: a second run waits.
    let busy = job(&h, json!({"op":"repo_mirror_claim"})).unwrap();
    assert_eq!(busy["busy"], true);
    job(
        &h,
        json!({"op":"repo_mirror_failed","epoch":late,"detail":"pack too large"}),
    )
    .unwrap();
    assert_eq!(record(&h)["mirror"]["detail"], "pack too large");
    // A failure releases the lease; the next run resumes with what was copied.
    let second = job(&h, json!({"op":"repo_mirror_claim"})).unwrap();
    let current = second["epoch"].clone();
    assert_ne!(late, current);
    assert_eq!(second["copied"], json!([root]));
    assert_eq!(second["retirement"]["state"], "copying");
    // The replaced run reports nothing.
    for op in [
        "repo_mirror_copied",
        "repo_mirror_switch",
        "repo_mirror_retired",
    ] {
        assert_eq!(
            code(job(&h, json!({"op":op,"epoch":late,"commits":[]}))),
            "CONFLICT",
            "{op}"
        );
    }
    assert_eq!(store(&h), "artifacts:test/demo");
    // A run that died after the switch: the next one claims at `switched`.
    job(&h, json!({"op":"repo_mirror_switch","epoch":current})).unwrap();
    *h.now.borrow_mut() += super::super::quarantine::mirror::LEASE_MS;
    let third = job(&h, json!({"op":"repo_mirror_claim"})).unwrap();
    assert_eq!(third["retirement"]["state"], "switched");
    job(
        &h,
        json!({"op":"repo_mirror_retired","epoch":third["epoch"]}),
    )
    .unwrap();
    assert_eq!(record(&h)["mirror"]["state"], "retired");
}

#[test]
fn only_the_repositorys_own_artifacts_mirror_is_retired() {
    // A store with no Artifacts mirror purges as before.
    let (h, _) = seeded();
    h.db.query("UPDATE repo_settings SET object_store='r2:demo'", &[])
        .unwrap();
    let (_, done) = purge(&h, "pub fn a() {}\n");
    assert_eq!(done["mirror"], false);
    assert_eq!(record(&h)["mirror"], Value::Null);
    assert_eq!(record(&h)["records"][0]["mirror"], Value::Null);

    // A fork retires its own mirror and keeps inheriting from its parent's store.
    let (h, _) = seeded();
    let fork = r#"fork:{"own":"artifacts:test/yr-fork","parent":"r0123456789abcdef0124","store":"artifacts:test/yr-parent"}"#;
    h.db.query("UPDATE repo_settings SET object_store=?", &[json!(fork)])
        .unwrap();
    purge(&h, "pub fn a() {}\n");
    let claim = job(&h, json!({"op":"repo_mirror_claim"})).unwrap();
    assert_eq!(claim["retirement"]["mirror"], "artifacts:test/yr-fork");
    job(
        &h,
        json!({"op":"repo_mirror_switch","epoch":claim["epoch"]}),
    )
    .unwrap();
    let spec: Value = serde_json::from_str(store(&h).strip_prefix("fork:").unwrap()).unwrap();
    assert_eq!(
        spec,
        json!({"own": REPLACEMENT, "parent": "r0123456789abcdef0124", "store": "artifacts:test/yr-parent"})
    );
}

#[test]
fn a_purge_names_a_valid_replacement() {
    let (h, _) = seeded();
    let blob = hash_object(ObjectKind::Blob, b"pub fn a() {}\n").hex();
    let id = h.ok(
        OWNER,
        json!({"op":"repo_quarantine","target":{"kind":"blob","id":blob},"reason":"leaked"}),
    )["record"]["id"]
        .clone();
    let claimed = h.ok(
        OWNER,
        json!({"op":"repo_quarantine_purge","id":id,"confirm":blob}),
    );
    let claims = json!([{"id": id, "epoch": claimed["claims"][0]["epoch"]}]);
    for replacement in [
        json!(null),
        json!("artifacts:test/other"),
        json!("platform:../x"),
    ] {
        assert_eq!(
            code(h.run(
                OWNER,
                json!({"op":"repo_quarantine_purged","claims":claims,"replacement":replacement})
            )),
            "INVALID_INPUT",
            "{replacement}"
        );
    }
    // Refused whole: the record is still quarantined.
    assert_eq!(record(&h)["records"][0]["state"], "quarantined");
}

#[test]
fn the_retirement_tables_arrive_by_a_repeatable_forward_migration() {
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    let preceding = migrations.iter().position(|(v, _)| *v == 43).unwrap();
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..preceding])
        .unwrap();
    db.query(
        "INSERT INTO quarantine(target_kind,target_id,state,reason,actor,at,purge_after) \
         VALUES('blob','b','purged','r','p',1,1)",
        &[],
    )
    .unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    let kept = db
        .query("SELECT state,mirror FROM quarantine", &[])
        .unwrap();
    assert_eq!(kept, vec![json!({"state": "purged", "mirror": null})]);
    assert!(
        db.query("SELECT * FROM mirror_retirement", &[])
            .unwrap()
            .is_empty()
    );
    assert!(
        db.query("SELECT * FROM mirror_copied", &[])
            .unwrap()
            .is_empty()
    );
    // Fresh: the whole chain at once.
    let fresh = crate::native::NativeStore::memory().unwrap();
    super::super::migrate_repo_store(&fresh).unwrap();
    assert!(
        fresh
            .query("SELECT mirror FROM quarantine", &[])
            .unwrap()
            .is_empty()
    );
}
