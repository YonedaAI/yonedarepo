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
    /// Plays the commit shards: records of commits built outside the authority, by id.
    shard: RefCell<HashMap<String, Value>>,
    now: RefCell<i64>,
}

impl Harness {
    fn new() -> Self {
        let h = Self {
            db: NativeStore::memory().unwrap(),
            objects: RefCell::default(),
            cached: RefCell::default(),
            shard: RefCell::default(),
            now: RefCell::new(1_700_000_000_000),
        };
        h.run(OWNER, json!({"op":"repo_init","name":"demo","object_store":"artifacts:test/demo","policy":{"required_checks":["unit"],"approvals":1,"check_posters":{"unit":["owner","token:ci"]}}})).unwrap();
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
            None if principal == "platform:projection" => c["_system"] = json!("projection"),
            None if principal == "platform:import" => c["_system"] = json!("import"),
            None if principal == "platform:merge" => c["_system"] = json!("merge"),
            None if principal == "platform:derive" => c["_system"] = json!("derive"),
            None if principal == "platform:commits" => c["_system"] = json!("commits"),
            None if principal == "platform:hooks" => c["_system"] = json!("hooks"),
            None if principal.starts_with("member:") => {
                let account = &principal["member:".len()..];
                c["_session"] = json!({"workspace": account, "principal": format!("user:{account}"), "human": true})
            }
            None if principal == "token:public" => {
                c["_token"] = json!("public-secret-0123456789abcdef0123456789")
            }
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
        self.commit_with(
            principal,
            parent,
            base_version,
            changes,
            read_set,
            json!({}),
        )
    }
    fn commit_with(
        &self,
        principal: &str,
        parent: Option<&str>,
        base_version: u64,
        changes: Value,
        read_set: Value,
        extra: Value,
    ) -> yoneda_core::Result<String> {
        let mut trees = serde_json::Map::new();
        loop {
            let mut command = json!({
                "op": "repo_prepare_commit", "parent": parent, "base_version": base_version,
                "changes": changes, "read_set": read_set, "trees": trees,
                "message": "change", "author": {"name": "Agent", "email": "agent@example.com"},
            });
            for (key, value) in extra.as_object().into_iter().flatten() {
                command[key] = value.clone();
            }
            let prepared = self.run(principal, command)?;
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
    // Same file written on both sides: a three-way merge decides (here add/add).
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_land","ref":"main","commit":same}))),
        "MERGE_REQUIRED"
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
        super::migration::MIGRATIONS.last().unwrap().0
    );
    // Upgraded repositories start live (not tombstoned).
    assert!(
        db.query(
            "SELECT id FROM repo_settings WHERE deleted_at IS NOT NULL",
            &[]
        )
        .unwrap()
        .is_empty()
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
    assert!(
        db.query("SELECT commit_id FROM object_projections", &[])
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

#[test]
fn commits_files_larger_than_short_field_limits() {
    let (h, root) = seeded();
    let large = "x".repeat(200_000);
    let id = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("big.txt", &large), file("empty.txt", "")]),
            json!([]),
        )
        .unwrap();
    let paths = h.ok(OWNER, json!({"op":"repo_commit","commit":id}))["paths"].clone();
    assert_eq!(paths.as_array().unwrap().len(), 2);
}

#[test]
fn ref_projection_tracks_targets_leases_and_drift() {
    let (h, root) = seeded();
    const PROJECTOR: &str = "platform:projection";
    let pending = |h: &Harness| {
        h.run(PROJECTOR, json!({"op":"repo_projection_pending"}))
            .unwrap()["pending"]
            .clone()
    };
    assert_eq!(pending(&h)[0]["target_commit"], root);
    assert_eq!(pending(&h)[0]["projected_commit"], Value::Null);
    assert_eq!(
        code(h.run(AGENT, json!({"op":"repo_projection_pending"}))),
        "FORBIDDEN"
    );
    h.run(PROJECTOR, json!({"op":"repo_projection_result","refname":"refs/heads/main","version":1,"outcome":"ok","commit":root})).unwrap();
    assert_eq!(pending(&h), json!([]));

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
    assert_eq!(
        pending(&h)[0]["projected_commit"],
        root,
        "the last projected value is the lease"
    );
    // A late result for an older version never regresses the projection.
    let late = h.run(PROJECTOR, json!({"op":"repo_projection_result","refname":"refs/heads/main","version":0,"outcome":"ok","commit":root})).unwrap();
    assert_eq!(late["ignored"], true);
    h.run(PROJECTOR, json!({"op":"repo_projection_result","refname":"refs/heads/main","version":2,"outcome":"drift","detail":"stale info"})).unwrap();
    assert_eq!(pending(&h), json!([]), "drift waits for an owner");
    let status = h.ok(OWNER, json!({"op":"repo_status"}));
    assert_eq!(status["projections"][0]["status"], "drift");
    assert_eq!(status["projections"][0]["detail"], "stale info");
}

#[test]
fn imported_history_lands_with_a_truncated_boundary() {
    let h = Harness::new();
    const IMPORTER: &str = "platform:import";
    let blob = |t: &str| yoneda_core::git_object::hash_object(ObjectKind::Blob, t.as_bytes());
    let (boundary, first, second) = ("a".repeat(40), "b".repeat(40), "c".repeat(40));
    let record = |id: &str, parents: Value, touches: Value| {
        h.run(
            IMPORTER,
            json!({"op":"repo_record_imported","commit":id,"tree":"d".repeat(40),
            "parents":parents,"message":"imported","touches":touches}),
        )
    };
    // Owners and tokens cannot declare imported commits.
    assert_eq!(code(h.run(OWNER, json!({"op":"repo_record_imported","commit":first,"tree":"d".repeat(40),"parents":[],"touches":[]}))), "FORBIDDEN");
    record(
        &first,
        json!([boundary]),
        json!([{"path":"a.txt","op":"add","old_blob":null,"new_blob":blob("a")}]),
    )
    .unwrap();
    let second_row = record(
        &second,
        json!([first]),
        json!([{"path":"a.txt","op":"modify","old_blob":blob("a"),"new_blob":blob("b")}]),
    )
    .unwrap();
    assert_eq!(second_row["generation"], 2);
    assert_eq!(
        record(&second, json!([first]), json!([])).unwrap()["already"],
        true
    );
    assert_eq!(
        h.run(
            IMPORTER,
            json!({"op":"repo_import","ref":"main","commit":second})
        )
        .unwrap()["version"],
        1
    );
    let log = h.ok(OWNER, json!({"op":"repo_log","ref":"main"}));
    assert_eq!(
        log["commits"].as_array().unwrap().len(),
        2,
        "the walk stops at the import boundary"
    );
    assert_eq!(
        h.ok(
            OWNER,
            json!({"op":"repo_merge_base","left":second,"right":first})
        )["merge_bases"][0]["commit"],
        first
    );
    assert_eq!(
        code(record(&"e".repeat(40), json!([]), json!([]))),
        "ALREADY_EXISTS"
    );
}

#[test]
fn verified_platform_merges_land_under_the_merged_commits_gates() {
    let (h, root) = seeded();
    const MERGER: &str = "platform:merge";
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
    h.approve_and_check(&docs);
    h.approve_and_check(&src);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":docs}));
    let plan = h.ok(
        CI,
        json!({"op":"repo_merge_plan","ref":"main","commit":src}),
    );
    assert_eq!(
        (
            plan["outcome"].as_str(),
            plan["head"].as_str(),
            plan["base"].as_str()
        ),
        (Some("rebase"), Some(docs.as_str()), Some(root.as_str()))
    );
    let lib = yoneda_core::git_object::hash_object(ObjectKind::Blob, b"pub fn b() {}\n");
    let take = json!([{"path": "src/lib.rs", "blob": lib, "type": "blob"}]);
    let merge = |principal: &str, changes: Value| {
        h.commit_with(
            principal,
            Some(&docs),
            2,
            changes,
            json!([]),
            json!({"merge_parent": src}),
        )
    };
    // Only platform merges land under the merged commit's gates, and only with its paths.
    let rogue = merge(AGENT, take.clone()).unwrap();
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_land","ref":"main","commit":src,"merge":rogue})
        )),
        "FORBIDDEN"
    );
    let mut extra = take.as_array().unwrap().clone();
    extra.push(file("smuggled.txt", "x\n"));
    let sneaky = merge(MERGER, json!(extra)).unwrap();
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_land","ref":"main","commit":src,"merge":sneaky})
        )),
        "FORBIDDEN"
    );
    let merged = merge(MERGER, take).unwrap();
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_commit","commit":merged}))["parents"],
        json!([docs, src])
    );
    let landed = h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":src,"merge":merged}),
    );
    assert_eq!(
        (landed["version"].as_u64(), landed["merged"].as_str()),
        (Some(3), Some(src.as_str()))
    );
    let entry = &h.ok(OWNER, json!({"op":"repo_txlog"}))["entries"][2];
    assert_eq!(
        (entry["kind"].as_str(), entry["new"].as_str()),
        (Some("merge"), Some(merged.as_str()))
    );
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_commit","commit":src}))["landings"][0]["version"],
        3
    );
    // The same merge cannot land again on a moved head.
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_land","ref":"main","commit":src,"merge":merged})
        )),
        "OK"
    );
}

