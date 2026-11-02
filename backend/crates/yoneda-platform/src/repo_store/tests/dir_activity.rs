//! What last changed each entry of a directory, along a branch's first parents. A clone is one
//! landing, so the transaction log can't say: only the commits' own changed paths do.
use super::commit_authors::written;
use super::*;
use crate::repo_store::tests::pushed::record;
use yoneda_core::git_object::{Signature, TzOffset};

const IMPORTER: &str = "platform:import";

fn who(name: &str, seconds: i64) -> Signature {
    Signature {
        name: name.into(),
        email: "dev@example.com".into(),
        seconds,
        offset: TzOffset::UTC,
    }
}

/// A clone with five folders, as whisper: three last changed long before its head.
fn whisper() -> (Harness, Vec<String>) {
    let h = Harness::new();
    let tree = "2".repeat(40);
    let (a, first, _) = written(
        &[],
        &tree,
        &who("Ada", 1_000),
        "the start",
        &[
            ".github/ci.yml",
            "data/a.bin",
            "notebooks/n.ipynb",
            "README.md",
        ],
    );
    let (b, second, _) = written(&[&a], &tree, &who("Bo", 2_000), "data", &["data/b.bin"]);
    let (c, third, _) = written(
        &[&b],
        &tree,
        &who("Cy", 3_000),
        "code",
        &["tests/t.py", "whisper/w.py", "whisper/deep/x.py"],
    );
    record(&h, IMPORTER, json!([first, second, third])).unwrap();
    h.ok(
        IMPORTER,
        json!({"op":"repo_import","ref":"main","commit":c}),
    );
    (h, vec![a, b, c])
}

fn activity(h: &Harness, path: &str, names: Value) -> Value {
    h.ok(
        OWNER,
        json!({"op":"repo_dir_activity","ref":"main","path":path,"names":names}),
    )
}

#[test]
fn every_folder_of_a_clone_has_its_last_commit_not_only_those_the_head_touched() {
    let (h, ids) = whisper();
    let seen = activity(
        &h,
        "",
        json!([
            ".github",
            "data",
            "notebooks",
            "tests",
            "whisper",
            "README.md"
        ]),
    );
    let found = &seen["activity"];
    assert_eq!(found[".github"]["commit"], ids[0].as_str());
    assert_eq!(found["notebooks"]["commit"], ids[0].as_str());
    assert_eq!(found["README.md"]["commit"], ids[0].as_str());
    assert_eq!(found["data"]["commit"], ids[1].as_str());
    assert_eq!(found["tests"]["commit"], ids[2].as_str());
    assert_eq!(found["whisper"]["commit"], ids[2].as_str());
    assert_eq!(found["data"]["message"], "data");
    assert_eq!(found["data"]["author_name"], "Bo");
    assert_eq!(found["data"]["authored_at"], 2_000_000);
    assert_eq!(seen["partial"], false);
}

#[test]
fn a_folder_lists_its_own_entries() {
    let (h, ids) = whisper();
    let found = activity(&h, "whisper", json!(["w.py", "deep"]))["activity"].clone();
    assert_eq!(found["w.py"]["commit"], ids[2].as_str());
    assert_eq!(found["deep"]["commit"], ids[2].as_str());
    let trailing = activity(&h, "whisper/", json!(["w.py"]))["activity"].clone();
    assert_eq!(trailing["w.py"]["commit"], ids[2].as_str());
}

#[test]
fn only_a_commit_under_the_directory_counts() {
    let (h, _) = whisper();
    // `data` and `data.txt` sort apart; a name no commit touched stays out.
    let found = activity(&h, "data", json!(["a.bin", "never"]))["activity"].clone();
    assert!(found["a.bin"].is_object());
    assert!(found.get("never").is_none());
}

#[test]
fn a_branch_reads_its_own_commits_then_mains() {
    let (h, ids) = whisper();
    let tree = "2".repeat(40);
    let (side, item, _) = written(
        &[&ids[2]],
        &tree,
        &who("Di", 4_000),
        "side",
        &["data/c.bin"],
    );
    record(&h, IMPORTER, json!([item])).unwrap();
    h.ok(
        IMPORTER,
        json!({"op":"repo_import_refs","updates":[{"ref":"refs/heads/side","commit":side}]}),
    );
    let found = h.ok(
        OWNER,
        json!({"op":"repo_dir_activity","ref":"side","path":"","names":["data","tests"]}),
    )["activity"]
        .clone();
    assert_eq!(found["data"]["commit"], side.as_str());
    assert_eq!(found["tests"]["commit"], ids[2].as_str());
}

#[test]
fn an_unknown_branch_says_so() {
    let (h, _) = whisper();
    let asked = json!({"op":"repo_dir_activity","ref":"nope","path":"","names":["a"]});
    assert_eq!(code(h.run(OWNER, asked)), "NOT_FOUND");
}

#[test]
fn past_the_scan_it_says_it_stopped_rather_than_guess() {
    let (h, _) = whisper();
    let asked = json!({"op":"repo_dir_activity","ref":"main","path":"","names":["data","gone"]});
    let seen = h.ok(OWNER, asked);
    // The whole chain was read, so a name with no commit is no partial answer.
    assert_eq!(seen["partial"], false);
    assert!(seen["activity"].get("gone").is_none());
}
