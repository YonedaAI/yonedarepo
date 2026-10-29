//! Forks: a fork copies the commits its parent's refs reach (never an unlanded or refused
//! commit) and the refs themselves, in steps only the platform runs; a writer of the fork
//! offers a branch, whose new commits the parent records and mirrors as
//! `forks/<fork>/<branch>`, and a reader of the parent opens a change on that mirror that
//! lands like any other. A parent with forks refuses deletion until they are forgotten.
//! The fork columns and tables arrive by an additive migration.
use super::*;
use crate::storage::SqlStore;

const FORK_ID: &str = "r00000000000000000f01";
const PARENT_ID: &str = "r00000000000000000a01";
const IMPORTER: &str = "platform:import";
const FORKER: &str = "platform:fork";

/// The fork's authority: its own database, initialized with the parent, and the parent's
/// objects visible (as the adapter's reads fall back to the parent's store).
fn fork_of(parent: &Harness, version: u64) -> Harness {
    let h = Harness {
        db: Counted::new(NativeStore::memory().unwrap()),
        objects: RefCell::new(parent.objects.borrow().clone()),
        object_reads: Cell::default(),
        cached: RefCell::new(parent.cached.borrow().clone()),
        shard: RefCell::default(),
        now: RefCell::new(*parent.now.borrow()),
    };
    h.ok(OWNER, json!({"op":"repo_init","name":"demo-fork","object_store":"r2:yr-fork",
        "parent":{"repo":PARENT_ID,"version":version},
        "policy":{"required_checks":["unit"],"approvals":1,"check_posters":{"unit":["owner","token:ci"]}}}));
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"agent","scopes":["read","write"],
        "_secret":"agent-secret-0123456789abcdef0123456789"}),
    );
    h
}

/// Runs the fork job: source, every export page, record, refs.
fn fork(parent: &Harness) -> Harness {
    let source = parent.ok(AGENT, json!({"op":"repo_fork_source"}));
    let version = source["version"].as_u64().unwrap();
    let fork = fork_of(parent, version);
    let mut after = Value::Null;
    loop {
        let page = parent.ok(
            AGENT,
            json!({"op":"repo_fork_export","version":version,"after":after}),
        );
        fork.ok(
            IMPORTER,
            json!({"op":"repo_fork_record","commits":page["commits"]}),
        );
        if page["next"].is_null() {
            break;
        }
        after = page["next"].clone();
    }
    fork.ok(
        IMPORTER,
        json!({"op":"repo_fork_refs","refs":source["refs"]}),
    );
    parent.ok(FORKER, json!({"op":"repo_fork_register","fork":FORK_ID}));
    fork
}

fn set_branch(h: &Harness, branch: &str, commit: &str) {
    let current =
        h.ok(AGENT, json!({"op":"repo_refs"}))["refs"][format!("refs/heads/{branch}")].clone();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":branch,"commit":commit,"expected":current}]}),
    );
}

fn count(h: &Harness, sql: &str) -> u64 {
    h.db.query(sql, &[]).unwrap()[0]["n"].as_u64().unwrap()
}

