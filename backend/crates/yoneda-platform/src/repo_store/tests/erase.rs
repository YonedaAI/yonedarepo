//! Erasing a deleted repository: only the platform's erase job, only on a tombstone, only
//! once hooks are done or given up and no fork is left, in batches under a budget, resumable
//! at any step, and leaving nothing but the row that answers GONE.
use super::*;
use crate::repo_store::erase::{BYTE_BUDGET, ROW_BUDGET, wipe::TABLES};
use crate::repo_store::rows;
use crate::storage::SqlStore;

const ERASE: &str = "platform:erase";
const HOOKS: &str = "platform:hooks";
const REPO: &str = "r0123456789abcdef0123";
/// What the tombstone is: its row, and the record of the migrations that made its schema.
const KEPT: [&str; 2] = ["repo_settings", "repo_schema_migrations"];
const INDEXES: [&str; 5] = [
    "commit_text",
    "commit_path_text",
    "session_text",
    "change_text",
    "memory_text",
];

fn delete(h: &Harness) {
    h.ok(OWNER, json!({"op":"repo_delete","confirm":"demo"}));
}

fn plan(h: &Harness) -> Value {
    h.ok(ERASE, json!({"op":"repo_erase_plan"}))
}

fn count(h: &Harness, table: &str) -> i64 {
    h.db.query(&format!("SELECT COUNT(*) AS n FROM {table}"), &[])
        .unwrap()[0]["n"]
        .as_i64()
        .unwrap()
}

/// Index blocks of full-text table `table` holding `term`, whatever its rows say.
fn indexed(h: &Harness, table: &str, term: &str) -> i64 {
    h.db.query(
        &format!("SELECT COUNT(*) AS n FROM {table}_data WHERE instr(block,CAST(? AS BLOB))>0"),
        &[json!(term)],
    )
    .unwrap()[0]["n"]
        .as_i64()
        .unwrap()
}

/// Runs steps until the erase is done; answers how many it took.
fn finish(h: &Harness) -> usize {
    for steps in 1..100_000 {
        if h.ok(ERASE, json!({"op":"repo_erase_step"}))["done"] == true {
            return steps;
        }
    }
    panic!("the erase never finished");
}

/// A record in each table with its own full-text index, holding `secret`.
fn records(h: &Harness, commit: &str, secret: &str) {
    let (db, now) = (&h.db, json!(1));
    db.query(
        "INSERT INTO sessions(commit_id,cli,summary,recorded_by,at) VALUES(?,'cli',?,'agent',?)",
        &[json!(commit), json!(secret), now.clone()],
    )
    .unwrap();
    db.query(
        "INSERT INTO changes(title,body,branch,author,status,created_at,updated_at) VALUES(?,?,'x','agent','open',?,?)",
        &[json!(secret), json!(secret), now.clone(), now.clone()],
    )
    .unwrap();
    db.query(
        "INSERT INTO memories(kind,body,commit_id,author,recorded_at,recorded_version) VALUES('howto',?,?,'agent',?,1)",
        &[json!(secret), json!(commit), now],
    )
    .unwrap();
    db.query(
        "INSERT INTO memory_text(rowid,body) VALUES(last_insert_rowid(),?)",
        &[json!(secret)],
    )
    .unwrap();
    db.query(
        "INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,recorded_at) VALUES('1234',?,'[]',1,0,'agent',?,'[]',1)",
        &[json!(commit), json!(secret)],
    )
    .unwrap();
    db.query(
        "INSERT INTO commit_paths(commit_id,path,op) VALUES('1234',?,'add')",
        &[json!(secret)],
    )
    .unwrap();
}

/// Every table this binary's migrations create is erased or named as kept, so a new table
/// cannot be forgotten.
#[test]
fn every_table_is_erased_or_kept_on_purpose() {
    let h = Harness::new();
    let rows =
        h.db.query(
            "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            &[],
        )
        .unwrap();
    let virtuals: Vec<&str> = rows
        .iter()
        .filter(|r| r["sql"].as_str().is_some_and(|s| s.contains("VIRTUAL")))
        .map(|r| r["name"].as_str().unwrap())
        .collect();
    assert_eq!(virtuals.len(), 5, "{virtuals:?}");
    for table in rows.iter().map(|r| r["name"].as_str().unwrap()) {
        let shadow = virtuals.iter().any(|v| table.starts_with(&format!("{v}_")));
        let listed = TABLES.iter().any(|t| t.name == table);
        assert!(
            shadow || listed != KEPT.contains(&table),
            "{table} must be in exactly one of TABLES and KEPT"
        );
    }
}

