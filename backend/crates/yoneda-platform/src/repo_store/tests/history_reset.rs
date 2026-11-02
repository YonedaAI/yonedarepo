//! A re-import empties a repository's history and keeps the repository: its name, members,
//! tokens, hooks, sessions and what it withholds. What it empties a clone fills again.
use super::*;
use crate::repo_store::tests::pushed::pushed;
use crate::storage::SqlStore;

const IMPORTER: &str = "platform:import";

fn opened() -> (Harness, String) {
    let (h, root) = seeded();
    (h, root)
}

fn reset(h: &Harness) -> Value {
    let mut first = None;
    loop {
        let step = h.ok(IMPORTER, json!({"op":"repo_import_reset"}));
        first.get_or_insert(step.clone());
        if step["done"] == true {
            return first.unwrap();
        }
    }
}

fn count(h: &Harness, table: &str) -> u64 {
    h.db.query(&format!("SELECT COUNT(*) AS n FROM {table}"), &[])
        .unwrap()[0]["n"]
        .as_u64()
        .unwrap()
}

#[test]
fn a_reset_empties_history_and_keeps_the_repository() {
    let (h, root) = opened();
    h.ok(
        OWNER,
        json!({"op":"repo_tag_create","name":"v1","commit":root}),
    );
    let name = h.ok(OWNER, json!({"op":"repo_status"}))["name"].clone();
    let members = count(&h, "members");
    let tokens = count(&h, "tokens");
    assert!(count(&h, "commits") > 0);
    let first = reset(&h);
    assert!(
        first["refs"].to_string().contains("refs/heads/main"),
        "{first}"
    );
    for table in [
        "refs",
        "commits",
        "commit_paths",
        "txlog",
        "landings",
        "ref_chain",
    ] {
        assert_eq!(count(&h, table), 0, "{table}");
    }
    assert_eq!(count(&h, "members"), members);
    assert_eq!(count(&h, "tokens"), tokens);
    let status = h.ok(OWNER, json!({"op":"repo_status"}));
    assert_eq!(status["name"], name);
    assert_eq!(status["refs"], json!([]));
    assert_eq!(status["version"], 0);
}

#[test]
fn a_reset_repository_takes_a_clone_again_under_the_same_ids() {
    let (h, root) = opened();
    let tree = h.ok(
        OWNER,
        json!({"op":"repo_commit","commit":root,"brief":true}),
    )["tree"]
        .as_str()
        .unwrap()
        .to_owned();
    let (next, item) = pushed(&root, &tree, "next");
    h.ok(AGENT, json!({"op":"repo_record_pushed","commits":[item]}));
    reset(&h);
    assert_eq!(count(&h, "commits"), 0);
    // The same commit can be recorded again, with no parent to lean on any more.
    let who = yoneda_core::git_object::Signature {
        name: "Dev".into(),
        email: "dev@example.com".into(),
        seconds: 1_700_000_000,
        offset: yoneda_core::git_object::TzOffset::UTC,
    };
    let tree_id = yoneda_core::git_object::ObjectId::parse(&tree).unwrap();
    let commit = Commit::new(tree_id, &[], &who, &who, "fresh").unwrap();
    let id = commit.id().hex();
    let fresh = json!({ "commit": id, "data_b64": STANDARD.encode(commit.encode()), "touches": [],
                        "objects": [{ "id": id, "kind": "commit" }] });
    h.ok(
        IMPORTER,
        json!({"op":"repo_record_pushed","commits":[fresh]}),
    );
    let landed = h.ok(
        IMPORTER,
        json!({"op":"repo_import","ref":"main","commit":id}),
    );
    assert_eq!(landed["version"], 1);
    assert!(next != id);
}

#[test]
fn a_reset_moves_the_repository_to_the_store_of_record() {
    let (h, _) = opened();
    h.db.query(
        "UPDATE repo_settings SET object_store='artifacts:ns/yr-r0' WHERE id='repository'",
        &[],
    )
    .unwrap();
    assert!(
        h.ok(OWNER, json!({"op":"repo_status"}))["object_store"]
            .as_str()
            .unwrap()
            .starts_with("artifacts:")
    );
    let done = loop {
        let step = h.ok(
            IMPORTER,
            json!({"op":"repo_import_reset","object_store":"platform:r0"}),
        );
        if step["done"] == true {
            break step;
        }
    };
    assert_eq!(done["done"], true);
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_status"}))["object_store"],
        "platform:r0"
    );
}

#[test]
fn nobody_but_the_importer_resets_a_repository() {
    let (h, _) = opened();
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_import_reset"}))),
        "FORBIDDEN"
    );
    assert_eq!(
        code(h.run(AGENT, json!({"op":"repo_import_reset"}))),
        "FORBIDDEN"
    );
    assert!(count(&h, "commits") > 0);
}

#[test]
fn the_audit_counts_imported_and_store_only_commits() {
    let (h, _) = opened();
    let audit = h.ok(IMPORTER, json!({"op":"repo_store_audit"}));
    assert_eq!(audit["imported_commits"], 0);
    assert!(audit["commits"].as_u64().unwrap() > 0);
    assert_eq!(audit["head"]["id"].as_str().unwrap().len(), 40);
    h.db.query("UPDATE commits SET origin='import'", &[])
        .unwrap();
    let audit = h.ok(IMPORTER, json!({"op":"repo_store_audit"}));
    assert_eq!(audit["imported_commits"], audit["commits"]);
    h.db.query("UPDATE commits SET origin='platform',hidden_ref=1", &[])
        .unwrap();
    let audit = h.ok(IMPORTER, json!({"op":"repo_store_audit"}));
    assert_eq!(audit["store_commits"], audit["commits"]);
    assert_eq!(
        code(h.run(AGENT, json!({"op":"repo_store_audit"}))),
        "FORBIDDEN"
    );
}