#[test]
fn a_fork_copies_what_the_refs_reach_and_nothing_else() {
    let (parent, root) = seeded();
    let wip = parent
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("wip.rs", "1\n")]),
            json!([]),
        )
        .unwrap();
    set_branch(&parent, "wip", &wip);
    // Recorded but on no ref: a fork must never carry it.
    let stray = parent
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("secret.txt", "s\n")]),
            json!([]),
        )
        .unwrap();
    let fork = fork(&parent);
    let status = fork.ok(OWNER, json!({"op":"repo_status"}));
    assert_eq!(status["parent"]["repo"], PARENT_ID);
    assert_eq!(parent.ok(OWNER, json!({"op":"repo_status"}))["forks"], 1);
    let refs = fork.ok(AGENT, json!({"op":"repo_refs"}))["refs"].clone();
    assert_eq!(refs["refs/heads/main"], root);
    assert_eq!(refs["refs/heads/wip"], wip);
    assert_eq!(
        count(
            &fork,
            "SELECT COUNT(*) AS n FROM commits WHERE origin='fork'"
        ),
        2
    );
    assert_eq!(
        code(fork.run(OWNER, json!({"op":"repo_commit","commit":stray}))),
        "NOT_FOUND"
    );
    // Paths and objects travel with each commit; the unprojected one keeps its object list.
    assert_eq!(
        fork.ok(OWNER, json!({"op":"repo_commit","commit":wip}))["paths"][0]["path"],
        "wip.rs"
    );
    assert_eq!(count(&fork, "SELECT COUNT(*) AS n FROM fork_origin"), 2);
    // Only the platform fills a fork, and only before it has refs.
    assert_eq!(
        code(fork.run(OWNER, json!({"op":"repo_fork_record","commits":[]}))),
        "FORBIDDEN"
    );
    assert_eq!(
        code(fork.run(IMPORTER, json!({"op":"repo_fork_record","commits":[]}))),
        "ALREADY_EXISTS"
    );
    assert_eq!(
        code(parent.run(OWNER, json!({"op":"repo_fork_register","fork":FORK_ID}))),
        "FORBIDDEN"
    );
    // A path-restricted token cannot read a whole repository to fork it.
    parent.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read"],"paths":["docs/"],
        "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    assert_eq!(
        code(parent.run("token:docs", json!({"op":"repo_fork_source"}))),
        "FORBIDDEN"
    );
}

