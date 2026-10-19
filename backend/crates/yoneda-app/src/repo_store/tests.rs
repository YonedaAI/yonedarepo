//! Platform-only tests: a scripted client plays the adapter (object store + readback).
//! No agents, runs or provider keys are involved.
use super::execute_repo_store;
use crate::native::NativeStore;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{cell::RefCell, collections::HashMap};
use yoneda_core::git_object::{
    Commit, FileMode, ObjectKind, PackLimits, decode_tree, hash_object, read_pack,
};

const OWNER: &str = "user:owner";
const AGENT: &str = "token:agent";
const CI: &str = "token:ci";
const SYSTEM: &str = "platform:checks";

struct Harness {
    db: NativeStore,
    /// Plays the object store: raw objects unpacked from real pushed packs.
    objects: RefCell<HashMap<String, (ObjectKind, Vec<u8>)>>,
    /// The adapter's write-through cache copies returned by prepare.
    cached: RefCell<HashMap<String, Value>>,
    now: RefCell<i64>,
}

impl Harness {
    fn new() -> Self {
        let h = Self {
            db: NativeStore::memory().unwrap(),
            objects: RefCell::default(),
            cached: RefCell::default(),
            now: RefCell::new(1_700_000_000_000),
        };
        h.run(OWNER, json!({"op":"repo_init","name":"demo","object_store":"artifacts:test/demo","policy":{"required_checks":["unit"],"approvals":1}})).unwrap();
        for (name, scopes) in [
            ("agent", json!(["read", "write"])),
            ("ci", json!(["read", "check"])),
        ] {
            h.ok(OWNER, json!({"op":"repo_token_create","name":name,"scopes":scopes,"_secret":format!("{name}-secret-0123456789abcdef0123456789")}));
        }
        h
    }
    fn run(&self, principal: &str, mut c: Value) -> yoneda_core::Result<Value> {
        *self.now.borrow_mut() += 1_000;
        c["now"] = json!(*self.now.borrow());
        match principal.strip_prefix("token:") {
            Some(name) => c["_token"] = json!(format!("{name}-secret-0123456789abcdef0123456789")),
            None if principal == SYSTEM => c["_system"] = json!("checks"),
            None => c["_session"] = json!({"workspace": "ws-1", "principal": principal}),
        }
        execute_repo_store(&self.db, c)
    }
    fn ok(&self, principal: &str, c: Value) -> Value {
        self.run(principal, c.clone())
            .unwrap_or_else(|e| panic!("{c} failed: {e}"))
    }
    fn tree_json(&self, id: &str) -> Value {
        let (_, bytes) = &self.objects.borrow()[id];
        let entries = decode_tree(bytes).unwrap();
        let listed = json!(entries.iter().map(|e| json!({"name": e.name, "id": e.id, "type": match e.mode {
            FileMode::Tree => "tree", FileMode::Executable => "exec", FileMode::Symlink => "symlink",
            FileMode::Gitlink => "gitlink", FileMode::Blob => "blob" }})).collect::<Vec<_>>());
        // The cache copy prepare returned must agree with the raw tree that was pushed.
        assert_eq!(self.cached.borrow()[id]["entries"], listed);
        listed
    }
    /// Receives a push like a Git server: unpack the pack, store objects, report status.
    fn receive(&self, push: &[u8], hidden_ref: &str) -> String {
        let pack_at = push.windows(4).position(|w| w == b"PACK").unwrap();
        for (kind, data) in read_pack(&push[pack_at..], PackLimits::default()).unwrap() {
            let id = hash_object(kind, &data).hex();
            self.objects.borrow_mut().insert(id, (kind, data));
        }
        let ok = format!("ok {hidden_ref}\n");
        STANDARD.encode(format!("000eunpack ok\n{:04x}{ok}0000", ok.len() + 4))
    }
    /// Plays the adapter: answer tree requests, push, read back, record.
    fn commit(
        &self,
        principal: &str,
        parent: Option<&str>,
        base_version: u64,
        changes: Value,
        read_set: Value,
    ) -> yoneda_core::Result<String> {
        let mut trees = serde_json::Map::new();
        loop {
            let prepared = self.run(
                principal,
                json!({
                    "op": "repo_prepare_commit", "parent": parent, "base_version": base_version,
                    "changes": changes, "read_set": read_set, "trees": trees,
                    "message": "change", "author": {"name": "Agent", "email": "agent@example.com"},
                }),
            )?;
            if let Some(need) = prepared["need_trees"].as_array() {
                assert!(!need.is_empty());
                for id in need {
                    let id = id.as_str().unwrap();
                    trees.insert(id.into(), self.tree_json(id));
                }
                continue;
            }
            for object in prepared["objects"].as_array().unwrap() {
                self.cached
                    .borrow_mut()
                    .insert(object["id"].as_str().unwrap().into(), object.clone());
            }
            let push = STANDARD
                .decode(prepared["push_b64"].as_str().unwrap())
                .unwrap();
            let report = self.receive(&push, prepared["hidden_ref"].as_str().unwrap());
            let id = prepared["commit"].as_str().unwrap().to_owned();
            let commit = Commit::decode(&self.objects.borrow()[&id].1).unwrap();
            self.run(principal, json!({"op": "repo_record_commit", "commit": id, "push_report_b64": report,
                "readback": {"tree": commit.tree().unwrap(), "parents": commit.parents().unwrap()}}))?;
            return Ok(id);
        }
    }
    fn approve_and_check(&self, id: &str) {
        self.ok(
            CI,
            json!({"op":"repo_check","commit":id,"name":"unit","status":"pass"}),
        );
        self.ok(
            OWNER,
            json!({"op":"repo_review","commit":id,"decision":"approve"}),
        );
    }
}

