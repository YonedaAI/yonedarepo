//! Batched landing: the authority sees one call per land batch. Commits begin from a
//! published head (no authority call), land from their commit shard's record (no
//! adoption) with scope and grants re-checked at landing, and main's Git view gets one
//! commit per batch.
use super::*;

const MERGER: &str = "platform:merge";
const PROJECTOR: &str = "platform:projection";

/// Credentials as the adapter attaches them for `principal`.
fn credentials(principal: &str) -> Value {
    match principal.strip_prefix("token:") {
        Some(name) => json!({"_token": format!("{name}-secret-0123456789abcdef0123456789")}),
        None => json!({"_session": {"workspace": "ws-1", "principal": principal}}),
    }
}

impl Harness {
    fn head(&self) -> Value {
        self.ok(PROJECTOR, json!({"op":"repo_head","ref":"main"}))
    }
    /// Begins from the published head with stateless compute, as an isolate does.
    fn begin_cached(&self, principal: &str, paths: Value) -> yoneda_core::Result<Value> {
        crate::platform_compute(json!({"op":"head_begin","head":self.head(),
            "credentials":credentials(principal),"paths":paths}))
    }
    /// A commit built statelessly and recorded only in its commit shard: its record.
    fn shard_commit(&self, principal: &str, path: &str, text: &str, read: Value) -> Value {
        let begun = self.begin_cached(principal, json!([path])).unwrap();
        let mut trees = serde_json::Map::new();
        let built = loop {
            let step =
                crate::platform_compute(json!({"op":"build_commit","now":*self.now.borrow(),
                "parent":begun["parent"],"changes":[file(path, text)],"message":path,
                "author":{"name":"A","email":"a@example.com"},"read_set":read,"trees":trees}))
                .unwrap();
            let Some(need) = step["need_trees"].as_array() else {
                break step;
            };
            for id in need {
                let id = id.as_str().unwrap();
                let (_, bytes) = &self.objects.borrow()[id];
                trees.insert(
                    id.into(),
                    json!(
                        decode_tree(bytes)
                            .unwrap()
                            .iter()
                            .map(|e| json!({"name": e.name, "id": e.id,
                    "type": if e.mode == FileMode::Tree { "tree" } else { "blob" }}))
                            .collect::<Vec<_>>()
                    ),
                );
            }
        };
        for object in built["raw"].as_array().unwrap() {
            let kind = match object["kind"].as_str().unwrap() {
                "commit" => ObjectKind::Commit,
                "tree" => ObjectKind::Tree,
                _ => ObjectKind::Blob,
            };
            let data = STANDARD
                .decode(object["data_b64"].as_str().unwrap())
                .unwrap();
            self.objects
                .borrow_mut()
                .insert(object["id"].as_str().unwrap().into(), (kind, data));
        }
        json!({
            "commit": {"id": built["commit"], "tree": built["tree"], "parents": built["parents"].to_string(),
                "generation": built["generation"], "base_version": begun["base_version"], "principal": begun["principal"],
                "message": path, "read_set": built["read_set"].to_string(), "recorded_at": *self.now.borrow()},
            "paths": built["touches"],
            "objects": built["raw"].as_array().unwrap().iter().map(|o| json!({"id": o["id"], "kind": o["kind"]})).collect::<Vec<_>>(),
        })
    }
    fn submit(&self, items: Vec<(&str, &Value)>) -> Value {
        let items: Vec<Value> = items
            .into_iter()
            .map(|(principal, record)| json!({"credentials": credentials(principal), "records": [record]}))
            .collect();
        self.ok(
            MERGER,
            json!({"op":"repo_land_submitted","ref":"main","items":items}),
        )
    }
}

/// A seeded repository whose policy lets any approved-by-nobody commit land (gates are
/// covered elsewhere; these tests are about access, routing and projection).
fn open() -> (Harness, String) {
    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":0}}),
    );
    (h, root)
}

fn outcome(batch: &Value, index: usize) -> (String, Value) {
    let item = &batch["items"][index];
    (item["status"].as_str().unwrap().to_owned(), item.clone())
}

