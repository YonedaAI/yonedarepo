//! Who wrote a commit and when, as Git says: recorded from its bytes however it arrived, kept
//! apart from who pushed or imported it, read back by the log, the path log and a commit's page,
//! and filled in afterwards for commits recorded before this.
use super::*;
use crate::repo_store::tests::pushed::record;
use crate::storage::SqlStore;
use yoneda_core::git_object::{ObjectId, Signature, TzOffset};

const IMPORTER: &str = "platform:import";
const WRITTEN: i64 = 1_500_000_000;

fn writer(name: &str, seconds: i64) -> Signature {
    Signature {
        name: name.into(),
        email: "ada@example.com".into(),
        seconds,
        offset: TzOffset::UTC,
    }
}

/// A pushed commit by `author`, changing `paths`, and its Git bytes.
pub(super) fn written(
    parents: &[&str],
    tree: &str,
    author: &Signature,
    message: &str,
    paths: &[&str],
) -> (String, Value, String) {
    let parents: Vec<ObjectId> = parents
        .iter()
        .map(|p| ObjectId::parse(p).unwrap())
        .collect();
    let commit = Commit::new(
        ObjectId::parse(tree).unwrap(),
        &parents,
        author,
        &writer("Committer", 1_700_000_000),
        message,
    )
    .unwrap();
    let id = commit.id().hex();
    let touches: Vec<Value> = paths
        .iter()
        .map(|p| json!({"path":p,"op":"add","old_blob":null,"new_blob":"1".repeat(40)}))
        .collect();
    let data = STANDARD.encode(commit.encode());
    let item = json!({ "commit": id, "data_b64": data, "touches": touches,
                       "objects": [{ "id": id, "kind": "commit" }] });
    (id, item, data)
}

fn cloned() -> (Harness, String, String) {
    let h = Harness::new();
    let tree = "2".repeat(40);
    let (root, first, _) = written(&[], &tree, &writer("Ada", WRITTEN), "root", &["a.txt"]);
    let (main, next, _) = written(
        &[&root],
        &tree,
        &writer("Grace", WRITTEN + 60),
        "second",
        &["a.txt"],
    );
    record(&h, IMPORTER, json!([first, next])).unwrap();
    h.ok(
        IMPORTER,
        json!({"op":"repo_import","ref":"main","commit":main}),
    );
    (h, root, main)
}

#[test]
fn a_clones_log_says_who_wrote_each_commit_and_when_not_who_imported_it() {
    let (h, root, main) = cloned();
    let log = h.ok(OWNER, json!({"op":"repo_log","ref":"main"}));
    let commits = log["commits"].as_array().unwrap();
    assert_eq!(commits[0]["commit"], main.as_str());
    assert_eq!(commits[0]["author_name"], "Grace");
    assert_eq!(commits[0]["authored_at"], (WRITTEN + 60) * 1000);
    assert_eq!(commits[0]["principal"], IMPORTER);
    assert_eq!(commits[1]["commit"], root.as_str());
    assert_eq!(commits[1]["author_name"], "Ada");
    assert_eq!(commits[1]["authored_at"], WRITTEN * 1000);
}

#[test]
fn a_path_log_and_a_commits_page_say_the_same() {
    let (h, _, main) = cloned();
    let history = h.ok(
        OWNER,
        json!({"op":"repo_path_history","ref":"main","path":"a.txt"}),
    );
    assert_eq!(history["commits"][0]["author_name"], "Grace");
    assert_eq!(history["commits"][0]["authored_at"], (WRITTEN + 60) * 1000);
    let detail = h.ok(OWNER, json!({"op":"repo_commit","commit":main}));
    assert_eq!(detail["author_name"], "Grace");
    assert_eq!(detail["authored_at"], (WRITTEN + 60) * 1000);
    assert_eq!(detail["principal"], IMPORTER);
}

#[test]
fn a_commit_made_here_records_its_author_too() {
    let (h, root) = seeded();
    let detail = h.ok(OWNER, json!({"op":"repo_commit","commit":root}));
    assert_eq!(detail["author_name"], "Agent");
    assert!(detail["authored_at"].as_i64().unwrap() > 0);
}

#[test]
fn an_address_in_the_name_field_never_reaches_a_page() {
    let h = Harness::new();
    let tree = "2".repeat(40);
    let (_, item, _) = written(&[], &tree, &writer("ada@example.com", WRITTEN), "root", &[]);
    let id = item["commit"].as_str().unwrap().to_owned();
    record(&h, IMPORTER, json!([item])).unwrap();
    let detail = h.ok(OWNER, json!({"op":"repo_commit","commit":id}));
    assert_eq!(detail["author_name"], "ada");
}

#[test]
fn a_backfill_reads_each_commits_bytes_and_never_trusts_or_overwrites() {
    let (h, root, main) = cloned();
    h.db.query("UPDATE commits SET author_name=NULL,authored_at=NULL", &[])
        .unwrap();
    let missing = h.ok(IMPORTER, json!({"op":"repo_authors_missing","limit":1}));
    assert_eq!(missing["commits"].as_array().unwrap().len(), 1);
    let first = missing["next"].as_str().unwrap().to_owned();
    let rest = h.ok(
        IMPORTER,
        json!({"op":"repo_authors_missing","limit":10,"after":first}),
    );
    assert_eq!(rest["commits"].as_array().unwrap().len(), 1);

    let tree = "2".repeat(40);
    let (_, _, ada) = written(&[], &tree, &writer("Ada", WRITTEN), "root", &["a.txt"]);
    // Bytes of another commit fill nothing.
    let forged = h.ok(
        IMPORTER,
        json!({"op":"repo_authors_set","commits":[{"commit":main,"data_b64":ada}]}),
    );
    assert_eq!(forged["filled"], 0);
    let filled = h.ok(
        IMPORTER,
        json!({"op":"repo_authors_set","commits":[{"commit":root,"data_b64":ada}]}),
    );
    assert_eq!(filled["filled"], 1);
    let again = h.ok(
        IMPORTER,
        json!({"op":"repo_authors_set","commits":[{"commit":root,"data_b64":ada}]}),
    );
    assert_eq!(again["filled"], 0);
    let log = h.ok(OWNER, json!({"op":"repo_log","ref":"main"}));
    assert_eq!(log["commits"][1]["author_name"], "Ada");
    assert_eq!(log["commits"][0]["author_name"], Value::Null);
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_authors_set","commits":[{"commit":root,"data_b64":ada}]})
        )),
        "FORBIDDEN"
    );
}
