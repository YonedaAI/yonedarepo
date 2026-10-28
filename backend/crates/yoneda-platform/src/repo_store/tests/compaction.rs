//! Log compaction: whole segments of old versions move to the object store (played here by
//! a map), the SQL tail stays bounded, and reads at old versions answer from the segments.
use super::*;
use crate::storage::SqlStore;
use std::collections::BTreeMap;

/// Plays R2: object key → body.
pub(super) type Store = RefCell<BTreeMap<String, String>>;

/// Main at `root` (version 1), then 100 branches moved in batches of 100 until `head`.
fn grown(head: u64) -> (Harness, String, String) {
    let (h, root) = seeded();
    let child = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("n.txt", "1\n")]),
            json!([]),
        )
        .unwrap();
    grow(&h, &root, &child, head);
    (h, root, child)
}

/// Moves branches `b0`..`b99` between `root` and `child`, 100 per batch, until `head`.
pub(super) fn grow(h: &Harness, root: &str, child: &str, head: u64) {
    let mut at: Vec<Option<String>> = vec![None; 100];
    let mut version = h.ok(OWNER, json!({"op":"repo_status"}))["version"]
        .as_u64()
        .unwrap();
    while version < head {
        let take = (head - version).min(100) as usize;
        let updates: Vec<Value> = (0..take)
            .map(|i| {
                let next = if at[i].as_deref() == Some(root) {
                    child
                } else {
                    root
                };
                let update = json!({"ref": format!("b{i}"), "commit": next, "expected": at[i]});
                at[i] = Some(next.to_owned());
                update
            })
            .collect();
        version = h.ok(AGENT, json!({"op":"repo_branch_batch","updates":updates}))["version"]
            .as_u64()
            .unwrap();
    }
}

fn rows(h: &Harness, sql: &str) -> u64 {
    h.db.query(sql, &[]).unwrap()[0]["n"].as_u64().unwrap()
}

/// The adapter's job: plan, write both objects, read them back, then settle.
pub(super) fn compact_once(h: &Harness, r2: &Store, extra: Value) -> Value {
    let mut plan = json!({"op":"repo_compact_plan"});
    let mut done = json!({"op":"repo_compact_done"});
    for (k, v) in extra.as_object().unwrap() {
        plan[k] = v.clone();
        done[k] = v.clone();
    }
    let planned = h.ok(OWNER, plan);
    if planned["due"] != true {
        return planned;
    }
    for object in ["segment", "checkpoints"] {
        let sealed = &planned[object];
        r2.borrow_mut().insert(
            sealed["key"].as_str().unwrap().into(),
            sealed["body"].as_str().unwrap().into(),
        );
        assert_eq!(
            r2.borrow()[sealed["key"].as_str().unwrap()],
            sealed["body"].as_str().unwrap()
        );
    }
    for key in ["start", "end"] {
        done[key] = planned[key].clone();
    }
    done["segment_digest"] = planned["segment"]["digest"].clone();
    done["checkpoints_digest"] = planned["checkpoints"]["digest"].clone();
    h.ok(OWNER, done)
}

/// A read, retried once with the archived objects the authority names (as the adapter does).
fn read(h: &Harness, r2: &Store, command: Value) -> yoneda_core::Result<Value> {
    run_archived(h, OWNER, r2, command)
}

/// Runs `command`; on `TXLOG_ARCHIVED`, once more carrying every object it names (null for
/// one the store lacks), as the adapter does.
pub(super) fn run_archived(
    h: &Harness,
    principal: &str,
    r2: &Store,
    command: Value,
) -> yoneda_core::Result<Value> {
    match h.run(principal, command.clone()) {
        Err(e) if e.code == "TXLOG_ARCHIVED" => {
            let mut objects = serde_json::Map::new();
            for (at, _) in e.message.match_indices("_log/") {
                let key = &e.message[at..at + e.message[at..].find(".json").unwrap() + 5];
                objects.insert(key.into(), json!(r2.borrow().get(key)));
            }
            assert!(!objects.is_empty(), "names its objects: {e}");
            let mut command = command;
            command["_archive"] = json!(objects);
            h.run(principal, command)
        }
        other => other,
    }
}

fn refs_at(h: &Harness, r2: &Store, version: u64) -> Value {
    read(h, r2, json!({"op":"repo_refs","at":version})).unwrap()["refs"].clone()
}