#[test]
fn export_pages_follow_generation_order() {
    let (parent, mut tip) = seeded();
    for n in 0..3 {
        tip = parent
            .commit(
                AGENT,
                Some(&tip),
                1,
                json!([file("n.txt", &format!("{n}\n"))]),
                json!([]),
            )
            .unwrap();
    }
    set_branch(&parent, "long", &tip);
    let version = parent.ok(AGENT, json!({"op":"repo_fork_source"}))["version"].clone();
    let page = parent.ok(AGENT, json!({"op":"repo_fork_export","version":version}));
    let generations: Vec<u64> = page["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["generation"].as_u64().unwrap())
        .collect();
    assert_eq!(generations, vec![1, 2, 3, 4]);
    assert!(page["next"].is_null());
    let rest = parent.ok(
        AGENT,
        json!({"op":"repo_fork_export","version":version,"after":[2, "f".repeat(40)]}),
    );
    assert_eq!(rest["commits"].as_array().unwrap().len(), 2);
}

#[test]
fn a_change_from_a_fork_lands_on_the_parent() {
    let (parent, root) = seeded();
    let fork = fork(&parent);
    let feature = fork
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/fork.rs", "forked\n")]),
            json!([]),
        )
        .unwrap();
    set_branch(&fork, "feature", &feature);
    // A writer of the fork offers; a reader of the fork cannot.
    fork.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"viewer","scopes":["read"],
        "_secret":"viewer-secret-0123456789abcdef0123456789"}),
    );
    assert_eq!(
        code(fork.run(
            "token:viewer",
            json!({"op":"repo_fork_offer","branch":"feature"})
        )),
        "FORBIDDEN"
    );
    let offer = fork.ok(AGENT, json!({"op":"repo_fork_offer","branch":"feature"}));
    assert_eq!(offer["parent"], PARENT_ID);
    assert_eq!(offer["head"], feature);
    assert_eq!(
        code(parent.run(AGENT, json!({"op":"repo_fork_offer","branch":"main"}))),
        "INVALID_INPUT"
    );
    // The commits the parent lacks: only the new one (the copied main is common).
    let carried = fork.ok(
        FORKER,
        json!({"op":"repo_fork_branch","branch":"feature","haves":[root]}),
    );
    let commits = carried["commits"].as_array().unwrap();
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0]["touches"][0]["path"], "src/fork.rs");
    let pushed: Vec<Value> = commits
        .iter()
        .map(|c| {
            let id = c["commit"].as_str().unwrap();
            json!({"commit": id, "data_b64": STANDARD.encode(&fork.objects.borrow()[id].1),
                "touches": c["touches"], "objects": [{"id": id, "kind": "commit"}], "check": false})
        })
        .collect();
    assert_eq!(
        code(parent.run(
            AGENT,
            json!({"op":"repo_fork_mirror","fork":FORK_ID,"branch":"feature","commit":feature})
        )),
        "FORBIDDEN"
    );
    parent.ok(FORKER, json!({"op":"repo_record_pushed","commits":pushed}));
    let mirror = parent.ok(
        FORKER,
        json!({"op":"repo_fork_mirror","fork":FORK_ID,"branch":"feature","commit":feature}),
    );
    let branch = format!("forks/{FORK_ID}/feature");
    assert_eq!(mirror["ref"], format!("refs/heads/{branch}"));
    // A reader of the parent opens the change on the mirror, and only there.
    parent.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"reader","scopes":["read"],
        "_secret":"reader-secret-0123456789abcdef0123456789"}),
    );
    let open = |source: &str, branch: &str| {
        parent.run(
            "token:reader",
            json!({"op":"repo_change_create","branch":branch,"title":"From a fork",
                "source_repo":FORK_ID,"source_branch":source}),
        )
    };
    assert_eq!(code(open("other", &branch)), "INVALID_INPUT");
    assert_eq!(
        code(parent.run(
            "token:reader",
            json!({"op":"repo_change_create","branch":branch,"title":"No source"})
        )),
        "FORBIDDEN"
    );
    let change = open("feature", &branch).unwrap();
    assert_eq!(change["source_repo"], FORK_ID);
    assert_eq!(change["head"], feature);
    parent.approve_and_check(&feature);
    parent.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":feature}),
    );
    let landed = parent.ok(
        OWNER,
        json!({"op":"repo_change_show","number":change["number"]}),
    );
    assert_eq!(landed["status"], "landed");
    assert_eq!(
        parent.ok(OWNER, json!({"op":"repo_refs"}))["refs"]["refs/heads/main"],
        feature
    );
    // Moving the mirror again to the same head is a no-op.
    assert_eq!(
        parent.ok(
            FORKER,
            json!({"op":"repo_fork_mirror","fork":FORK_ID,"branch":"feature","commit":feature})
        )["already"],
        true
    );
}

#[test]
fn a_parent_with_forks_is_not_deleted_until_they_are_forgotten() {
    let (parent, _) = seeded();
    let fork = fork(&parent);
    assert_eq!(
        code(parent.run(OWNER, json!({"op":"repo_delete","confirm":"demo"}))),
        "CONFLICT"
    );
    let deleted = fork.ok(OWNER, json!({"op":"repo_delete","confirm":"demo-fork"}));
    assert_eq!(deleted["parent"], PARENT_ID);
    assert_eq!(
        parent.ok(FORKER, json!({"op":"repo_fork_forget","fork":FORK_ID}))["forks"],
        0
    );
    parent.ok(OWNER, json!({"op":"repo_delete","confirm":"demo"}));
}

#[test]
fn upgrades_from_the_bundles_schema_with_no_parent_and_no_forks() {
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..30])
        .unwrap();
    db.query("INSERT INTO repo_settings(id,workspace,owner,object_store,policy,policy_digest,created_at) VALUES('repository','ws-1','user:owner','r2','{}','d',1)", &[]).unwrap();
    db.query("INSERT INTO changes(title,body,branch,author,status,created_at,updated_at) VALUES('t','','fix','user:owner','open',1,1)", &[]).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    let settings = &db
        .query("SELECT parent,parent_version FROM repo_settings", &[])
        .unwrap()[0];
    assert!(settings["parent"].is_null() && settings["parent_version"].is_null());
    assert!(db.query("SELECT source_repo FROM changes", &[]).unwrap()[0]["source_repo"].is_null());
    assert!(db.query("SELECT repo FROM forks", &[]).unwrap().is_empty());
    assert!(
        db.query("SELECT refname FROM fork_origin", &[])
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        db.query("SELECT MAX(version) AS v FROM repo_schema_migrations", &[])
            .unwrap()[0]["v"],
        migrations.last().unwrap().0
    );
}