fn file(path: &str, text: &str) -> Value {
    json!({"path": path, "content_b64": STANDARD.encode(text)})
}
fn code(result: yoneda_core::Result<Value>) -> String {
    result.err().map(|e| e.code).unwrap_or_else(|| "OK".into())
}

fn seeded() -> (Harness, String) {
    let h = Harness::new();
    let root = h
        .commit(
            OWNER,
            None,
            0,
            json!([
                file("README.md", "# demo\n"),
                file("src/lib.rs", "pub fn a() {}\n")
            ]),
            json!([]),
        )
        .unwrap();
    assert_eq!(
        code(h.run(
            AGENT,
            json!({"op":"repo_import","ref":"main","commit":root})
        )),
        "FORBIDDEN"
    );
    assert_eq!(
        h.ok(
            OWNER,
            json!({"op":"repo_import","ref":"main","commit":root})
        )["version"],
        1
    );
    (h, root)
}

#[test]
fn commit_review_check_land_and_time_travel() {
    let (h, root) = seeded();
    let child = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([
                file("src/lib.rs", "pub fn a() { 1 }\n"),
                file("docs/a.md", "hi\n")
            ]),
            json!(["src/"]),
        )
        .unwrap();
    let detail = h.ok(OWNER, json!({"op":"repo_commit","commit":child}));
    assert_eq!(detail["paths"].as_array().unwrap().len(), 2);
    assert_eq!(detail["gates"]["missing_checks"], json!(["unit"]));
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_land","ref":"main","commit":child}))),
        "NOT_READY"
    );
    assert_eq!(
        code(h.run(
            AGENT,
            json!({"op":"repo_review","commit":child,"decision":"approve"})
        )),
        "FORBIDDEN"
    );
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_review","commit":child,"decision":"reject"})
        )),
        "INVALID_INPUT"
    );
    h.approve_and_check(&child);
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_review","commit":child,"decision":"reject","reason":"changed mind"})
        )),
        "ALREADY_EXISTS"
    );
    let landed = h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":child}));
    assert_eq!(landed["version"], 2);
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":child}))["already"],
        true
    );
    // Time travel: version 1 still sees the imported root.
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main","at":1}))["commit"],
        root
    );
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}))["commit"],
        child
    );
    let log = h.ok(OWNER, json!({"op":"repo_log","ref":"main"}));
    let ids: Vec<&str> = log["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["commit"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![child.as_str(), root.as_str()]);
    let entries = h.ok(OWNER, json!({"op":"repo_txlog"}))["entries"].clone();
    assert_eq!(entries[1]["paths"].as_array().unwrap().len(), 2);
    assert_eq!(entries[1]["read_set"], json!(["src/"]));
}