#[test]
fn compaction_keeps_the_bound_and_old_versions_answer_from_segments() {
    let (h, _, _) = grown(2_200);
    let r2 = Store::default();
    let before: Vec<(u64, Value)> = [0, 5, 64, 700, 1_024, 1_100, 2_048, 2_100]
        .into_iter()
        .map(|v| (v, refs_at(&h, &r2, v)))
        .collect();
    let log5 = h.ok(OWNER, json!({"op":"repo_log","ref":"b3","at":5}));
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_compact_plan"}))["due"],
        false,
        "defaults keep 10,000 versions"
    );

    h.ok(
        OWNER,
        json!({"op":"repo_set_retention","keep_versions":100,"keep_days":30}),
    );
    assert_eq!(compact_once(&h, &r2, json!({}))["floor"], 1_024);
    assert_eq!(compact_once(&h, &r2, json!({}))["floor"], 2_048);
    let idle = compact_once(&h, &r2, json!({}));
    assert_eq!(
        [&idle["due"], &idle["floor"], &idle["tail_rows"]],
        [&json!(false), &json!(2_048), &json!(152)]
    );
    assert_eq!(r2.borrow().len(), 4);

    assert_eq!(rows(&h, "SELECT COUNT(*) AS n FROM txlog"), 2_200 - 2_048);
    assert_eq!(
        rows(
            &h,
            "SELECT COUNT(*) AS n FROM txlog_checkpoints WHERE version<=2048"
        ),
        0
    );
    assert_eq!(
        rows(
            &h,
            "SELECT COUNT(*) AS n FROM txlog_paths WHERE version<=2048"
        ),
        0
    );
    assert_eq!(h.ok(OWNER, json!({"op":"repo_status"}))["version"], 2_200);

    // The tail replays from the anchor; older versions need their segment, then agree.
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_refs","at":2_100}))),
        "OK"
    );
    let archived = h.run(OWNER, json!({"op":"repo_refs","at":5})).unwrap_err();
    assert_eq!(archived.code, "TXLOG_ARCHIVED");
    assert!(
        archived
            .message
            .contains("_log/segment-00000000000000000000-00000000000000001024.json"),
        "{archived}"
    );
    for (version, refs) in &before {
        assert_eq!(&refs_at(&h, &r2, *version), refs, "refs at {version}");
    }
    assert_eq!(
        read(&h, &r2, json!({"op":"repo_log","ref":"b3","at":5})).unwrap(),
        log5
    );
    assert_eq!(
        read(&h, &r2, json!({"op":"repo_snapshot","ref":"b3","at":1_500})).unwrap()["version"],
        1_500
    );

    // The log listing pages through archived versions a segment at a time.
    let page = read(
        &h,
        &r2,
        json!({"op":"repo_txlog","after":1_000,"limit":500}),
    )
    .unwrap();
    let versions: Vec<u64> = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["version"].as_u64().unwrap())
        .collect();
    assert_eq!(
        (versions[0], *versions.last().unwrap(), versions.len()),
        (1_001, 1_024, 24)
    );
    let page = read(&h, &r2, json!({"op":"repo_txlog","after":2_040,"limit":20})).unwrap();
    assert_eq!(page["entries"].as_array().unwrap().len(), 8);

    // A stream reading behind the floor (a change-log range given back) asks for the
    // segments, then reads them: nothing is skipped.
    let records = json!({"op":"repo_change_records","after_version":1_020});
    assert_eq!(
        code(h.run("platform:derive", records.clone())),
        "TXLOG_ARCHIVED"
    );
    let page = run_archived(&h, "platform:derive", &r2, records).unwrap();
    assert_eq!(page["version"], 1_120);
    let first = &page["records"][0];
    assert_eq!(first["version"], 1_021, "{first}");
}

#[test]
fn a_corrupt_or_foreign_segment_is_refused() {
    let (h, _, _) = grown(1_200);
    let r2 = Store::default();
    h.ok(
        OWNER,
        json!({"op":"repo_set_retention","keep_versions":100,"keep_days":30}),
    );
    compact_once(&h, &r2, json!({}));
    let key = "_log/segment-00000000000000000000-00000000000000001024.json";
    let good = r2.borrow()[key].clone();
    // An edited ref inside an entry, still valid JSON.
    let entry = good.find("\"new\":\"").unwrap() + 7;
    let mut bad = good.clone();
    bad.replace_range(
        entry..entry + 1,
        if &good[entry..entry + 1] == "0" {
            "1"
        } else {
            "0"
        },
    );
    r2.borrow_mut().insert(key.into(), bad);
    assert_eq!(
        code(read(&h, &r2, json!({"op":"repo_refs","at":5}))),
        "ARCHIVE_CORRUPT"
    );
    r2.borrow_mut().insert(key.into(), "{}".into());
    assert_eq!(
        code(read(&h, &r2, json!({"op":"repo_refs","at":5}))),
        "ARCHIVE_CORRUPT"
    );
    r2.borrow_mut().remove(key);
    assert_eq!(
        code(read(&h, &r2, json!({"op":"repo_refs","at":5}))),
        "ARCHIVE_CORRUPT"
    );
    r2.borrow_mut().insert(key.into(), good);
    assert_eq!(code(read(&h, &r2, json!({"op":"repo_refs","at":5}))), "OK");

    // The anchor the retained tail replays from is checked against its digest as well.
    let at_tail = json!({"op":"repo_refs","at":1_050});
    assert_eq!(code(h.run(OWNER, at_tail.clone())), "OK");
    h.db.query("UPDATE txlog_anchor SET checkpoint=replace(checkpoint,'refs/heads/b1\"','refs/heads/bX\"')", &[]).unwrap();
    assert_eq!(code(h.run(OWNER, at_tail)), "TXLOG_INVALID");
}