#[test]
fn only_the_erase_job_erases_and_only_a_tombstone() {
    let (h, _) = seeded();
    for who in [OWNER, AGENT, "platform:projection", SYSTEM] {
        for op in ["repo_erase_plan", "repo_erase_step"] {
            assert_eq!(
                code(h.run(who, json!({"op":op}))),
                "FORBIDDEN",
                "{who} {op}"
            );
        }
    }
    // A live repository is never erased, whoever asks.
    assert_eq!(plan(&h)["live"], true);
    assert_eq!(
        code(h.run(ERASE, json!({"op":"repo_erase_step"}))),
        "NOT_FOUND"
    );
    assert!(count(&h, "commits") > 0);
    delete(&h);
    for who in [OWNER, SYSTEM] {
        assert_eq!(
            code(h.run(who, json!({"op":"repo_erase_step"}))),
            "GONE",
            "{who}"
        );
    }
    // Its tokens were revoked with the deletion.
    assert_eq!(
        code(h.run(AGENT, json!({"op":"repo_erase_step"}))),
        "UNAUTHORIZED"
    );
    assert!(count(&h, "commits") > 0);
}

#[test]
fn erases_every_record_and_keeps_only_the_tombstone() {
    let (h, root) = seeded();
    records(&h, &root, "hunter2");
    for table in INDEXES {
        assert_eq!(indexed(&h, table, "hunter2"), 1, "{table}");
    }
    delete(&h);
    let before = plan(&h)["db_bytes"].as_u64().unwrap();
    assert!(before > 0);
    finish(&h);

    for table in TABLES {
        assert_eq!(count(&h, table.name), 0, "{}", table.name);
    }
    // Deleted rows leave their terms in the index until it is rewritten.
    for table in INDEXES {
        assert_eq!(indexed(&h, table, "hunter2"), 0, "{table}");
        assert_eq!(count(&h, &format!("{table}_docsize")), 0, "{table}");
    }
    // The tombstone says it is deleted and nothing about what it was.
    let row =
        h.db.query("SELECT * FROM repo_settings", &[])
            .unwrap()
            .remove(0);
    let text = row.to_string();
    for word in ["demo", "ws-1", "user:owner", "unit", "artifacts"] {
        assert!(!text.contains(word), "{word} in {text}");
    }
    assert!(row["deleted_at"].as_i64().is_some());
    assert_eq!(row["parent"], Value::Null);
    assert_eq!(rows::settings(&h.db).unwrap().name, "");

    // GONE to everyone, with hook delivery and the repeated delete among them.
    assert_eq!(code(h.run(OWNER, json!({"op":"repo_status"}))), "GONE");
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_delete","confirm":"demo"}))),
        "GONE"
    );
    assert_eq!(
        code(h.run(HOOKS, json!({"op":"repo_hook_claim","hook_id":1}))),
        "GONE"
    );
    // The purge job and the erase job still find their way out.
    let mut purge = json!({"op":"repo_purge_target","_system":"purge","now":1});
    assert_eq!(
        execute_repo_store(&h.db, purge.take()).unwrap()["object_store"],
        "erased"
    );
    assert_eq!(plan(&h)["erased"], true);
    assert_eq!(h.ok(ERASE, json!({"op":"repo_erase_step"}))["done"], true);
    assert!(plan(&h)["db_bytes"].as_u64().unwrap() <= before);
}

/// The tombstone must not lock out a later binary: migrations run on it like on any store.
#[test]
fn an_erased_repository_still_migrates() {
    let (h, _) = seeded();
    delete(&h);
    finish(&h);
    super::super::migrate_repo_store(&h.db).unwrap();
    assert_eq!(code(h.run(OWNER, json!({"op":"repo_status"}))), "GONE");
}