#[test]
fn submitted_landings_land_from_shard_records_and_adopt_lazily() {
    let (h, _) = open();
    let a = h.shard_commit(AGENT, "a.txt", "a\n", json!([]));
    let b = h.shard_commit(AGENT, "b.txt", "b\n", json!([]));
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_land_submitted","ref":"main","items":[]})
        )),
        "FORBIDDEN"
    );
    let batch = h.submit(vec![(OWNER, &a), (OWNER, &b)]);
    assert_eq!(outcome(&batch, 0).0, "landed", "{batch}");
    assert_eq!(outcome(&batch, 1).1["version"], 3);
    // Landed without adoption: the authority knows the changeset, not the full commit.
    let id = a["commit"]["id"].as_str().unwrap();
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_commit","commit":id}))),
        "NOT_FOUND"
    );
    // A resubmitted landing (a retried lander) answers with its version.
    assert_eq!(h.submit(vec![(OWNER, &a)])["items"][0]["version"], 2);
    // Something that needs the full commit adopts it then; adoption stays idempotent.
    for _ in 0..2 {
        h.ok(
            "platform:commits",
            json!({"op":"repo_adopt_commit","record":a}),
        );
    }
    let shown = h.ok(OWNER, json!({"op":"repo_commit","commit":id}));
    assert_eq!(shown["landings"][0]["version"], 2);
    // The batch shares one Git commit for its versions.
    h.project_all();
    let head = h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}));
    assert_eq!(head["version"], 3);
    for at in [2, 3] {
        assert_eq!(
            h.ok(OWNER, json!({"op":"repo_refs","at":at}))["refs"]["refs/heads/main"],
            head["commit"]
        );
    }
    let tip = h.ok(OWNER, json!({"op":"repo_commit","commit":head["commit"]}));
    assert_eq!(
        tip["parents"].as_array().unwrap().len(),
        1,
        "linear: one parent"
    );
    assert_eq!(
        h.file_at(head["commit"].as_str().unwrap(), "b.txt")
            .as_deref(),
        Some("b\n")
    );
}

#[test]
fn a_chained_commit_on_the_merge_path_asks_for_its_chain() {
    let (h, _) = open();
    let first = h.shard_commit(AGENT, "a.txt", "a\n", json!([]));
    // `second` builds on `first`, which only its shard holds.
    let second = {
        let mut record = h.shard_commit(AGENT, "b.txt", "b\n", json!([]));
        record["commit"]["parents"] = json!(json!([first["commit"]["id"]]).to_string());
        record
    };
    let batch = h.submit(vec![(OWNER, &second)]);
    assert_eq!(outcome(&batch, 0).0, "need_chain");
    let items = vec![json!({"credentials": credentials(OWNER), "records": [first, second]})];
    let batch = h.ok(
        MERGER,
        json!({"op":"repo_land_submitted","ref":"main","items":items}),
    );
    assert_eq!(outcome(&batch, 0).0, "queued", "{batch}");
}

#[test]
fn landing_rechecks_scope_and_grants_after_a_cached_begin() {
    let (h, _) = open();
    const DOCS: &str = "token:docs";
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read","write","land"],
        "paths":["docs/"],"_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    // A cached begin refuses what the published grants refuse.
    assert_eq!(
        code(h.begin_cached(DOCS, json!(["src/lib.rs"]))),
        "FORBIDDEN"
    );
    assert_eq!(
        code(h.begin_cached("token:nobody", json!(["a.txt"]))),
        "UNAUTHORIZED"
    );
    let kept = h.shard_commit(DOCS, "docs/a.md", "a\n", json!([]));
    let revoked = h.shard_commit(DOCS, "docs/b.md", "b\n", json!([]));
    // The agent token may write but not land.
    let unlanded = h.shard_commit(AGENT, "c.txt", "c\n", json!([]));
    let batch = h.submit(vec![(DOCS, &kept), (AGENT, &unlanded)]);
    assert_eq!(outcome(&batch, 0).0, "landed");
    assert_eq!(
        (
            outcome(&batch, 1).0.as_str(),
            outcome(&batch, 1).1["code"].as_str()
        ),
        ("failed", Some("FORBIDDEN"))
    );
    // Revoked after its begin: the landing is refused (fail closed, uniform refusal).
    h.ok(OWNER, json!({"op":"repo_token_revoke","name":"docs"}));
    let batch = h.submit(vec![(DOCS, &revoked)]);
    assert_eq!(
        (
            outcome(&batch, 0).0.as_str(),
            outcome(&batch, 0).1["code"].as_str()
        ),
        ("failed", Some("UNAUTHORIZED"))
    );
    assert_eq!(
        code(h.begin_cached(DOCS, json!(["docs/c.md"]))),
        "UNAUTHORIZED"
    );
}