#[test]
fn concurrent_landing_follows_read_write_set_independence() {
    let (h, root) = seeded();
    let docs = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("docs/a.md", "a\n")]),
            json!([]),
        )
        .unwrap();
    let src = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn b() {}\n")]),
            json!([]),
        )
        .unwrap();
    let same = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("docs/a.md", "other\n")]),
            json!([]),
        )
        .unwrap();
    let reads_docs = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("README.md", "# x\n")]),
            json!(["docs/"]),
        )
        .unwrap();
    for id in [&docs, &src, &same, &reads_docs] {
        h.approve_and_check(id);
    }
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":docs}));
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_land","ref":"main","commit":src}))),
        "MERGE_REQUIRED"
    );
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_land","ref":"main","commit":same}))),
        "CONFLICT"
    );
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_land","ref":"main","commit":reads_docs})
        )),
        "CONFLICT"
    );
    // A new branch from an approved commit is a plain ref creation.
    assert_eq!(
        h.ok(
            OWNER,
            json!({"op":"repo_land","ref":"feature/src","commit":src})
        )["version"],
        3
    );
}

#[test]
fn untrusted_adapter_inputs_are_verified() {
    let (h, root) = seeded();
    let root_tree = h.ok(OWNER, json!({"op":"repo_commit","commit":root}))["tree"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut forged = h.tree_json(&root_tree);
    forged[0]["name"] = json!("EVIL.md");
    let tampered = h.run(
        AGENT,
        json!({"op":"repo_prepare_commit","parent":root,"base_version":1,
        "changes":[file("README.md","x\n")],"trees":{root_tree.clone(): forged},
        "message":"m","author":{"name":"A","email":"a@example.com"}}),
    );
    assert_eq!(code(tampered), "TREE_INVALID");
    // Readback must match what the store built, and only the preparer may record.
    let prepared = h.ok(
        AGENT,
        json!({"op":"repo_prepare_commit","parent":root,"base_version":1,
        "changes":[file("README.md","y\n")],"trees":{root_tree.clone(): h.tree_json(&root_tree)},
        "message":"m","author":{"name":"A","email":"a@example.com"}}),
    );
    let id = prepared["commit"].clone();
    let readback = json!({"tree": prepared["tree"], "parents": prepared["parents"]});
    let push = STANDARD
        .decode(prepared["push_b64"].as_str().unwrap())
        .unwrap();
    let report = h.receive(&push, prepared["hidden_ref"].as_str().unwrap());
    let record = |principal: &str, report: &str, readback: &Value| {
        h.run(principal, json!({"op":"repo_record_commit","commit":id,"push_report_b64":report,"readback":readback}))
    };
    let rejected = STANDARD.encode("000eunpack ok\n0018ng refs/x denied\n0000");
    assert_eq!(
        code(record(AGENT, &rejected, &readback)),
        "GIT_OBJECT_INVALID"
    );
    assert_eq!(
        code(record(
            AGENT,
            &report,
            &json!({"tree": root_tree, "parents": [root]})
        )),
        "READBACK_MISMATCH"
    );
    assert_eq!(code(record(OWNER, &report, &readback)), "NOT_FOUND");
    record(AGENT, &report, &readback).unwrap();
    assert_eq!(record(AGENT, &report, &readback).unwrap()["already"], true);
    // No-op and missing-path changes are rejected.
    assert_eq!(
        code(
            h.commit(
                AGENT,
                Some(&root),
                1,
                json!([file("README.md", "# demo\n")]),
                json!([])
            )
            .map(Value::String)
        ),
        "NO_CHANGES"
    );
    assert_eq!(
        code(
            h.commit(
                AGENT,
                Some(&root),
                1,
                json!([{"path":"nope.txt","delete":true}]),
                json!([])
            )
            .map(Value::String)
        ),
        "NOT_FOUND"
    );
    let foreign = execute_repo_store(
        &h.db,
        json!({"op":"repo_status","_session":{"workspace":"ws-2","principal":OWNER},"now":1}),
    );
    assert_eq!(code(foreign), "FORBIDDEN");
    let guessed = execute_repo_store(
        &h.db,
        json!({"op":"repo_status","_token":"guess-0123456789abcdef0123456789","now":1}),
    );
    assert_eq!(code(guessed), "UNAUTHORIZED");
}

#[test]
fn tokens_are_scoped_and_revocable() {
    let (h, root) = seeded();
    let child = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("docs/a.md", "a\n")]),
            json!([]),
        )
        .unwrap();
    assert_eq!(
        code(h.run(
            AGENT,
            json!({"op":"repo_check","commit":child,"name":"unit","status":"pass"})
        )),
        "FORBIDDEN"
    );
    assert_eq!(code(h.run(CI, json!({"op":"repo_prepare_commit","base_version":1,"changes":[file("x","y")],"message":"m","author":{"name":"C","email":"c@example.com"}}))), "FORBIDDEN");
    h.approve_and_check(&child);
    assert_eq!(
        code(h.run(AGENT, json!({"op":"repo_land","ref":"main","commit":child}))),
        "FORBIDDEN"
    );
    assert_eq!(
        code(h.run(
            AGENT,
            json!({"op":"repo_token_create","name":"x","scopes":["land"],"_secret":"s".repeat(40)})
        )),
        "FORBIDDEN"
    );
    h.ok(OWNER, json!({"op":"repo_token_revoke","name":"agent"}));
    assert_eq!(
        code(h.run(AGENT, json!({"op":"repo_status"}))),
        "UNAUTHORIZED"
    );
    let listed = h.ok(OWNER, json!({"op":"repo_tokens"}));
    assert!(
        listed.to_string().find("secret").is_none(),
        "secrets and digests are never listed"
    );
}

