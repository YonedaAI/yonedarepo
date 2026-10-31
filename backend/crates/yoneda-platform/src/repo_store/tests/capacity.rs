//! What a repository's database holds: `repo_storage`, for its owner and the platform.
use super::*;

#[test]
fn the_owner_and_the_platform_read_database_size_and_row_estimates() {
    let h = Harness::new();
    for principal in [OWNER, "platform:derive"] {
        let storage = h.ok(principal, json!({"op":"repo_storage"}));
        assert!(storage["db_bytes"].as_u64().unwrap() > 4096, "{storage}");
        assert_eq!(storage["table_rows"]["tokens"], json!(2));
        assert_eq!(storage["table_rows"]["commits"], json!(0));
    }
}

#[test]
fn nobody_else_reads_the_database_size() {
    let h = Harness::new();
    let refused = h.run(AGENT, json!({"op":"repo_storage"})).unwrap_err();
    assert_eq!(refused.code, "FORBIDDEN");
    let reader = h.run("member:stranger", json!({"op":"repo_storage"}));
    assert_eq!(reader.unwrap_err().code, "NOT_FOUND");
}

#[test]
fn a_public_reader_does_not_see_the_database_size() {
    let h = Harness::new();
    h.ok(
        OWNER,
        json!({"op":"repo_set_visibility","visibility":"public"}),
    );
    let refused = h
        .run("member:stranger", json!({"op":"repo_storage"}))
        .unwrap_err();
    assert!(
        ["FORBIDDEN", "NOT_FOUND"].contains(&refused.code.as_ref()),
        "{refused}"
    );
}
