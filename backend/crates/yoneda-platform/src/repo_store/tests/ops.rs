//! Typed op dispatch: every op round-trips through its name, every repository op the Worker
//! sends is one the store knows, and an unknown op is refused by name before authorization.
use super::*;
use crate::ops::worker_op_literals;
use crate::repo_store::op::Op;

#[test]
fn every_op_round_trips_through_its_name() {
    let all = Op::all();
    assert!(all.len() >= 100, "{}", all.len());
    let mut names: Vec<_> = all.iter().map(|op| op.name()).collect();
    for op in &all {
        assert_eq!(Op::parse(&json!({"op": op.name()})).unwrap(), *op);
    }
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), all.len(), "an op name is listed twice");
}

#[test]
fn every_repository_op_the_worker_sends_is_known() {
    let sent: Vec<_> = worker_op_literals(|_| true)
        .into_iter()
        .filter(|name| name.starts_with("repo_"))
        .collect();
    assert!(sent.len() >= 100, "{}", sent.len());
    for name in sent {
        assert!(Op::parse(&json!({ "op": name })).is_ok(), "{name}");
    }
}

#[test]
fn unknown_ops_are_refused_by_name_before_authorization() {
    let h = Harness::new();
    // No credentials at all, and a fork-shaped name a token holder is not allowed to run:
    // both are unknown ops, not authorization failures.
    for (command, name) in [
        (json!({"op":"repo_nope","now":1}), "repo_nope"),
        (
            json!({"op":"repo_fork_nope","now":1,"_token":"agent-secret-0123456789abcdef0123456789"}),
            "repo_fork_nope",
        ),
    ] {
        let e = execute_repo_store(&h.db, command).unwrap_err();
        assert_eq!(e.code, "UNKNOWN_OP");
        assert_eq!(e.message, format!("Unknown platform op {name}"));
    }
    let e = execute_repo_store(&h.db, json!({"now":1})).unwrap_err();
    assert_eq!(e.code, "INVALID_INPUT");
}