#[test]
fn tampered_history_is_detected_on_time_travel() {
    let (h, root) = seeded();
    let child = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("docs/a.md", "a\n")]),
            json!([]),
        )
        .unwrap();
    h.approve_and_check(&child);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":child}));
    use crate::storage::SqlStore;
    h.db.query(
        "UPDATE txlog SET entry=replace(entry,'docs/a.md','docs/b.md') WHERE version=2",
        &[],
    )
    .unwrap();
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_refs","at":2}))),
        "TXLOG_INVALID"
    );
}

#[test]
fn migrations_are_repeatable_and_pinned() {
    let h = Harness::new();
    super::migrate_repo_store(&h.db).unwrap();
    super::migrate_repo_store(&h.db).unwrap();
    use crate::storage::SqlStore;
    h.db.query(
        "UPDATE repo_schema_migrations SET digest='x' WHERE version=1",
        &[],
    )
    .unwrap();
    assert_eq!(
        super::migrate_repo_store(&h.db).unwrap_err().code,
        "MIGRATION_DRIFT"
    );
}

#[test]
fn merge_base_of_diverged_commits_is_their_fork_point() {
    let (h, root) = seeded();
    let left = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("a.txt", "l\n")]),
            json!([]),
        )
        .unwrap();
    let right = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("b.txt", "r\n")]),
            json!([]),
        )
        .unwrap();
    let bases = h.ok(
        CI,
        json!({"op":"repo_merge_base","left":left,"right":right}),
    );
    assert_eq!(bases["merge_bases"][0]["commit"], root);
    let unknown = "0".repeat(40);
    assert_eq!(
        code(h.run(
            CI,
            json!({"op":"repo_merge_base","left":left,"right":unknown})
        )),
        "NOT_FOUND"
    );
}