#[test]
fn time_travel_replays_from_verified_checkpoints() {
    use crate::storage::SqlStore;
    let (h, root) = seeded();
    let mut head = root.clone();
    for i in 0..70 {
        let next = h
            .commit(
                AGENT,
                Some(&head),
                i + 1,
                json!([file("n.txt", &format!("{i}\n"))]),
                json!([]),
            )
            .unwrap();
        h.approve_and_check(&next);
        h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":next}));
        head = next;
    }
    let checkpoints =
        h.db.query("SELECT version FROM txlog_checkpoints", &[])
            .unwrap();
    assert_eq!(checkpoints, vec![json!({"version": 64})]);
    let at = |v: u64| h.run(OWNER, json!({"op":"repo_snapshot","ref":"main","at":v}));
    let at66 = at(66).unwrap()["commit"].clone();
    let at3 = at(3).unwrap()["commit"].clone();
    assert_ne!(at66, at3);
    // A checkpoint that disagrees with the log is refused, not trusted.
    h.db.query("UPDATE txlog_checkpoints SET checkpoint=replace(checkpoint,'\"chain\":\"','\"chain\":\"x')", &[]).unwrap();
    assert_eq!(code(at(66)), "TXLOG_INVALID");
    assert_eq!(
        code(at(71)),
        "TXLOG_INVALID",
        "explicit time travel always verifies"
    );
    let current = h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}));
    assert_eq!(
        current["commit"],
        json!(head),
        "current reads use the refs table"
    );
}