#[test]
fn begin_from_the_published_head_and_its_overlay() {
    let (h, root) = open();
    let head = h.head();
    assert_eq!(
        (head["version"].as_u64(), head["head"]["id"].as_str()),
        (Some(1), Some(root.as_str()))
    );
    let a = h.shard_commit(AGENT, "a.txt", "a\n", json!([]));
    h.submit(vec![(OWNER, &a)]);
    // Landed, not projected: the head names the projected commit plus the overlay.
    let head = h.head();
    assert_eq!(head["version"], 2);
    assert_eq!(head["head"]["id"], root);
    assert_eq!(head["overlay"][0]["paths"][0]["path"], "a.txt");
    let begun = h.begin_cached(AGENT, json!(["z.txt"])).unwrap();
    assert_eq!(
        (
            begun["parent"]["id"].as_str(),
            begun["base_version"].as_u64()
        ),
        (Some(root.as_str()), Some(1))
    );
    h.project_all();
    let head = h.head();
    assert_eq!(
        (head["version"].as_u64(), head["projected_version"].as_u64()),
        (Some(2), Some(2))
    );
    assert_eq!(head["overlay"], json!([]));
}

#[test]
fn batch_projection_is_deterministic() {
    let run = || {
        let (h, _) = open();
        let a = h.shard_commit(AGENT, "d/a.txt", "a\n", json!([]));
        let b = h.shard_commit(AGENT, "d/b.txt", "b\n", json!([]));
        let c = h.shard_commit(AGENT, "e.txt", "c\n", json!([]));
        h.submit(vec![(OWNER, &a), (OWNER, &b)]);
        h.submit(vec![(OWNER, &c)]);
        h
    };
    let (one, two) = (run(), run());
    let plan = one.ok(PROJECTOR, json!({"op":"repo_changeset_plan"}));
    let built = one.project_compute(&plan);
    let steps = built["projected"].as_array().unwrap();
    assert_eq!(steps.len(), 2, "one Git commit per batch");
    assert_eq!(steps[0]["versions"], json!([2, 3]));
    assert_eq!(steps[1]["parents"], json!([steps[0]["commit"]]));
    let other = two.project_compute(&two.ok(PROJECTOR, json!({"op":"repo_changeset_plan"})));
    assert_eq!(other["projected"], built["projected"]);
    one.project_all();
    assert_eq!(
        one.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}))["commit"],
        steps[1]["commit"]
    );
}

#[test]
fn a_projected_batch_carries_every_new_object_to_the_object_store() {
    let (h, _) = open();
    let a = h.shard_commit(AGENT, "a.txt", "a\n", json!([]));
    let b = h.shard_commit(AGENT, "d/b.txt", "b\n", json!([]));
    h.submit(vec![(OWNER, &a), (OWNER, &b)]);
    h.project_all();
    // What the ref projector pushes with main: every object Artifacts lacks, including the
    // landed files' blobs (the landed commits are neither parents nor adopted).
    let pushed = h.ok(
        PROJECTOR,
        json!({"op":"repo_projection_objects","refname":"refs/heads/main"}),
    );
    let ids: Vec<String> = pushed["commits"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|c| c["objects"].as_array().unwrap().clone())
        .map(|o| o["id"].as_str().unwrap().to_owned())
        .collect();
    let head = h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}));
    let mut needed = vec![head["commit"].as_str().unwrap().to_owned()];
    // The head's tree, the new `d` tree and both blobs.
    let blob = |t: &str| hash_object(ObjectKind::Blob, t.as_bytes()).hex();
    needed.extend([
        head["tree"].as_str().unwrap().to_owned(),
        blob("a\n"),
        blob("b\n"),
    ]);
    for id in needed {
        assert!(
            ids.contains(&id),
            "{id} would be missing from the pushed main: {pushed}"
        );
    }
}

#[test]
fn the_backfill_relists_blobs_of_batches_projected_without_them() {
    use crate::storage::SqlStore;
    let (h, _) = open();
    let a = h.shard_commit(AGENT, "a.txt", "a\n", json!([]));
    h.submit(vec![(OWNER, &a)]);
    h.project_all();
    let head = h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}))["commit"].clone();
    let commits = json!([head]);
    // As a projection before the fix left it: pushed without the blob, marked held.
    h.ok(
        PROJECTOR,
        json!({"op":"repo_projection_result","refname":"refs/heads/main","version":2,
        "outcome":"ok","commit":head,"commits":commits}),
    );
    let listed = |h: &Harness| {
        h.ok(
            PROJECTOR,
            json!({"op":"repo_projection_objects","refname":"refs/heads/main"}),
        )["commits"]
            .clone()
    };
    assert_eq!(listed(&h), json!([]));
    let sql = include_str!("../../migrations/repo_store/0021_projected_blobs.sql");
    for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
        h.db.query(statement, &[]).unwrap();
    }
    let blob = hash_object(ObjectKind::Blob, b"a\n").hex();
    assert_eq!(
        listed(&h)[0]["objects"],
        json!([{"id": blob, "kind": "blob"}])
    );
}
