use super::*;

fn grown(head: u64) -> Harness {
    let (h, root) = seeded();
    let child = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("next.txt", "next\n")]),
            json!([]),
        )
        .unwrap();
    super::compaction::grow(&h, &root, &child, head);
    h
}

#[test]
fn recent_versions_include_the_newest_entries_beyond_five_hundred() {
    let h = grown(503);
    let page = h.ok(OWNER, json!({"op":"repo_txlog","recent":true,"limit":50}));
    assert_eq!(page["entries"][0]["version"], 503);
    assert_eq!(page["entries"][49]["version"], 454);
    assert_eq!(page["next_before"], 454);
    assert_eq!(page["version"], 503);
    let legacy = h.ok(OWNER, json!({"op":"repo_txlog","after":500,"limit":3}));
    assert_eq!(legacy["entries"][0]["version"], 501);
    assert_eq!(legacy["entries"][2]["version"], 503);
}

#[test]
fn older_pages_stay_pinned_while_new_versions_arrive_and_choices_are_compact() {
    let h = grown(503);
    let first = h.ok(
        OWNER,
        json!({"op":"repo_txlog","recent":true,"compact":true}),
    );
    assert_eq!(first["entries"][0].as_object().unwrap().len(), 3);
    assert!(first.to_string().len() < 8_192);
    let root = h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}))["commit"].clone();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"after-page","commit":root,"expected":null}),
    );
    let older = h.ok(
        OWNER,
        json!({"op":"repo_txlog","recent":true,"through":503,
        "history_chain":first["history_chain"],"before":454}),
    );
    assert_eq!(older["version"], 503);
    assert_eq!(older["entries"][0]["version"], 453);
    assert_eq!(older["entries"][49]["version"], 404);
    assert_eq!(older["next_before"], 404);
}

#[test]
fn cursors_reject_reused_history_and_corrupted_rows() {
    use crate::storage::SqlStore;
    let h = grown(503);
    let first = h.ok(OWNER, json!({"op":"repo_txlog","recent":true}));
    let cursor = json!({"op":"repo_txlog","recent":true,"through":503,
        "history_chain":first["history_chain"],"before":454});
    h.db.query("UPDATE txlog SET chain='replaced' WHERE version=503", &[])
        .unwrap();
    assert_eq!(code(h.run(OWNER, cursor)), "ACTIVITY_CHANGED");
    h.db.query(
        "UPDATE txlog SET chain=? WHERE version=503",
        &[first["history_chain"].clone()],
    )
    .unwrap();
    h.db.query(
        "UPDATE txlog SET entry=json_set(entry,'$.actor','user:forged') WHERE version=500",
        &[],
    )
    .unwrap();
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_txlog","recent":true}))),
        "TXLOG_INVALID"
    );
}

#[test]
fn archived_pages_cross_the_floor_without_losing_the_last_versions() {
    let h = grown(1_300);
    let r2 = super::compaction::Store::default();
    h.ok(
        OWNER,
        json!({"op":"repo_set_retention","keep_versions":64,"keep_days":30}),
    );
    let first = h.ok(OWNER, json!({"op":"repo_txlog","recent":true}));
    assert_eq!(
        super::compaction::compact_once(&h, &r2, json!({}))["floor"],
        1_024
    );
    let tail = h.ok(
        OWNER,
        json!({"op":"repo_txlog","recent":true,"through":1300,
        "history_chain":first["history_chain"],"before":1051}),
    );
    assert_eq!(tail["entries"].as_array().unwrap().len(), 26);
    assert_eq!(tail["next_before"], 1025);
    let old = super::compaction::run_archived(
        &h,
        OWNER,
        &r2,
        json!({"op":"repo_txlog","recent":true,
        "through":1300,"history_chain":first["history_chain"],"before":1025}),
    )
    .unwrap();
    assert_eq!(old["entries"][0]["version"], 1024);
    assert_eq!(old["entries"][49]["version"], 975);
}

#[test]
fn empty_and_invalid_ranges_are_explicit() {
    let h = Harness::new();
    let page = h.ok(OWNER, json!({"op":"repo_txlog","recent":true}));
    assert_eq!(page["history_chain"], Value::Null);
    assert_eq!(page["entries"], json!([]));
    for patch in [
        json!({"before":0}),
        json!({"before":1}),
        json!({"limit":-1}),
        json!({"through":1}),
    ] {
        let mut c = json!({"op":"repo_txlog","recent":true});
        c.as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        assert!(h.run(OWNER, c).is_err());
    }
}

#[test]
fn a_reset_reusing_the_same_main_commit_and_version_refuses_its_old_cursor() {
    let h = grown(503);
    let first = h.ok(OWNER, json!({"op":"repo_txlog","recent":true}));
    let root = h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}))["commit"]
        .as_str()
        .unwrap()
        .to_owned();
    let bytes = h.read_object(&root);
    while h.ok("platform:import", json!({"op":"repo_import_reset"}))["done"] != true {}
    h.ok("platform:import",json!({"op":"repo_record_pushed","commits":[{"commit":root,"data_b64":STANDARD.encode(bytes),"touches":[],"objects":[{"id":root,"kind":"commit"}]}]}));
    h.ok(
        "platform:import",
        json!({"op":"repo_import","ref":"main","commit":root}),
    );
    let child = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("again.txt", "again\n")]),
            json!([]),
        )
        .unwrap();
    super::compaction::grow(&h, &root, &child, 503);
    assert_eq!(h.ok(OWNER, json!({"op":"repo_status"}))["version"], 503);
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_txlog","recent":true,"through":503,
        "history_chain":first["history_chain"],"before":454})
        )),
        "ACTIVITY_CHANGED"
    );
}