#[test]
fn queued_landings_batch_under_a_fenced_lease() {
    let (h, root) = seeded();
    const MERGER: &str = "platform:merge";
    let make = |path: &str, read: Value| {
        let id = h
            .commit(AGENT, Some(&root), 1, json!([file(path, "x\n")]), read)
            .unwrap();
        h.approve_and_check(&id);
        id
    };
    let (first, a, b, stale) = (
        make("f.txt", json!([])),
        make("a.txt", json!([])),
        make("b.txt", json!([])),
        make("s.txt", json!(["f.txt"])),
    );
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":first}));
    let tickets: Vec<Value> = [&a, &b, &stale]
        .iter()
        .map(|c| {
            h.ok(
                OWNER,
                json!({"op":"repo_land_enqueue","ref":"main","commit":c}),
            )["ticket"]
                .clone()
        })
        .collect();
    // While work is queued, a direct landing joins the queue instead of jumping it.
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_land","ref":"main","commit":a}))),
        "MERGE_REQUIRED"
    );
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_land_claim","ref":"main"}))),
        "FORBIDDEN"
    );
    let claim = h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}));
    assert_eq!(
        claim["items"].as_array().unwrap().len(),
        2,
        "the stale read failed at claim time"
    );
    let failed = h.ok(OWNER, json!({"op":"repo_land_status","ticket":tickets[2]}));
    assert_eq!(
        (failed["status"].as_str(), failed["result"]["code"].as_str()),
        (Some("failed"), Some("CONFLICT"))
    );
    assert!(
        h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}))["wait"] == true,
        "the lease is held"
    );
    // A waiter polling with its ticket learns a settled outcome from the claim itself.
    let settled = h.ok(
        MERGER,
        json!({"op":"repo_land_claim","ref":"main","ticket":tickets[2]}),
    );
    assert_eq!(settled["settled"]["status"], "failed");
    assert!(
        h.ok(
            MERGER,
            json!({"op":"repo_land_claim","ref":"main","ticket":tickets[0]})
        )["wait"]
            == true
    );
    let blob = |t: &str| yoneda_core::git_object::hash_object(ObjectKind::Blob, t.as_bytes());
    let merge = h
        .commit_with(MERGER, Some(&first), 2,
            json!([{"path":"a.txt","blob":blob("x\n"),"type":"blob"},{"path":"b.txt","blob":blob("x\n"),"type":"blob"}]),
            json!([]), json!({"merge_parents": [a, b]}))
        .unwrap();
    let batch = |head: &str| {
        h.run(MERGER, json!({"op":"repo_land_batch","ref":"main","epoch":claim["epoch"],"head":head,"merge":merge,"landed":[tickets[0], tickets[1]]}))
    };
    // Compare-and-swap: a batch built on any other head is refused and rebuilt.
    assert_eq!(code(batch(&a)), "STALE_HEAD");
    let landed = batch(claim["head"].as_str().unwrap()).unwrap();
    assert_eq!(landed["version"], 3);
    for (ticket, commit) in [(&tickets[0], &a), (&tickets[1], &b)] {
        assert_eq!(
            h.ok(OWNER, json!({"op":"repo_land_status","ticket":ticket}))["status"],
            "landed"
        );
        assert_eq!(
            h.ok(OWNER, json!({"op":"repo_commit","commit":commit}))["landings"][0]["version"],
            3
        );
    }
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_commit","commit":merge}))["parents"],
        json!([first, a, b])
    );
    assert_eq!(
        h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}))["empty"],
        true,
        "lease released"
    );
}

