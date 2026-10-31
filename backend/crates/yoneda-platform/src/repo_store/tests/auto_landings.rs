//! Landings for every push. Migration 0044 ships in two waves: a binary that knows it but
//! doesn't apply it runs on a database that did, so rollback from wave 2 to wave 1 is safe.
//! An unclaimed auto row is adopted by `git_change_create`, which answers as a create; an
//! explicit row still answers `ALREADY_EXISTS`.
use super::super::migration::{MIGRATIONS, migrate_repo_store, migrate_through, migrate_with};
use super::*;
use crate::storage::SqlStore;

const TABLE: &str = "repo_schema_migrations";
/// The last version of each wave: wave 1 knows 0044, wave 2 applies it.
const WAVE_1: i64 = 43;
const WAVE_2: i64 = 44;

fn applied<S: SqlStore>(db: &S) -> i64 {
    db.query("SELECT MAX(version) AS v FROM repo_schema_migrations", &[])
        .unwrap()[0]["v"]
        .as_i64()
        .unwrap()
}

/// A store at the schema before 0044, with one repository and a change on it.
fn wave_1_store() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    migrate_through(&db, TABLE, &MIGRATIONS, WAVE_1).unwrap();
    db.query("INSERT INTO repo_settings(id,workspace,owner,object_store,policy,policy_digest,created_at) VALUES('repository','ws-1','user:owner','r2','{}','d',1)", &[]).unwrap();
    db.query("INSERT INTO changes(title,body,branch,base,author,status,created_at,updated_at) VALUES('Old','','old','main','user:ada','open',1,1)", &[]).unwrap();
    db
}

#[test]
fn a_fresh_store_runs_to_the_apply_ceiling_and_repeats() {
    let db = wave_1_store();
    assert_eq!(applied(&db), WAVE_1);
    migrate_through(&db, TABLE, &MIGRATIONS, WAVE_1).unwrap();
    assert_eq!(applied(&db), WAVE_1);
    let columns = db.query("SELECT * FROM changes", &[]).unwrap();
    assert!(columns[0].get("origin").is_none(), "0044 was not applied");
}

#[test]
fn upgrading_from_0043_keeps_every_row_explicit_and_every_switch_off() {
    let db = wave_1_store();
    migrate_through(&db, TABLE, &MIGRATIONS, WAVE_2).unwrap();
    migrate_through(&db, TABLE, &MIGRATIONS, WAVE_2).unwrap();
    assert_eq!(applied(&db), WAVE_2);
    assert_eq!(
        db.query("SELECT origin FROM changes", &[]).unwrap()[0]["origin"],
        "explicit"
    );
    let settings = &db.query("SELECT * FROM repo_settings", &[]).unwrap()[0];
    assert_eq!(settings["auto_landings"], 0);
    assert_eq!(settings["auto_landing_agents"], 0);
    assert_eq!(settings["land_when_cleared"], 0);
    assert_eq!(settings["findings_block"], 0);
    assert_eq!(settings["owner"], "user:owner");
    let change = &db.query("SELECT * FROM changes", &[]).unwrap()[0];
    assert_eq!(change["clearance"], Value::Null);
}

#[test]
fn a_wave_1_binary_accepts_a_wave_2_database_an_older_one_refuses() {
    let db = wave_1_store();
    migrate_through(&db, TABLE, &MIGRATIONS, WAVE_2).unwrap();
    migrate_through(&db, TABLE, &MIGRATIONS, WAVE_1).unwrap();
    assert_eq!(applied(&db), WAVE_2, "accepted, and nothing undone");
    let older = migrate_with(&db, TABLE, &MIGRATIONS[..43]).unwrap_err();
    assert_eq!(older.code, "SCHEMA_TOO_NEW");
    // The known migration is still pinned by its digest.
    db.query(
        "UPDATE repo_schema_migrations SET digest='x' WHERE version=44",
        &[],
    )
    .unwrap();
    let drift = migrate_through(&db, TABLE, &MIGRATIONS, WAVE_1).unwrap_err();
    assert_eq!(drift.code, "MIGRATION_DRIFT");
}

