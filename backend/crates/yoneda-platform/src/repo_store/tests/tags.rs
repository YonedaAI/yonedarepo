//! Lightweight tags: created once at a recorded commit (expected old is null), logged as a
//! ref move, and never moved or deleted.
use super::*;

fn tag(h: &Harness, who: &str, name: &str, commit: &str) -> yoneda_core::Result<Value> {
    h.run(
        who,
        json!({"op":"repo_tag_create","name":name,"commit":commit}),
    )
}

#[test]
fn tags_are_created_once_and_logged() {
    let (h, root) = seeded();
    let child = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("b.txt", "b\n")]),
            json!([]),
        )
        .unwrap();
    let made = tag(&h, OWNER, "v1", &root).unwrap();
    assert_eq!(made["ref"], "refs/tags/v1");
    let version = made["version"].as_u64().unwrap();
    let refs = h.ok(OWNER, json!({"op":"repo_refs"}));
    assert_eq!(refs["refs"]["refs/tags/v1"], json!(root));
    let entry = &h.ok(
        OWNER,
        json!({"op":"repo_txlog","after":version - 1,"limit":1}),
    )["entries"][0];
    assert_eq!(entry["kind"], "ref_move");
    assert_eq!(entry["refname"], "refs/tags/v1");
    assert!(entry["old"].is_null());

    // Creating it again at the same commit is a no-op; anywhere else it is refused.
    assert_eq!(
        tag(&h, OWNER, "refs/tags/v1", &root).unwrap()["already"],
        true
    );
    assert_eq!(code(tag(&h, OWNER, "v1", &child)), "ALREADY_EXISTS");
    // Neither the branch paths nor a batch can move or delete it.
    let set = |c: Value| h.run(OWNER, c);
    assert_eq!(
        code(set(
            json!({"op":"repo_branch_set","ref":"refs/tags/v1","commit":child,"expected":root})
        )),
        "INVALID_INPUT"
    );
    for update in [
        json!({"ref":"refs/tags/v1","commit":child,"expected":root}),
        json!({"ref":"refs/tags/v1","commit":null,"expected":root}),
    ] {
        assert_eq!(
            code(set(json!({"op":"repo_branch_batch","updates":[update]}))),
            "FORBIDDEN"
        );
    }
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_refs"}))["refs"]["refs/tags/v1"],
        json!(root),
        "refusals moved nothing"
    );
    // Time travel sees the tag only from its version on.
    let before = h.ok(OWNER, json!({"op":"repo_refs","at":version - 1}));
    assert!(before["refs"].get("refs/tags/v1").is_none());
}

#[test]
fn tags_need_land_a_recorded_commit_and_a_valid_name() {
    let (h, root) = seeded();
    assert_eq!(
        code(tag(&h, AGENT, "v1", &root)),
        "FORBIDDEN",
        "write alone"
    );
    let batch = json!({"op":"repo_branch_batch","updates":[{"ref":"refs/tags/v1","commit":root,"expected":null}]});
    assert_eq!(code(h.run(AGENT, batch)), "FORBIDDEN");
    assert_eq!(code(tag(&h, OWNER, "v1", &"a".repeat(40))), "NOT_FOUND");
    for name in ["", "bad..name", "has space", ".hidden", "x.lock", "a/"] {
        assert_eq!(
            code(tag(&h, OWNER, name, &root)),
            "INVALID_INPUT",
            "{name:?}"
        );
    }
}

#[test]
fn a_batch_creates_a_tag_and_moves_a_branch_together() {
    let (h, root) = seeded();
    let moved = h.ok(
        OWNER,
        json!({"op":"repo_branch_batch","updates":[
            {"ref":"refs/heads/release-prep","commit":root,"expected":null},
            {"ref":"refs/tags/v2","commit":root,"expected":null}
        ]}),
    );
    assert_eq!(moved["refs"].as_array().unwrap().len(), 2);
    let refs = &h.ok(OWNER, json!({"op":"repo_refs"}))["refs"];
    assert_eq!(refs["refs/tags/v2"], json!(root));
    assert_eq!(refs["refs/heads/release-prep"], json!(root));
}

#[test]
fn tag_reads_select_the_recorded_snapshot_and_verify_past_versions() {
    let (h, root) = seeded();
    let made = tag(&h, OWNER, "v1", &root).unwrap();
    let version = made["version"].as_u64().unwrap();
    for at in [None, Some(version)] {
        let mut snapshot = json!({"op":"repo_snapshot","ref":"refs/tags/v1"});
        if let Some(at) = at {
            snapshot["at"] = json!(at);
        }
        let shown = h.ok(AGENT, snapshot);
        assert_eq!(shown["commit"], root);
        let mut log = json!({"op":"repo_log","ref":"refs/tags/v1","limit":200});
        if let Some(at) = at {
            log["at"] = json!(at);
        }
        assert_eq!(h.ok(AGENT, log)["commits"][0]["commit"], root);
    }
    assert_eq!(
        h.ok(
            AGENT,
            json!({"op":"repo_commit","commit":root,"ref":"refs/tags/v1"})
        )["commit"],
        root
    );
    assert_eq!(
        code(h.run(
            AGENT,
            json!({"op":"repo_snapshot","ref":"refs/tags/v1","at":version-1})
        )),
        "NOT_FOUND"
    );
    for name in [
        "refs/tags/bad..name",
        "refs/tags/",
        "refs/remotes/origin/main",
        "refs/notes/test",
    ] {
        assert_eq!(
            code(h.run(AGENT, json!({"op":"repo_snapshot","ref":name}))),
            "INVALID_INPUT"
        );
    }
}