#[test]
fn path_history_bisect_and_vacuum_follow_the_log() {
    use crate::storage::SqlStore;
    let (h, root) = seeded();
    let mut set = runner_policy(60);
    set["policy"]["required_checks"] = json!([]);
    set["policy"]["approvals"] = json!(0);
    set["op"] = json!("repo_set_policy");
    h.ok(OWNER, set);
    // Eight commits on main; the fifth breaks the "unit" check.
    let mut chain = vec![root.clone()];
    for i in 1..=8 {
        let id = h
            .commit(
                AGENT,
                chain.last().map(String::as_str),
                i,
                json!([file("n.txt", &format!("{i}\n"))]),
                json!([]),
            )
            .unwrap();
        h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
        chain.push(id);
    }
    let history = h.ok(
        CI,
        json!({"op":"repo_path_history","ref":"main","path":"n.txt"}),
    );
    assert_eq!(history["commits"].as_array().unwrap().len(), 8);
    assert_eq!(history["commits"][0]["commit"], json!(chain[8]));
    // As of an earlier version (time travel, like log): main's head then, and its past.
    let landed = |id: &str| {
        h.ok(CI, json!({"op":"repo_commit","commit":id}))["landings"][0]["version"]
            .as_u64()
            .unwrap()
    };
    let then = h.ok(
        CI,
        json!({"op":"repo_path_history","ref":"main","path":"n.txt","at":landed(&chain[3])}),
    );
    assert_eq!(then["commits"].as_array().unwrap().len(), 3);
    assert_eq!(then["commits"][0]["commit"], json!(chain[3]));

    let mut step = h.ok(CI, json!({"op":"repo_bisect_start","ref":"main","check":"unit","good":chain[0],"bad":chain[8]}));
    let id = step["id"].as_str().unwrap().to_owned();
    let mut tested = 0;
    while step["status"] == "running" {
        let commit = step["testing"].as_str().unwrap().to_owned();
        let index = chain.iter().position(|c| *c == commit).unwrap();
        let run = step["runs"][0]["id"].as_str().unwrap().to_owned();
        let epoch = h.ok(SYSTEM, json!({"op":"repo_check_claim","run_id":run}))["epoch"].clone();
        let outcome = if index >= 5 { "fail" } else { "pass" };
        let done = h.ok(SYSTEM, json!({"op":"repo_check_complete","run_id":run,"epoch":epoch,"outcome":outcome,"evidence":{}}));
        assert_eq!(done["bisects"], json!([id]));
        step = h.ok(SYSTEM, json!({"op":"repo_bisect_step","id":id}));
        tested += 1;
    }
    assert_eq!(step["result"]["first_bad"], json!(chain[5]));
    assert!(
        tested <= 4,
        "bisect halves the range ({tested} checks for 8 commits)"
    );

    // Vacuum: landed work is covered only once its branch projection caught up; old
    // unlanded work expires unless pinned or still in flight.
    let orphan = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("o.txt", "o\n")]),
            json!([]),
        )
        .unwrap();
    let pinned = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("p.txt", "p\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_pin","commit":pinned,"reason":"long job"}),
    );
    *h.now.borrow_mut() += 8 * 24 * 60 * 60 * 1000;
    let plan = h.ok(OWNER, json!({"op":"repo_vacuum_plan"}));
    assert_eq!(plan["covered"], json!([]), "nothing is projected yet");
    let expired: Vec<String> = serde_json::from_value(plan["expired"].clone()).unwrap();
    assert!(
        expired.contains(&orphan) && !expired.contains(&pinned) && !expired.contains(&chain[8])
    );
    h.db.query("UPDATE ref_projections SET status='ok',projected_version=target_version,projected_commit=target_commit", &[]).unwrap();
    let covered: Vec<String> =
        serde_json::from_value(h.ok(OWNER, json!({"op":"repo_vacuum_plan"}))["covered"].clone())
            .unwrap();
    assert!(covered.contains(&chain[8]) && !covered.contains(&pinned));
    assert_eq!(
        code(h.run(AGENT, json!({"op":"repo_vacuum_plan"}))),
        "FORBIDDEN"
    );
    h.ok(OWNER, json!({"op":"repo_vacuum_done","commits":[orphan]}));
    let again: Vec<String> =
        serde_json::from_value(h.ok(OWNER, json!({"op":"repo_vacuum_plan"}))["expired"].clone())
            .unwrap();
    assert!(!again.contains(&orphan));
}