#[test]
fn large_tables_go_in_batches_under_the_row_budget() {
    let (h, root) = seeded();
    let rows = 3 * ROW_BUDGET as i64 + 7;
    h.db.query(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?1) \
         INSERT INTO commit_paths(commit_id,path,op) SELECT ?2,'src/file'||i||'.rs','add' FROM n",
        &[json!(rows), json!(root)],
    )
    .unwrap();
    delete(&h);
    let first = h.ok(ERASE, json!({"op":"repo_erase_step"}));
    assert_eq!(first["done"], false);
    assert!(
        first["rows"].as_i64().unwrap() <= ROW_BUDGET as i64,
        "{first}"
    );
    assert!(first["rows"].as_i64().unwrap() > 0, "{first}");
    assert!(finish(&h) >= 3);
    assert_eq!(count(&h, "commit_paths"), 0);
    assert_eq!(count(&h, "commit_path_text"), 0);
}

/// An index's bytes must go with its rows: left to the end, they would all go in one
/// transaction, whatever the budget (a merge of deleted terms writes nothing).
#[test]
fn an_index_shrinks_with_its_rows() {
    let (h, root) = seeded();
    h.db.query(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?1) \
         INSERT INTO commit_paths(commit_id,path,op) SELECT ?2,'src/deep/dir/file'||i||'.rs','add' FROM n",
        &[json!(4 * ROW_BUDGET), json!(root)],
    )
    .unwrap();
    let bytes = |h: &Harness| {
        h.db.query(
            "SELECT SUM(LENGTH(block)) AS n FROM commit_path_text_data",
            &[],
        )
        .unwrap()[0]["n"]
            .as_i64()
            .unwrap()
    };
    let full = bytes(&h);
    delete(&h);
    h.ok(ERASE, json!({"op":"repo_erase_step"}));
    let after_one = bytes(&h);
    assert!(after_one < full, "{after_one} of {full}");
    while count(&h, "commit_paths") > 0 {
        h.ok(ERASE, json!({"op":"repo_erase_step"}));
    }
    assert!(bytes(&h) < full / 20, "{} of {full}", bytes(&h));
    finish(&h);
    assert!(bytes(&h) < 64);
}

#[test]
fn large_values_go_in_batches_under_the_byte_budget() {
    let (h, _) = seeded();
    let value = "x".repeat(1024 * 1024);
    for i in 0..(2 * BYTE_BUDGET as usize / value.len() + 2) {
        h.db.query(
            "INSERT INTO tree_cache(id,data_b64) VALUES(?,?)",
            &[json!(format!("t{i}")), json!(value)],
        )
        .unwrap();
    }
    delete(&h);
    let mut steps = 0;
    loop {
        let step = h.ok(ERASE, json!({"op":"repo_erase_step"}));
        if step["done"] == true {
            break;
        }
        // One row past the budget at most: it is reached, not predicted.
        assert!(
            step["bytes"].as_i64().unwrap() <= BYTE_BUDGET as i64 + value.len() as i64,
            "{step}"
        );
        steps += 1;
    }
    assert!(steps >= 2, "{steps}");
    assert_eq!(count(&h, "tree_cache"), 0);
}

/// Each step is its own transaction, so a crash loses at most the step it interrupted, and
/// nothing outside the database says how far the erase got.
#[test]
fn a_crash_between_steps_resumes_where_it_stopped() {
    let (h, root) = seeded();
    let rows = ROW_BUDGET as i64 + 10;
    h.db.query(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?1) \
         INSERT INTO commit_paths(commit_id,path,op) SELECT ?2,'f'||i,'add' FROM n",
        &[json!(rows), json!(root)],
    )
    .unwrap();
    delete(&h);
    h.ok(ERASE, json!({"op":"repo_erase_step"}));
    assert!(count(&h, "commit_paths") > 0);
    // The job starts over: planning again finds the tombstone part erased and carries on.
    assert!(plan(&h)["erased"].is_null());
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_delete","confirm":"demo"}))),
        "OK"
    );
    finish(&h);
    assert_eq!(count(&h, "commit_paths"), 0);
    assert_eq!(plan(&h)["erased"], true);
}

