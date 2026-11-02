//! A clone's refs arrive whole: the importer records its commits as a push does, lands the
//! default branch and creates everything else as it stood on the remote.
use super::*;
use crate::repo_store::tests::pushed::{pushed, record};
use crate::storage::SqlStore;
use yoneda_core::git_object::{
    AnnotatedTag, ObjectId, ObjectKind, Signature, TzOffset, hash_object,
};

const IMPORTER: &str = "platform:import";

fn who() -> Signature {
    Signature {
        name: "Dev".into(),
        email: "dev@example.com".into(),
        seconds: 1_700_000_000,
        offset: TzOffset::UTC,
    }
}

/// An empty repository holding three commits: `root`, `main` on it, and `side` on the root.
fn cloned() -> (Harness, String, String, String) {
    let h = Harness::new();
    let tree = ObjectId::parse(&"2".repeat(40)).unwrap();
    let commit = Commit::new(tree, &[], &who(), &who(), "root").unwrap();
    let root = commit.id().hex();
    let first = json!({ "commit": root, "data_b64": STANDARD.encode(commit.encode()), "touches": [],
                        "objects": [{ "id": root, "kind": "commit" }] });
    let (main, on_main) = pushed(&root, &tree.hex(), "on main");
    let (side, on_side) = pushed(&root, &tree.hex(), "on the side");
    assert_eq!(
        record(&h, IMPORTER, json!([first, on_main, on_side])).unwrap()["recorded"],
        3
    );
    (h, root, main, side)
}

#[test]
fn a_clone_lands_its_default_branch_with_a_parent_and_creates_every_other_ref() {
    let (h, root, main, side) = cloned();
    h.ok(
        IMPORTER,
        json!({"op":"repo_import","ref":"main","commit":main,"pack_bytes":1000}),
    );
    let tag = AnnotatedTag::new(ObjectId::parse(&side).unwrap(), "v1", who(), "a tag").unwrap();
    let data = tag.encode().unwrap();
    let updates = json!([
        {"ref":"refs/heads/side","commit":side},
        {"ref":"refs/heads/release/1.x","commit":root},
        {"ref":"refs/tags/light","commit":root},
        {"ref":"refs/tags/v1","commit":side,"tag":{"data_b64":STANDARD.encode(&data)}},
    ]);
    let command = json!({"op":"repo_import_refs","updates":updates});
    h.ok(IMPORTER, command.clone());
    let refs = h.ok(OWNER, json!({"op":"repo_refs"}))["refs"].clone();
    assert_eq!(refs["refs/heads/main"], main.as_str());
    assert_eq!(refs["refs/heads/side"], side.as_str());
    assert_eq!(refs["refs/heads/release/1.x"], root.as_str());
    assert_eq!(refs["refs/tags/light"], root.as_str());
    assert_eq!(refs["refs/tags/v1"], side.as_str());
    let log = h.ok(OWNER, json!({"op":"repo_log","ref":"main"}));
    assert_eq!(log["commits"].as_array().unwrap().len(), 2, "{log}");
    // A retry finds them made.
    h.ok(IMPORTER, command);
    assert_eq!(h.ok(OWNER, json!({"op":"repo_refs"}))["refs"], refs);
    let id = hash_object(ObjectKind::Tag, &data).hex();
    let tags =
        h.db.query("SELECT refname,tag_id FROM annotated_tags", &[])
            .unwrap();
    assert_eq!(tags, vec![json!({"refname":"refs/tags/v1","tag_id":id})]);
}

#[test]
fn nobody_but_the_importer_sets_imported_refs_or_lands_a_commit_with_parents() {
    let (h, root, main, _) = cloned();
    let update = json!({"op":"repo_import_refs","updates":[{"ref":"refs/heads/x","commit":root}]});
    assert_eq!(code(h.run(OWNER, update)), "FORBIDDEN");
    let land = json!({"op":"repo_import","ref":"main","commit":main});
    assert_eq!(code(h.run(OWNER, land)), "INVALID_INPUT");
}

#[test]
fn a_ref_that_already_stands_elsewhere_is_not_moved() {
    let (h, root, main, side) = cloned();
    let set = |commit: &str| {
        h.run(
            IMPORTER,
            json!({"op":"repo_import_refs","updates":[{"ref":"refs/heads/b","commit":commit}]}),
        )
    };
    h.ok(
        IMPORTER,
        json!({"op":"repo_import","ref":"main","commit":main}),
    );
    set(&root).unwrap();
    assert_eq!(code(set(&side)), "ALREADY_EXISTS");
}