/// A branch `name` at a new commit on `parent`.
fn branch(h: &Harness, name: &str, parent: &str) -> String {
    let id = h
        .commit(
            AGENT,
            Some(parent),
            1,
            json!([file(&format!("src/{name}.rs"), "x\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":name,"commit":id,"expected":null}),
    );
    id
}

/// An auto row on `branch`, as a push makes one, written by hand: this binary may be in
/// wave 1, where the database is a wave-2 one after a rollback.
fn auto_row(h: &Harness, branch: &str) -> i64 {
    migrate_through(&h.db, TABLE, &MIGRATIONS, WAVE_2).unwrap();
    h.db.query(
        "INSERT INTO changes(title,body,branch,base,author,status,created_at,updated_at,origin) VALUES('Auto subject','',?,'main','token:agent','open',5,5,'auto')",
        &[json!(branch)],
    )
    .unwrap();
    h.db.query("SELECT last_insert_rowid() AS n", &[]).unwrap()[0]["n"]
        .as_i64()
        .unwrap()
}

fn create(h: &Harness, who: &str, branch: &str) -> yoneda_core::Result<Value> {
    h.run(
        who,
        json!({"op":"repo_change_create","branch":branch,"title":"On purpose","body":"Why"}),
    )
}

#[test]
fn create_adopts_an_unclaimed_auto_row_and_answers_as_a_create() {
    let (h, root) = seeded();
    let head = branch(&h, "fix", &root);
    let number = auto_row(&h, "fix");

    let adopted = create(&h, OWNER, "fix").unwrap();
    assert_eq!(adopted["number"], number);
    assert_eq!(adopted["title"], "On purpose");
    assert_eq!(adopted["body"], "Why");
    assert_eq!(adopted["base"], "main");
    assert_eq!(adopted["author"], OWNER);
    assert_eq!(adopted["status"], "open");
    assert_eq!(adopted["head"], json!(head));
    assert_eq!(adopted["created_at"], 5, "the row keeps its first time");

    // Claimed now: a second create is the usual refusal, and nothing moved.
    assert_eq!(code(create(&h, AGENT, "fix")), "ALREADY_EXISTS");
    let shown = h.ok(CI, json!({"op":"repo_change_show","number":number}));
    assert_eq!(shown["author"], OWNER);
}

#[test]
fn a_row_answers_its_origin_where_the_schema_has_one() {
    let (h, root) = seeded();
    branch(&h, "fix", &root);
    branch(&h, "other", &root);
    let auto = auto_row(&h, "fix");
    let explicit = create(&h, AGENT, "other").unwrap();
    assert_eq!(explicit["origin"], "explicit");
    let shown = h.ok(CI, json!({"op":"repo_change_show","number":auto}));
    assert_eq!(shown["origin"], "auto");
    let adopted = create(&h, AGENT, "fix").unwrap();
    assert_eq!(adopted["origin"], "explicit");
}

#[test]
fn adoption_takes_the_base_it_is_given() {
    let (h, root) = seeded();
    branch(&h, "stage", &root);
    branch(&h, "fix", &root);
    auto_row(&h, "fix");
    assert_eq!(
        code(h.run(
            AGENT,
            json!({"op":"repo_change_create","branch":"fix","base":"nope","title":"T"})
        )),
        "NOT_FOUND"
    );
    let adopted = h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"fix","base":"stage","title":"T"}),
    );
    assert_eq!(adopted["base"], "stage");
}

#[test]
fn an_explicit_row_still_answers_already_exists() {
    let (h, root) = seeded();
    branch(&h, "fix", &root);
    create(&h, AGENT, "fix").unwrap();
    migrate_repo_store(&h.db).unwrap();
    assert_eq!(code(create(&h, AGENT, "fix")), "ALREADY_EXISTS");
}

#[test]
fn a_closed_auto_row_is_left_and_create_opens_a_new_one() {
    let (h, root) = seeded();
    branch(&h, "fix", &root);
    let number = auto_row(&h, "fix");
    h.ok(OWNER, json!({"op":"repo_change_close","number":number}));
    let opened = create(&h, AGENT, "fix").unwrap();
    assert_ne!(opened["number"], number);
    assert_eq!(opened["title"], "On purpose");
}

#[test]
fn adopting_tells_every_change_hook_as_a_create_does() {
    let (h, root) = seeded();
    branch(&h, "fix", &root);
    let number = auto_row(&h, "fix");
    let hook = h.ok(
        OWNER,
        json!({"op":"repo_hook_create","url":"https://ci.example.com/hook",
            "_secret":"whsec_0123456789abcdef0123456789abcdef","_repo":"r0123456789abcdef0123",
            "_workers_subdomain":"mlong-f01","events":["change"]}),
    )["id"]
        .clone();
    create(&h, AGENT, "fix").unwrap();
    let claim = h.ok(
        "platform:hooks",
        json!({"op":"repo_hook_claim","hook_id":hook}),
    );
    let body: Value = serde_json::from_str(claim["body"].as_str().unwrap()).unwrap();
    assert_eq!(body["event"], "change.opened");
    assert_eq!(body["action"], "opened");
    assert_eq!(body["change"]["number"], number);
    assert_eq!(body["message"], "On purpose\n\nWhy");
}