fn with_hook(h: &Harness) -> Value {
    let hook = h.ok(
        OWNER,
        json!({"op":"repo_hook_create","url":"https://ci.example.com/hook","events":["repo"],
            "_secret":"whsec_0123456789abcdef0123456789abcdef","_repo":REPO,
            "_workers_subdomain":"mlong-f01"}),
    );
    hook["id"].clone()
}

#[test]
fn waits_for_undelivered_hooks_then_erases() {
    let (h, _) = seeded();
    let hook = with_hook(&h);
    delete(&h);
    let waiting = plan(&h);
    assert_eq!(waiting["hooks"], json!([hook]));
    assert!(waiting["refs"].is_null(), "{waiting}");
    let nothing_yet = count(&h, "commits");
    assert_eq!(
        code(h.run(ERASE, json!({"op":"repo_erase_step"}))),
        "CONFLICT"
    );
    assert_eq!(count(&h, "commits"), nothing_yet);

    // repo.deleted is delivered from the tombstone, with everything it needs still there.
    let claim = h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":hook}));
    assert_eq!(claim["event"], "repo.deleted");
    h.ok(
        HOOKS,
        json!({"op":"repo_hook_settle","hook_id":hook,"seq":claim["seq"],"attempt":claim["attempt"],"ok":true,"status":200,"ms":5}),
    );
    assert!(plan(&h)["hooks"].is_null());
    finish(&h);
    assert_eq!(count(&h, "hooks"), 0);
}

/// A hook switched off (50 failures, or too far behind) is given up on: nothing will ever
/// send its payloads.
#[test]
fn gives_up_on_a_hook_switched_off() {
    let (h, _) = seeded();
    let hook = with_hook(&h);
    delete(&h);
    h.db.query("UPDATE hooks SET active=0 WHERE id=?", &[hook])
        .unwrap();
    assert!(plan(&h)["hooks"].is_null());
    finish(&h);
    assert_eq!(count(&h, "hook_outbox"), 0);
}

/// The wipe may run long after the deletion (a purge can wait out an undo window), and a
/// purge can queue payloads of its own: how long ago the repository was deleted says nothing
/// about what is still to send.
#[test]
fn a_late_erase_still_waits_for_hooks() {
    let (h, _) = seeded();
    let hook = with_hook(&h);
    delete(&h);
    *h.now.borrow_mut() += 31 * 24 * 60 * 60 * 1000;
    assert_eq!(plan(&h)["hooks"], json!([hook]));
    assert_eq!(
        code(h.run(ERASE, json!({"op":"repo_erase_step"}))),
        "CONFLICT"
    );
    assert!(count(&h, "commits") > 0);
    assert_eq!(count(&h, "hook_outbox"), 1);
}

/// Deleting refuses while forks remain; a tombstone that lists one anyway (older than that
/// rule, or a race) is left alone: a fork reads its parent's objects.
#[test]
fn a_tombstone_with_a_fork_is_not_erased() {
    let (h, _) = seeded();
    delete(&h);
    h.db.query(
        "INSERT INTO forks(repo,created_at) VALUES(?,1)",
        &[json!(REPO)],
    )
    .unwrap();
    assert_eq!(plan(&h)["forks"], 1);
    assert_eq!(
        code(h.run(ERASE, json!({"op":"repo_erase_step"}))),
        "CONFLICT"
    );
    assert!(count(&h, "commits") > 0);
}

/// Combiners are named by ref as callers spelled them, and those rows are about to go.
#[test]
fn the_plan_names_every_ref_with_a_combiner() {
    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_branch_set","ref":"topic","commit":root,"expected":null}),
    );
    h.db.query(
        "INSERT INTO land_queue(refname,commit_id,principal,status,requested_at) VALUES('refs/heads/gone',?,'agent','landed',1)",
        &[json!(root)],
    )
    .unwrap();
    delete(&h);
    assert_eq!(
        plan(&h)["refs"],
        json!(["refs/heads/gone", "refs/heads/main", "refs/heads/topic"])
    );
}
