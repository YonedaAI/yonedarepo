//! A contracts read for a whole revision (the Overview names every file) stays within the
//! Durable Object SQLite limit of 100 bound parameters per statement: 1000 paths, the most
//! one read takes, are queried in chunks that each bind their paths and the version.
use super::*;

#[test]
fn a_contracts_read_of_a_thousand_paths_binds_at_most_100_parameters_per_statement() {
    let (h, _) = seeded();
    let mut paths: Vec<String> = (0..999).map(|i| format!("src/f{i}.rs")).collect();
    paths.push("src/lib.rs".into());
    let listed = h.ok(CI, json!({"op":"repo_contracts","paths":paths}));
    assert_eq!(listed["records"], json!([]));
}