#[test]
fn a_crash_between_the_store_write_and_the_row_delete_reruns_to_the_same_result() {
    let (h, _, _) = grown(1_200);
    h.ok(
        OWNER,
        json!({"op":"repo_set_retention","keep_versions":100,"keep_days":30}),
    );
    let first = h.ok(OWNER, json!({"op":"repo_compact_plan"}));
    // The objects were written, then the job died before settling: nothing moved yet.
    assert_eq!(rows(&h, "SELECT COUNT(*) AS n FROM txlog"), 1_200);
    let again = h.ok(OWNER, json!({"op":"repo_compact_plan"}));
    for object in ["segment", "checkpoints"] {
        assert_eq!(
            first[object], again[object],
            "a rerun writes the same {object}"
        );
    }
    let settle = json!({"op":"repo_compact_done","start":0,"end":1_024,
        "segment_digest":first["segment"]["digest"],"checkpoints_digest":first["checkpoints"]["digest"]});
    assert_eq!(h.ok(OWNER, settle.clone())["compacted"], true);
    // The answer was lost and the job settles again: no second move, same rows.
    let replay = h.ok(OWNER, settle.clone());
    assert_eq!(
        [&replay["compacted"], &replay["floor"]],
        [&json!(false), &json!(1_024)]
    );
    assert_eq!(rows(&h, "SELECT COUNT(*) AS n FROM txlog"), 1_200 - 1_024);
    assert_eq!(rows(&h, "SELECT COUNT(*) AS n FROM txlog_segments"), 1);

    // A settle naming other content, or a run that is not next, moves nothing.
    let mut wrong = settle.clone();
    wrong["segment_digest"] = json!("0".repeat(64));
    assert_eq!(code(h.run(OWNER, wrong)), "CONFLICT");
    let skip = json!({"op":"repo_compact_done","start":2_048,"end":3_072,"segment_digest":"x","checkpoints_digest":"y"});
    assert_eq!(code(h.run(OWNER, skip)), "CONFLICT");
}

#[test]
fn compaction_waits_for_held_cursors_and_is_the_owners_or_the_platforms() {
    let (h, _, _) = grown(1_200);
    let r2 = Store::default();
    h.ok(
        OWNER,
        json!({"op":"repo_set_retention","keep_versions":100,"keep_days":30}),
    );
    // A consumer still reading after version 500 (the change-log cursor) holds the run.
    assert_eq!(compact_once(&h, &r2, json!({"hold": 500}))["due"], false);
    assert_eq!(
        compact_once(&h, &r2, json!({"hold": 1_024}))["floor"],
        1_024
    );

    assert_eq!(
        code(h.run(AGENT, json!({"op":"repo_compact_plan"}))),
        "FORBIDDEN"
    );
    assert_eq!(
        code(h.run(
            AGENT,
            json!({"op":"repo_set_retention","keep_versions":100})
        )),
        "FORBIDDEN"
    );
    for bad in [
        json!({"keep_versions":0}),
        json!({"keep_days":0}),
        json!({"keep_versions":"x"}),
    ] {
        let mut c = bad;
        c["op"] = json!("repo_set_retention");
        assert_eq!(code(h.run(OWNER, c)), "INVALID_INPUT");
    }
    let mut platform = json!({"op":"repo_compact_plan"});
    platform["_system"] = json!("compact");
    assert_eq!(
        code(execute_repo_store(&h.db, {
            platform["now"] = json!(1_800_000_000_000_i64);
            platform
        })),
        "OK"
    );
}

#[test]
fn old_entries_leave_by_age_as_well_as_by_count() {
    let (h, _, _) = grown(1_100);
    let r2 = Store::default();
    // 1,100 versions, all younger than 30 days: the default bound keeps them.
    assert_eq!(compact_once(&h, &r2, json!({}))["due"], false);
    *h.now.borrow_mut() += 31 * 24 * 60 * 60 * 1000;
    assert_eq!(compact_once(&h, &r2, json!({}))["floor"], 1_024);
}

#[test]
fn upgrades_from_the_changes_schema_with_no_segments() {
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..28])
        .unwrap();
    db.query(
        "INSERT INTO txlog(version,refname,entry,chain) VALUES(1,'refs/heads/main','{}','c')",
        &[],
    )
    .unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    assert!(
        db.query("SELECT start_version FROM txlog_segments", &[])
            .unwrap()
            .is_empty()
    );
    assert!(
        db.query("SELECT version FROM txlog_anchor", &[])
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        db.query("SELECT COUNT(*) AS n FROM txlog", &[]).unwrap()[0]["n"],
        1
    );
}