fn runner_policy(timeout: u32) -> Value {
    json!({"policy": {"required_checks": ["unit"], "approvals": 1,
        "runners": {"unit": {"command": ["sh", "-c", "cargo test"], "timeout_seconds": timeout}}}})
}

#[test]
fn platform_check_runs_are_fenced_by_epoch_and_bound_to_policy() {
    let (h, root) = seeded();
    let mut set = runner_policy(60);
    set["op"] = json!("repo_set_policy");
    assert_eq!(code(h.run(AGENT, set.clone())), "FORBIDDEN");
    let digest = h.ok(OWNER, set)["policy_digest"].clone();

    // Recording a commit queues every policy runner automatically.
    let id = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("a.txt", "a\n")]),
            json!([]),
        )
        .unwrap();
    let detail = h.ok(OWNER, json!({"op":"repo_commit","commit":id}));
    let run = detail["check_runs"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(detail["check_runs"][0]["status"], "queued");
    assert_eq!(
        h.ok(AGENT, json!({"op":"repo_check_request","commit":id}))["runs"][0]["existing"],
        true
    );

    assert_eq!(
        code(h.run(AGENT, json!({"op":"repo_check_claim","run_id":run}))),
        "FORBIDDEN"
    );
    let claimed = h.ok(SYSTEM, json!({"op":"repo_check_claim","run_id":run}));
    assert_eq!(claimed["epoch"], 1);
    assert_eq!(claimed["command"], json!(["sh", "-c", "cargo test"]));
    assert_eq!(claimed["tree"], detail["tree"]);
    assert!(h.ok(SYSTEM, json!({"op":"repo_check_claim","run_id":run}))["busy"] == true);

    // The lease expires: a second executor takes over and the first is fenced off.
    *h.now.borrow_mut() += 60_000 + 5 * 60_000;
    assert_eq!(
        h.ok(SYSTEM, json!({"op":"repo_check_claim","run_id":run}))["epoch"],
        2
    );
    let complete = |epoch: u64, outcome: &str| {
        h.run(
            SYSTEM,
            json!({"op":"repo_check_complete","run_id":run,"epoch":epoch,
            "outcome":outcome,"evidence":{"exit_code":0,"log":"platform/v1/r/checks/x"}}),
        )
    };
    assert_eq!(code(complete(1, "pass")), "STALE_EPOCH");
    assert_eq!(complete(2, "pass").unwrap()["status"], "passed");
    assert_eq!(complete(2, "fail").unwrap()["already"], true);
    let gates = &h.ok(OWNER, json!({"op":"repo_commit","commit":id}))["gates"];
    assert_eq!(gates["missing_checks"], json!([]));
    let recorded = h.ok(OWNER, json!({"op":"repo_commit","commit":id}))["checks"][0].clone();
    assert_eq!(recorded["principal"], SYSTEM);

    // A new policy invalidates results produced under the old one.
    let mut stricter = runner_policy(120);
    stricter["op"] = json!("repo_set_policy");
    assert_ne!(h.ok(OWNER, stricter)["policy_digest"], digest);
    let gates = &h.ok(OWNER, json!({"op":"repo_commit","commit":id}))["gates"];
    assert_eq!(gates["missing_checks"], json!(["unit"]));

    // Infrastructure errors record no result and can be re-run.
    let rerun = h.ok(
        CI,
        json!({"op":"repo_check_request","commit":id,"name":"unit"}),
    )["runs"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(rerun, run);
    let epoch = h.ok(SYSTEM, json!({"op":"repo_check_claim","run_id":rerun}))["epoch"]
        .as_u64()
        .unwrap();
    h.ok(SYSTEM, json!({"op":"repo_check_complete","run_id":rerun,"epoch":epoch,"outcome":"error","evidence":{"error":"container"}}));
    let again = h.ok(
        CI,
        json!({"op":"repo_check_request","commit":id,"name":"unit"}),
    )["runs"][0]
        .clone();
    assert_eq!(again["status"], "queued");
    assert_ne!(again["id"], json!(rerun));
    assert_eq!(
        code(h.run(
            CI,
            json!({"op":"repo_check_request","commit":id,"name":"lint"})
        )),
        "NOT_FOUND"
    );
}

#[test]
fn policy_rejects_unsafe_runners() {
    let (h, _) = seeded();
    for runner in [
        json!({"command": []}),
        json!({"command": ["x"], "timeout_seconds": 0}),
        json!({"command": ["x"], "shell": true}),
    ] {
        let result = h.run(OWNER, json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":0,"runners":{"unit":runner}}}));
        assert_eq!(code(result), "INVALID_INPUT");
    }
}

#[test]
fn upgrades_from_the_preceding_schema_keeping_data() {
    use crate::storage::SqlStore;
    let db = NativeStore::memory().unwrap();
    let v1 = include_str!("../migrations/repo_store/0001_source.sql");
    db.query(
        "CREATE TABLE repo_schema_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",
        &[],
    )
    .unwrap();
    for statement in v1.split(';').filter(|s| !s.trim().is_empty()) {
        db.query(statement, &[]).unwrap();
    }
    db.query(
        "INSERT INTO repo_schema_migrations(version,digest) VALUES(1,?)",
        &[json!(yoneda_core::digest(v1.as_bytes()))],
    )
    .unwrap();
    db.query(
        "INSERT INTO refs(name,commit_id,version) VALUES('refs/heads/main','abc',1)",
        &[],
    )
    .unwrap();
    super::migrate_repo_store(&db).unwrap();
    assert_eq!(
        db.query("SELECT MAX(version) AS v FROM repo_schema_migrations", &[])
            .unwrap()[0]["v"],
        4
    );
    assert_eq!(
        db.query("SELECT commit_id FROM refs", &[]).unwrap()[0]["commit_id"],
        "abc"
    );
    assert!(
        db.query("SELECT id FROM check_runs", &[])
            .unwrap()
            .is_empty()
    );
}

#[test]
fn revert_references_known_blobs_and_rejects_moved_paths() {
    let (h, root) = seeded();
    let original = yoneda_core::git_object::hash_object(ObjectKind::Blob, b"pub fn a() {}\n");
    let edited = yoneda_core::git_object::hash_object(ObjectKind::Blob, b"pub fn a() { 2 }\n");
    let edit = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn a() { 2 }\n")]),
            json!([]),
        )
        .unwrap();
    // Revert: put the old blob back, expecting the edited one. No bytes are re-sent.
    let revert =
        json!([{"path": "src/lib.rs", "blob": original, "type": "blob", "expect": edited}]);
    let before: Vec<String> = h.cached.borrow().keys().cloned().collect();
    let reverted = h
        .commit(AGENT, Some(&edit), 1, revert.clone(), json!([]))
        .unwrap();
    let paths = h.ok(OWNER, json!({"op":"repo_commit","commit":reverted}))["paths"].clone();
    assert_eq!(paths[0]["new_blob"], json!(original));
    let pushed: Vec<Value> = h
        .cached
        .borrow()
        .iter()
        .filter(|(id, _)| !before.contains(id))
        .map(|(_, o)| o["kind"].clone())
        .collect();
    assert!(
        !pushed.contains(&json!("blob")),
        "a referenced blob is not pushed again"
    );
    // The same revert on a parent where the path moved on is a conflict, not an overwrite.
    let moved = h
        .commit(
            AGENT,
            Some(&edit),
            1,
            json!([file("src/lib.rs", "pub fn a() { 3 }\n")]),
            json!([]),
        )
        .unwrap();
    assert_eq!(
        code(
            h.commit(AGENT, Some(&moved), 1, revert, json!([]))
                .map(|_| json!(null))
        ),
        "CONFLICT"
    );
    // Unknown blobs cannot be referenced into existence.
    let forged = json!([{"path": "x", "blob": "1".repeat(40), "expect": null}]);
    assert_eq!(
        code(
            h.commit(AGENT, Some(&edit), 1, forged, json!([]))
                .map(|_| json!(null))
        ),
        "NOT_FOUND"
    );
}