#[test]
fn auto_approval_follows_recorded_review_classes() {
    let (h, root) = seeded();
    const CLASSIFIER: &str = "platform:derive";
    h.ok(OWNER, json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":1,"auto_approve":["comment_only","docs"]}}));
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":1,"auto_approve":["logic"]}}))),
        "INVALID_INPUT"
    );
    let commit = |path: &str| {
        h.commit(AGENT, Some(&root), 1, json!([file(path, "x\n")]), json!([]))
            .unwrap()
    };
    let (comment, unknown, unclassified) =
        (commit("src/a.rs"), commit("data.bin"), commit("src/b.rs"));
    let record = |id: &str, overall: &str, files: Value| {
        h.run(
            CLASSIFIER,
            json!({"op":"repo_record_classes","commit":id,"overall":overall,"files":files}),
        )
    };
    assert_eq!(
        code(h.run(
            AGENT,
            json!({"op":"repo_record_classes","commit":comment,"overall":"docs","files":[]})
        )),
        "FORBIDDEN"
    );
    record(
        &comment,
        "comment_only",
        json!([{"path":"src/a.rs","class":"comment_only"}]),
    )
    .unwrap();
    record(
        &unknown,
        "unknown",
        json!([{"path":"data.bin","class":"unknown"}]),
    )
    .unwrap();
    let gates = |id: &str| h.ok(OWNER, json!({"op":"repo_commit","commit":id}))["gates"].clone();
    assert_eq!(
        (
            gates(&comment)["ready"].as_bool(),
            gates(&comment)["auto_approved"].as_bool()
        ),
        (Some(true), Some(true))
    );
    assert_eq!(gates(&unknown)["ready"], false, "unknown is never safe");
    assert_eq!(
        gates(&unclassified)["ready"],
        false,
        "unclassified needs a human"
    );
    // A recorded class is immutable.
    record(
        &comment,
        "logic",
        json!([{"path":"src/a.rs","class":"logic"}]),
    )
    .unwrap();
    assert_eq!(gates(&comment)["review_class"], "comment_only");
}

