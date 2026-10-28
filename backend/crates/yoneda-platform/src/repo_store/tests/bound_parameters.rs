//! Durable Object SQLite binds at most 100 parameters per statement (the native test store
//! enforces the same limit): reads over many paths, such as the code map's contract records
//! for every file of a revision, must never bind one parameter per path past it.
use super::*;

/// Paths `src/f0.rs`… one more than a statement may bind.
fn many_paths() -> Vec<String> {
    (0..=yoneda_store::MAX_BOUND_PARAMETERS)
        .map(|i| format!("src/f{i}.rs"))
        .collect()
}

#[test]
fn contract_records_for_more_paths_than_a_statement_binds() {
    use crate::storage::SqlStore;
    let (h, root) = seeded();
    let paths = many_paths();
    let last = paths.last().unwrap().clone();
    h.db.query(
        "INSERT INTO symbol_contracts(seq,path,symbol_path,commit_id,node_digest,contract,contract_digest,recorded_by,recorded_at,recorded_version) VALUES(1,?,'f',?,?,'{\"summary\":\"last\"}',?,?,1,0)",
        &[json!(last), json!(root), json!("d".repeat(64)), json!("c".repeat(64)), json!(AGENT)],
    )
    .unwrap();
    let listed = h.ok(CI, json!({"op":"repo_contracts","paths":paths}));
    let records = listed["records"].as_array().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["path"], json!(last));
    assert_eq!(records[0]["contract"]["summary"], "last");
}

#[test]
fn agent_context_for_the_most_paths_it_accepts() {
    let (h, _) = seeded();
    let mut paths = many_paths();
    paths.pop();
    let got = h.ok(CI, json!({"op":"repo_agent_context","paths":paths}));
    assert!(got["contracts"].is_array());
}
