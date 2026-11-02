//! Flight plans: filed on purpose, never a change row. A plan carries a goal and a scope,
//! capped and free of credentials, and a change shows the newest plan for its branch or
//! number. The table arrives by an additive migration; a repository that has not run it
//! still reads its changes, and refuses only the filing.
use super::*;
use crate::storage::SqlStore;

const SESSION: &str = "claude-code:ses-1";

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
fn a_change_shows_the_newest_plan_for_its_branch() {
    let (h, root) = seeded();
    let number = change_on(&h, "fix", &root);
    assert_eq!(shown(&h, number)["flight_plan"], Value::Null);

    let first = file_plan(
        &h,
        AGENT,
        json!({"goal":"  Retry twice  ","branch":"refs/heads/fix","session_id":SESSION}),
    )
    .unwrap();
    assert_eq!(first["plan"]["goal"], "Retry twice");
    assert_eq!(first["plan"]["branch"], "fix");
    assert_eq!(first["plan"]["principal"], AGENT);
    assert_eq!(first["plan"]["scope"], Value::Null);
    let newer = file_plan(
        &h,
        AGENT,
        json!({"goal":"Retry once","scope":"src/net only","branch":"fix"}),
    )
    .unwrap();
    assert_ne!(first["plan"]["id"], newer["plan"]["id"]);

    let plan = &shown(&h, number)["flight_plan"];
    assert_eq!(plan["goal"], "Retry once");
    assert_eq!(plan["scope"], "src/net only");
    assert_eq!(plan["session_id"], Value::Null);

    // Filed for a change by number, a plan is its own even on another branch name.
    let named = file_plan(&h, AGENT, json!({"goal":"By number","change":number})).unwrap();
    assert_eq!(named["plan"]["branch"], "fix");
    assert_eq!(shown(&h, number)["flight_plan"]["goal"], "By number");
    let other = change_on(&h, "other", &root);
    assert_eq!(shown(&h, other)["flight_plan"], Value::Null);
}

#[test]
fn a_plan_may_come_before_its_branch_and_is_no_change_row() {
    let (h, root) = seeded();
    let filed = file_plan(
        &h,
        AGENT,
        json!({"goal":"Start here","branch":"later","session_id":SESSION}),
    )
    .unwrap();
    assert_eq!(filed["plan"]["session_id"], SESSION);
    assert_eq!(
        h.ok(CI, json!({"op":"repo_changes","status":"all"}))["changes"],
        json!([])
    );
    let number = change_on(&h, "later", &root);
    assert_eq!(shown(&h, number)["flight_plan"]["goal"], "Start here");
}

#[test]
fn a_plan_is_checked_before_it_is_kept() {
    let (h, _) = seeded();
    let filing = |plan: Value| code(file_plan(&h, AGENT, plan));
    assert_eq!(filing(json!({"branch":"fix"})), "INVALID_INPUT");
    assert_eq!(
        filing(json!({"goal":"   ","branch":"fix"})),
        "INVALID_INPUT"
    );
    // Nothing would ever find a plan with no branch, change or session.
    assert_eq!(filing(json!({"goal":"Lost"})), "INVALID_INPUT");
    assert_eq!(
        filing(json!({"goal":"x".repeat(super::super::flight_plans::MAX_GOAL + 1),"branch":"fix"})),
        "INVALID_INPUT"
    );
    assert_eq!(
        filing(
            json!({"goal":"g","scope":"x".repeat(super::super::flight_plans::MAX_SCOPE + 1),"branch":"fix"})
        ),
        "INVALID_INPUT"
    );
    assert_eq!(
        filing(json!({"goal":"g","branch":"bad..name"})),
        "INVALID_INPUT"
    );
    assert_eq!(
        filing(json!({"goal":"g","session_id":"has space"})),
        "INVALID_INPUT"
    );
    assert_eq!(filing(json!({"goal":"g","change":7})), "NOT_FOUND");
    let key = ["sk-ant-", "api03-"].concat() + &"Ab1".repeat(31);
    assert_eq!(
        filing(json!({"goal":format!("use {key}"),"branch":"fix"})),
        "SECRET_DETECTED"
    );
    assert_eq!(
        filing(json!({"goal":"g","scope":format!("use {key}"),"branch":"fix"})),
        "SECRET_DETECTED"
    );
    assert_eq!(
        h.db.query("SELECT COUNT(*) AS n FROM flight_plans", &[])
            .unwrap()[0]["n"],
        0
    );
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

#[test]
fn deleting_a_change_takes_the_plans_filed_for_it() {
    let (h, root) = seeded();
    let number = change_on(&h, "fix", &root);
    file_plan(&h, AGENT, json!({"goal":"Numbered","change":number})).unwrap();
    file_plan(&h, AGENT, json!({"goal":"By branch","branch":"fix"})).unwrap();
    h.ok(AGENT, json!({"op":"repo_change_close","number":number}));
    h.ok(AGENT, json!({"op":"repo_change_delete","number":number}));
    let left =
        h.db.query("SELECT goal FROM flight_plans ORDER BY id", &[])
            .unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0]["goal"], "By branch");
}

#[test]
fn upgrades_from_the_preceding_schema_with_an_empty_table() {
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    let before = migrations.iter().position(|(v, _)| *v == 45).unwrap();
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..before])
        .unwrap();
    assert!(
        db.query(
            "SELECT name FROM sqlite_master WHERE name='flight_plans'",
            &[]
        )
        .unwrap()
        .is_empty()
    );
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    assert!(
        db.query("SELECT id FROM flight_plans", &[])
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        db.query("SELECT MAX(version) AS v FROM repo_schema_migrations", &[])
            .unwrap()[0]["v"],
        super::super::migration::APPLY_THROUGH
    );
}