#[test]
fn directory_grants_bound_writes_reviews_landings_and_reads() {
    let (h, root) = seeded();
    const PUBLIC: &str = "token:public";
    h.ok(OWNER, json!({"op":"repo_token_create","name":"public","scopes":["read","write","review","land","check"],
        "paths":["docs/"],"_secret":"public-secret-0123456789abcdef0123456789"}));
    assert_eq!(code(h.run(OWNER, json!({"op":"repo_token_create","name":"bad","scopes":["read"],"paths":["../x"],"_secret":"bad-secret-0123456789abcdef0123456789xx"}))), "UNSAFE_PATH");
    assert_eq!(
        h.ok(PUBLIC, json!({"op":"repo_status"}))["grant"],
        json!(["docs/"])
    );
    assert_eq!(
        code(
            h.commit(
                PUBLIC,
                Some(&root),
                1,
                json!([file("src/lib.rs", "x\n")]),
                json!([])
            )
            .map(|_| json!(null))
        ),
        "FORBIDDEN"
    );
    let docs = h
        .commit(
            PUBLIC,
            Some(&root),
            1,
            json!([file("docs/a.md", "a\n")]),
            json!([]),
        )
        .unwrap();
    // A commit touching hidden paths cannot be reviewed, checked or landed by this token.
    let mixed = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("docs/b.md", "b\n"), file("src/lib.rs", "y\n")]),
            json!([]),
        )
        .unwrap();
    for op in ["repo_review", "repo_land", "repo_check"] {
        let mut command = json!({"op": op, "commit": mixed, "ref": "main", "decision": "approve", "name": "unit", "status": "pass"});
        command["op"] = json!(op);
        assert_eq!(code(h.run(PUBLIC, command)), "FORBIDDEN", "{op}");
    }
    // Reads list only granted paths.
    let detail = h.ok(PUBLIC, json!({"op":"repo_commit","commit":mixed}));
    assert_eq!(
        detail["paths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["path"].clone())
            .collect::<Vec<_>>(),
        vec![json!("docs/b.md")]
    );
    h.approve_and_check(&mixed);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":mixed}));
    let txlog = h.ok(PUBLIC, json!({"op":"repo_txlog"}));
    assert!(
        txlog["entries"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|e| e["paths"].as_array().unwrap().clone())
            .all(|p| p["path"].as_str().unwrap().starts_with("docs/"))
    );
    assert_eq!(
        code(h.run(
            PUBLIC,
            json!({"op":"repo_path_history","ref":"main","path":"src/lib.rs"})
        )),
        "FORBIDDEN"
    );
    assert_eq!(
        code(h.run(PUBLIC, json!({"op":"repo_check_run","run_id":"cr_x"}))),
        "FORBIDDEN"
    );
    // Within the grant, the token works normally.
    h.ok(
        OWNER,
        json!({"op":"repo_check","commit":docs,"name":"unit","status":"pass"}),
    );
    h.ok(
        OWNER,
        json!({"op":"repo_review","commit":docs,"decision":"approve"}),
    );
    assert_eq!(
        code(h.run(PUBLIC, json!({"op":"repo_land","ref":"main","commit":docs}))),
        "MERGE_REQUIRED"
    );
}

#[test]
fn symbol_reads_conflict_only_with_derived_writes_to_those_symbols() {
    let (h, root) = seeded();
    const DERIVER: &str = "platform:derive";
    let edit = |reads: Value| {
        let id = h
            .commit(
                AGENT,
                Some(&root),
                1,
                json!([file("src/lib.rs", "pub fn a() { 1; }\n")]),
                reads,
            )
            .unwrap();
        h.approve_and_check(&id);
        id
    };
    let writer = edit(json!([]));
    let reads_other = edit(json!(["src/lib.rs#b"]));
    let reads_a = edit(json!(["src/lib.rs#a"]));
    let reads_file = edit(json!(["src/lib.rs"]));
    // Only the platform deriver records symbol writes, and only for changed paths.
    let record = |principal: &str, path: &str| {
        h.run(principal, json!({"op":"repo_record_symbols","commit":writer,"touches":[{"path":path,"symbols":["a"]}]}))
    };
    assert_eq!(code(record(AGENT, "src/lib.rs")), "FORBIDDEN");
    assert_eq!(code(record(DERIVER, "README.md")), "INVALID_INPUT");
    record(DERIVER, "src/lib.rs").unwrap();
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_commit","commit":writer}))["symbol_touches"],
        json!([{"path":"src/lib.rs","symbols":["a"]}])
    );
    h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":writer}),
    );
    let land = |id: &str| code(h.run(OWNER, json!({"op":"repo_land","ref":"main","commit":id})));
    // Another symbol of the same file: a three-way merge, not a stale read.
    assert_eq!(land(&reads_other), "MERGE_REQUIRED");
    assert_eq!(land(&reads_a), "CONFLICT");
    assert_eq!(land(&reads_file), "CONFLICT");
    // Planning sees the same stale reads.
    let stale = h.ok(
        AGENT,
        json!({"op":"repo_stale_reads","ref":"main","items":[
        {"id":"x","base_version":1,"read_set":["src/lib.rs#b"]},
        {"id":"y","base_version":1,"read_set":["src/lib.rs#a"]},
        {"id":"z","read_set":["src/lib.rs"]}]}),
    );
    assert_eq!(
        stale["stale"],
        json!([{"id":"y","version":2,"entries":["src/lib.rs#a"]}])
    );
}

