//! Scripted cases for outcomes the random cases reach only rarely: each script must reach
//! the outcome it names, under the same model, platform and Git checks.
use super::{Driver, git};
use yoneda_refmodel::{Access, Caller, MAIN, Op};

const B1: &str = "refs/heads/b1";

fn put(branch: &str, path: &str, text: &str, read: bool) -> Op {
    Op::Commit {
        branch: branch.into(),
        path: path.into(),
        content: Some(format!("{text}\n")),
        read,
    }
}

fn branch_off_main() -> Op {
    Op::CreateBranch {
        name: B1.into(),
        from: MAIN.into(),
    }
}

/// Runs `script`, then the Git checks; fails unless the model and platform agree at every
/// step and the tally holds `reaches`.
fn run(name: &str, script: &[Op], reaches: &str) {
    let mut driver = Driver::new();
    for (step, op) in script.iter().enumerate() {
        if let Err(e) = driver.step(op) {
            panic!("{name}, step {step}, {op:?}: {e}");
        }
    }
    if let Err(e) = git::check(&driver) {
        panic!("{name}, git: {e}");
    }
    assert!(
        driver.tally.contains_key(reaches),
        "{name} did not reach {reaches}: {:?}",
        driver.tally
    );
}

#[test]
fn landing_work_that_read_a_path_main_since_wrote_conflicts() {
    let script = [
        branch_off_main(),
        put(B1, "a.txt", "read then written", true),
        put(MAIN, "a.txt", "written on main", false),
        Op::Land { branch: B1.into() },
    ];
    run("land conflict", &script, "Land CONFLICT");
}

#[test]
fn merge_landings_build_merge_commits_for_rebase_and_merge_plans() {
    let disjoint = [
        branch_off_main(),
        put(B1, "src/b.rs", "on the branch", false),
        put(MAIN, "a.txt", "on main", false),
        Op::MergeLand { branch: B1.into() },
    ];
    run("merge land, other paths", &disjoint, "MergeLand Committed");
    // Both sides wrote the same path the same way: a merge plan, merged cleanly.
    let shared = [
        branch_off_main(),
        put(B1, "a.txt", "same", false),
        put(MAIN, "a.txt", "same", false),
        Op::MergeLand { branch: B1.into() },
    ];
    run("merge land, same change", &shared, "MergeLand Committed");
}

#[test]
fn a_rebase_drops_a_replay_main_already_holds() {
    let script = [
        branch_off_main(),
        put(B1, "a.txt", "upstream too", false),
        put(B1, "src/b.rs", "only here", false),
        put(MAIN, "a.txt", "upstream too", false),
        Op::Rebase { branch: B1.into() },
    ];
    run("rebase drop", &script, "Rebase dropped");
}

#[test]
fn a_public_repository_asks_callers_without_credentials_to_sign_in() {
    let script = [
        Op::SetVisibility {
            caller: Caller::Owner,
            public: true,
        },
        Op::Probe {
            caller: Caller::Anonymous,
            access: Access::Push,
        },
        Op::SetVisibility {
            caller: Caller::Anonymous,
            public: false,
        },
        Op::Probe {
            caller: Caller::Account("stranger".into()),
            access: Access::Push,
        },
    ];
    run("public anonymous", &script, "Probe UNAUTHORIZED");
}