#[test]
fn a_forks_lfs_downloads_name_its_parent_and_its_quota_is_its_own() {
    let (parent, _) = seeded();
    let fork = fork(&parent);
    let object = json!([{"oid": "ab".repeat(32), "size": 10}]);
    parent.ok(
        AGENT,
        json!({"op":"repo_lfs_batch","operation":"upload","objects":object}),
    );
    parent.ok(
        AGENT,
        json!({"op":"repo_lfs_store","oid":"ab".repeat(32),"size":10}),
    );
    // The fork lacks it and names where the adapter may look (with the caller's own access).
    let down = fork.ok(
        AGENT,
        json!({"op":"repo_lfs_batch","operation":"download","objects":object}),
    );
    assert_eq!(down["objects"][0]["error"]["code"], 404);
    assert_eq!(down["parent"], PARENT_ID);
    let up = fork.ok(
        AGENT,
        json!({"op":"repo_lfs_batch","operation":"upload","objects":object}),
    );
    assert_eq!(up["parent"], Value::Null);
    // The parent's object is not the fork's: nothing of it counts against the fork's quota.
    assert_eq!(
        fork.ok(OWNER, json!({"op":"repo_lfs_usage"}))["stored_bytes"],
        0
    );
    assert_eq!(
        parent.ok(
            OWNER,
            json!({"op":"repo_lfs_batch","operation":"download","objects":object})
        )["parent"],
        Value::Null
    );
}

/// A parent writer moved the mirror off the fork branch's head; carrying the unchanged
/// branch again moves the mirror back (the head keeps its first landing there).
#[test]
fn carrying_again_moves_a_moved_mirror_back_to_the_fork_head() {
    let (parent, root) = seeded();
    let fork = fork(&parent);
    let feature = fork
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/fork.rs", "forked\n")]),
            json!([]),
        )
        .unwrap();
    set_branch(&fork, "feature", &feature);
    let id = feature.as_str();
    let pushed = json!([{"commit": id, "data_b64": STANDARD.encode(&fork.objects.borrow()[id].1),
        "touches": [{"path": "src/fork.rs", "op": "add", "old_blob": null,
            "new_blob": yoneda_core::git_object::hash_object(ObjectKind::Blob, b"forked\n"), "mode": "blob"}],
        "objects": [{"id": id, "kind": "commit"}], "check": false}]);
    parent.ok(FORKER, json!({"op":"repo_record_pushed","commits":pushed}));
    let mirror = || {
        parent.run(
            FORKER,
            json!({"op":"repo_fork_mirror","fork":FORK_ID,"branch":"feature","commit":feature}),
        )
    };
    let first = mirror().unwrap();
    let branch = format!("forks/{FORK_ID}/feature");
    parent.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":branch,"commit":root,"expected":feature}),
    );
    let again = mirror().unwrap_or_else(|e| panic!("{e}"));
    assert!(
        again["version"].as_u64() > first["version"].as_u64(),
        "{again}"
    );
    let refs = parent.ok(OWNER, json!({"op":"repo_refs"}));
    assert_eq!(refs["refs"][format!("refs/heads/{branch}")], json!(feature));
    let shown = parent.ok(OWNER, json!({"op":"repo_commit","commit":feature}));
    assert_eq!(
        shown["landings"].as_array().map(Vec::len),
        Some(1),
        "{shown}"
    );
}
