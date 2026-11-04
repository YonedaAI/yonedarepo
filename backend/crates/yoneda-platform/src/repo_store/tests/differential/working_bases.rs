//! A working ref explicitly placed at a known parent has not changed that parent's files.
//! Later writes and opaque moves must still take part in optimistic concurrency.
use super::{Driver, git};
use serde_json::json;
use yoneda_refmodel::{MAIN, Op};

const SOURCE: &str = "refs/heads/source";
const TARGET: &str = "refs/heads/target";

fn branch(name: &str, from: &str) -> Op {
    Op::CreateBranch {
        name: name.into(),
        from: from.into(),
    }
}

fn write(branch: &str, path: &str, read: bool) -> Op {
    Op::Commit {
        branch: branch.into(),
        path: path.into(),
        content: Some(format!("{branch} writes {path}\n")),
        read,
    }
}

fn land_source() -> Op {
    Op::LandOn {
        branch: SOURCE.into(),
        onto: TARGET.into(),
    }
}

fn refused(script: &[Op], expected: &str) {
    let mut driver = Driver::new(&json!({}));
    let (last, prefix) = script.split_last().unwrap();
    for op in prefix {
        driver.step(op).unwrap();
    }
    let refs = driver.model.refs.clone();
    let version = driver.model.version;
    let platform = driver.h.ok(super::OWNER, json!({"op":"repo_refs"}));
    let outcome = driver.step(last);
    // A refusal must preserve every ref and the version on both sides, even if its
    // code disagrees. Real Git independently checks the resulting objects and graph.
    assert_eq!(driver.model.refs, refs);
    assert_eq!(driver.model.version, version);
    assert_eq!(
        driver.h.ok(super::OWNER, json!({"op":"repo_refs"})),
        platform
    );
    git::check(&driver).unwrap();
    outcome.unwrap();
    assert_eq!(driver.tally.get(expected), Some(&1));
}

fn move_to(name: &str, to: &str) -> Op {
    Op::MoveBranch {
        name: name.into(),
        to: to.into(),
        expected: name.into(),
    }
}

#[test]
fn a_new_working_base_at_the_proposals_parent_is_not_an_opaque_conflict() {
    refused(
        &[
            branch(SOURCE, MAIN),
            write(SOURCE, "src/b.rs", false),
            branch(TARGET, MAIN),
            write(TARGET, "a.txt", false),
            land_source(),
        ],
        "LandOn MERGE_REQUIRED",
    );
}

#[test]
fn a_move_back_to_the_exact_parent_starts_a_new_working_base() {
    refused(
        &[
            branch(SOURCE, MAIN),
            write(SOURCE, "src/b.rs", true),
            branch(TARGET, MAIN),
            write(TARGET, "src/b.rs", false),
            move_to(TARGET, MAIN),
            write(TARGET, "a.txt", false),
            land_source(),
        ],
        "LandOn MERGE_REQUIRED",
    );
}

#[test]
fn a_real_read_conflict_after_the_base_is_still_a_conflict() {
    refused(
        &[
            branch(SOURCE, MAIN),
            write(SOURCE, "a.txt", true),
            branch(TARGET, MAIN),
            write(TARGET, "a.txt", false),
            land_source(),
        ],
        "LandOn CONFLICT",
    );
}

#[test]
fn a_real_read_conflict_after_returning_to_the_parent_is_still_a_conflict() {
    refused(
        &[
            branch(SOURCE, MAIN),
            write(SOURCE, "a.txt", true),
            branch(TARGET, SOURCE),
            move_to(TARGET, MAIN),
            write(TARGET, "a.txt", false),
            land_source(),
        ],
        "LandOn CONFLICT",
    );
}

#[test]
fn positioning_at_a_different_commit_remains_opaque() {
    let other = "refs/heads/other";
    refused(
        &[
            branch(SOURCE, MAIN),
            write(SOURCE, "src/b.rs", false),
            branch(other, MAIN),
            write(other, "a.txt", false),
            branch(TARGET, other),
            land_source(),
        ],
        "LandOn CONFLICT",
    );
}

#[test]
fn a_later_opaque_move_is_not_erased_by_an_earlier_known_parent() {
    let other = "refs/heads/other";
    refused(
        &[
            branch(SOURCE, MAIN),
            write(SOURCE, "src/b.rs", false),
            branch(TARGET, MAIN),
            branch(other, MAIN),
            write(other, "a.txt", false),
            move_to(TARGET, other),
            land_source(),
        ],
        "LandOn CONFLICT",
    );
}

#[test]
fn moves_of_unrelated_refs_do_not_enter_the_target_window() {
    let other = "refs/heads/other";
    refused(
        &[
            branch(SOURCE, MAIN),
            write(SOURCE, "src/b.rs", true),
            branch(TARGET, MAIN),
            branch(other, MAIN),
            write(other, "src/b.rs", false),
            move_to(other, SOURCE),
            write(TARGET, "a.txt", false),
            land_source(),
        ],
        "LandOn MERGE_REQUIRED",
    );
}

#[test]
fn a_protected_main_read_conflict_remains_a_conflict() {
    refused(
        &[
            branch(SOURCE, MAIN),
            write(SOURCE, "a.txt", true),
            branch(TARGET, MAIN),
            write(TARGET, "src/b.rs", false),
            write(MAIN, "a.txt", false),
            Op::Land {
                branch: SOURCE.into(),
            },
        ],
        "Land CONFLICT",
    );
}

#[test]
fn carrying_nonempty_fork_writes_is_not_a_pure_positioning_entry() {
    use yoneda_refmodel::MIRROR;
    refused(
        &[
            Op::Fork,
            Op::ForkCommit {
                path: "src/fork.rs".into(),
                content: "fork work\n".into(),
            },
            Op::Carry,
            branch(SOURCE, MIRROR),
            write(SOURCE, "src/b.rs", false),
            // Moving away then re-carrying records real fork writes, not a no-write
            // branch positioning. The earlier opaque move must still be checked.
            move_to(MIRROR, MAIN),
            Op::Carry,
            write(MIRROR, "a.txt", false),
            Op::LandOn {
                branch: SOURCE.into(),
                onto: MIRROR.into(),
            },
        ],
        "LandOn CONFLICT",
    );
}

#[test]
fn an_empty_path_fast_forward_can_establish_the_known_parent() {
    let other = "refs/heads/other";
    let previous = "refs/heads/previous";
    let shared = |branch: &str| Op::Commit {
        branch: branch.into(),
        path: "a.txt".into(),
        content: Some("same content\n".into()),
        read: false,
    };
    refused(
        &[
            branch(other, MAIN),
            shared(other),
            shared(MAIN),
            branch(previous, MAIN),
            // Merging identical edits advances the graph without changing the tree.
            Op::MergeLand {
                branch: other.into(),
            },
            branch(SOURCE, MAIN),
            write(SOURCE, "src/b.rs", false),
            branch(TARGET, previous),
            Op::LandOn {
                branch: MAIN.into(),
                onto: TARGET.into(),
            },
            write(TARGET, "README.md", false),
            land_source(),
        ],
        "LandOn MERGE_REQUIRED",
    );
}