#[test]
fn contract_records_bind_to_commit_and_digest_and_respect_grants() {
    let (h, root) = seeded();
    let digest = "a".repeat(64);
    let record = |principal: &str, path: &str, contract: Value| {
        h.run(
            principal,
            json!({"op":"repo_record_contract","commit":root,"path":path,
            "symbol_path":"a","node_digest":digest,"contract":contract}),
        )
    };
    let first = record(AGENT, "src/lib.rs", json!({"summary":"Does a."})).unwrap();
    assert_eq!(
        (first["seq"].as_i64(), first["already"].as_bool()),
        (Some(1), Some(false))
    );
    // A retried write is the same record; a changed contract is a new one.
    assert_eq!(
        record(AGENT, "src/lib.rs", json!({"summary":"Does a."})).unwrap()["already"],
        true
    );
    record(
        AGENT,
        "src/lib.rs",
        json!({"summary":"Does a, carefully.","effects":["writes logs"]}),
    )
    .unwrap();
    for (bad, expected) in [
        (json!({"summary":"x","extra":1}), "INVALID_INPUT"),
        (json!({}), "INVALID_INPUT"),
    ] {
        assert_eq!(code(record(AGENT, "src/lib.rs", bad)), expected);
    }
    assert_eq!(
        code(record(CI, "src/lib.rs", json!({"summary":"x"}))),
        "FORBIDDEN"
    );
    assert_eq!(
        code(record(AGENT, "../etc", json!({"summary":"x"}))),
        "UNSAFE_PATH"
    );
    assert_eq!(
        code(h.run(
            AGENT,
            json!({"op":"repo_record_contract","commit":"b".repeat(40),"path":"src/lib.rs",
        "symbol_path":"a","node_digest":digest,"contract":{"summary":"x"}})
        )),
        "NOT_FOUND"
    );
    assert_eq!(
        code(h.run(
            AGENT,
            json!({"op":"repo_record_contract","commit":root,"path":"src/lib.rs",
        "symbol_path":"a","node_digest":"short","contract":{"summary":"x"}})
        )),
        "INVALID_INPUT"
    );
    let listed = h.ok(
        CI,
        json!({"op":"repo_contracts","paths":["src/lib.rs","README.md"]}),
    );
    let summaries: Vec<&str> = listed["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["contract"]["summary"].as_str().unwrap())
        .collect();
    assert_eq!(summaries, ["Does a.", "Does a, carefully."]);
    assert_eq!(listed["records"][0]["commit"], json!(root));
    assert_eq!(listed["records"][0]["node_digest"], json!(digest));
    // Time travel: before the records' log version they did not exist yet.
    assert!(
        h.ok(
            CI,
            json!({"op":"repo_contracts","paths":["src/lib.rs"],"at":0})
        )["records"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    // Directory grants: no writes and no reads outside the grant, not even by listing.
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"public","scopes":["read","write"],
        "paths":["docs/"],"_secret":"public-secret-0123456789abcdef0123456789"}),
    );
    assert_eq!(
        code(record("token:public", "src/lib.rs", json!({"summary":"x"}))),
        "FORBIDDEN"
    );
    assert_eq!(
        code(h.run(
            "token:public",
            json!({"op":"repo_contracts","paths":["src/lib.rs"]})
        )),
        "FORBIDDEN"
    );
    assert!(
        h.ok(
            "token:public",
            json!({"op":"repo_contracts","paths":["docs/a.md"]})
        )["records"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

mod account_access;
mod batches;
mod branch_policy;
mod branches;
mod break_glass;
mod bundles;
mod change_records;
mod changes;
mod changesets;
mod check_posters;
mod check_release;
mod checkpoints;
mod compaction;
mod compaction_writes;
mod git_shallow;
mod hooks;
mod land_cas;
mod land_shapes;
mod members;
mod model_runner;
mod orgs;
mod pushed;
mod rebase;
mod releases;
mod secrets;
mod sessions;
mod shards;
mod staging;
mod tags;
