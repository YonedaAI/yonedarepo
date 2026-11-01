//! Flight plans before their table: this binary knows migration 0045 and leaves it unapplied.
//! A repository reads its changes as if no plan was ever filed and refuses only the filing,
//! and a store that already ran 0045 (a rollback from the next wave) is accepted.
use super::*;
use crate::storage::SqlStore;

fn file_plan(h: &Harness, who: &str, plan: Value) -> yoneda_core::Result<Value> {
    let mut c = plan;
    c["op"] = json!("repo_flight_plan");
    h.run(who, c)
}

/// `branch` at a new commit on `parent`, with an open change on it.
fn change_on(h: &Harness, branch: &str, parent: &str) -> i64 {
    let id = h
        .commit(
            AGENT,
            Some(parent),
            1,
            json!([file(&format!("{branch}.txt"), "x\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":branch,"commit":id,"expected":null}),
    );
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":branch,"title":"Try it"}),
    )["number"]
        .as_i64()
        .unwrap()
}

fn shown(h: &Harness, number: i64) -> Value {
    h.ok(CI, json!({"op":"repo_change_show","number":number}))
}

#[test]
fn only_a_whole_repository_writer_files_a_plan() {
    let (h, _) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read","write"],"paths":["docs/"],
        "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    let plan = json!({"goal":"g","branch":"fix"});
    assert_eq!(code(file_plan(&h, CI, plan.clone())), "FORBIDDEN");
    assert_eq!(code(file_plan(&h, "token:docs", plan)), "FORBIDDEN");
}

/// Every read of a change works as today, filing answers a clean refusal and a change can
/// still be deleted (`tests/erase` erases such a repository).
#[test]
fn a_repository_without_the_table_still_works() {
    let (h, root) = seeded();
    let number = change_on(&h, "fix", &root);
    h.db.query("DROP TABLE IF EXISTS flight_plans", &[])
        .unwrap();
    assert_eq!(shown(&h, number)["flight_plan"], Value::Null);
    assert_eq!(
        code(file_plan(&h, AGENT, json!({"goal":"g","branch":"fix"}))),
        "NOT_SUPPORTED"
    );
    h.ok(AGENT, json!({"op":"repo_change_close","number":number}));
    h.ok(AGENT, json!({"op":"repo_change_delete","number":number}));
}

#[test]
fn a_store_that_ran_the_migration_is_accepted() {
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    super::super::migration::migrate_through(&db, "repo_schema_migrations", migrations, 45)
        .unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    assert!(
        db.query("SELECT id FROM flight_plans", &[])
            .unwrap()
            .is_empty()
    );
}
