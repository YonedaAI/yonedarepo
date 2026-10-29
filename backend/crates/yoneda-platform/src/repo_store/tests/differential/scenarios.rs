//! Scripted cases for outcomes the random cases reach only rarely: each script must reach
//! the outcome it names, under the same model, platform and Git checks.
use super::{Driver, git};
use std::collections::BTreeSet;
use yoneda_refmodel::{Access, Caller, MAIN, Op, Scope};

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
    off_main(B1)
}

fn off_main(name: &str) -> Op {
    Op::CreateBranch {
        name: name.into(),
        from: MAIN.into(),
    }
}

fn enqueue(branch: &str) -> Op {
    Op::Enqueue {
        branch: branch.into(),
    }
}

/// Runs `script`, then the Git checks; fails unless the model and platform agree at every
/// step and the tally holds `reaches`.
fn run(name: &str, script: &[Op], reaches: &str) {
    run_reaching(name, script, &[reaches]);
}

fn run_reaching(name: &str, script: &[Op], reaches: &[&str]) {
    let mut driver = Driver::new();
    for (step, op) in script.iter().enumerate() {
        if let Err(e) = driver.step(op) {
            panic!("{name}, step {step}, {op:?}: {e}");
        }
    }
    if let Err(e) = git::check(&driver) {
        panic!("{name}, git: {e}");
    }
    for label in reaches {
        assert!(
            driver.tally.contains_key(*label),
            "{name} did not reach {label}: {:?}",
            driver.tally
        );
    }
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

#[test]
fn queued_landings_settle_as_an_octopus_a_fast_forward_and_failures() {
    let (b2, b3, b4, b5) = (
        "refs/heads/b2",
        "refs/heads/b3",
        "refs/heads/b4",
        "refs/heads/b5",
    );
    let x = "refs/heads/feature/x";
    let script = [
        branch_off_main(),
        put(B1, "src/b.rs", "from b1", false),
        off_main(b2),
        put(b2, "a.txt", "from b2", false),
        off_main(x),
        put(x, "README.md", "from x", false),
        off_main(b3),
        put(b3, "src/b.rs", "from b3", false),
        // b5 wrote src/b.rs and took it back: its merge changes only src/lib.rs, but it
        // still wrote what b1 writes (write skew), so it waits.
        off_main(b5),
        put(b5, "src/b.rs", "transient", false),
        Op::Commit {
            branch: b5.into(),
            path: "src/b.rs".into(),
            content: None,
            read: false,
        },
        put(b5, "src/lib.rs", "from b5", false),
        // Main moves: every branch now needs a merge, so each landing queues.
        put(MAIN, "README.md", "main moved", false),
        enqueue(B1),
        enqueue(b5),
        enqueue(b2),
        enqueue(x),
        enqueue(b3),
        // b1 and b2 land as one octopus; x conflicts on README.md; b5 and b3 write what
        // b1 wrote and wait for the next batch.
        Op::RunQueue,
        // A branch on the new head queues behind b5 and b3 and lands alone as a
        // fast-forward.
        off_main(b4),
        put(b4, "a.txt", "from b4", false),
        enqueue(b4),
        Op::RunQueue,
        // b5 lands alone as a merge; b3 now conflicts with b1's src/b.rs and fails.
        Op::RunQueue,
        Op::RunQueue,
    ];
    run_reaching(
        "queue",
        &script,
        &[
            "Enqueue Queued",
            "RunQueue octopus",
            "RunQueue fast-forward",
            "RunQueue merge",
        ],
    );
}

/// Found by the differential when it enqueued with `repo_land_enqueue` directly: a ticket
/// for a commit that already landed on main is claimed as a fast-forward, and the batch's
/// landing record then breaks the landings key. The adapter never sends such a ticket
/// (`repo_land` answers `already` before it would queue), but the authority accepts it,
/// and the queue then fails every claim the same way until someone releases it.
#[test]
#[ignore = "known-failing: land_batch answers DATABASE (UNIQUE constraint failed: \
            landings.commit_id, landings.refname) and leaves the ticket pending; target: the \
            ticket settles (landed, already) or enqueue refuses a landed commit"]
fn a_queued_ticket_for_a_landed_commit_settles() {
    use crate::repo_store::tests::{OWNER, batches::open};
    use serde_json::json;
    let (h, root) = open();
    let ticket = h.ok(
        OWNER,
        json!({"op":"repo_land_enqueue","ref":"main","commit":root}),
    )["ticket"]
        .clone();
    let claim = h.ok(
        "platform:merge",
        json!({"op":"repo_land_claim","ref":"main"}),
    );
    let landed = h.run(
        "platform:merge",
        json!({"op":"repo_land_batch","ref":"main","epoch":claim["epoch"],"head":claim["head"],
            "landed":[ticket],"failed":[]}),
    );
    assert!(landed.is_ok(), "{landed:?}");
    let status = h.ok(OWNER, json!({"op":"repo_land_status","ticket":ticket}));
    assert_ne!(status["status"], "pending");
}

fn mint(name: &str, scopes: &[Scope], grant: Option<&[&str]>) -> Op {
    Op::MintToken {
        name: name.into(),
        scopes: scopes.iter().cloned().collect::<BTreeSet<_>>(),
        grant: grant.map(|g| g.iter().map(|p| (*p).to_owned()).collect()),
    }
}

fn token_put(token: &str, branch: &str, path: &str, text: &str) -> Op {
    Op::TokenCommit {
        token: token.into(),
        branch: branch.into(),
        path: path.into(),
        content: Some(format!("{text}\n")),
    }
}

fn token_read(token: &str, path: &str) -> Op {
    Op::TokenRead {
        token: token.into(),
        path: path.into(),
    }
}

#[test]
fn tokens_act_within_their_scopes_and_grants() {
    let script = [
        branch_off_main(),
        // t1 reads and writes src/ only, and cannot land on main.
        mint("t1", &[Scope::Read, Scope::Write], Some(&["src/"])),
        token_put("t1", B1, "src/b.rs", "from t1"),
        token_put("t1", B1, "a.txt", "outside the grant"),
        token_put("t1", MAIN, "src/b.rs", "no land scope"),
        // The change is checked before the landing scope: nothing to change comes first.
        token_put("t1", MAIN, "src/lib.rs", "pub fn a() {}"),
        token_read("t1", "src/lib.rs"),
        token_read("t1", "README.md"),
        mint("t1", &[Scope::Read], None),
        // t2 only reads; t3 writes and lands anywhere but cannot read.
        mint("t2", &[Scope::Read], None),
        token_put("t2", B1, "a.txt", "no write scope"),
        token_read("t2", "a.txt"),
        mint("t3", &[Scope::Write, Scope::Land], None),
        token_put("t3", MAIN, "a.txt", "landed by t3"),
        token_read("t3", "a.txt"),
        Op::RevokeToken { name: "t3".into() },
        token_put("t3", MAIN, "a.txt", "revoked"),
        token_read("never", "a.txt"),
    ];
    run_reaching(
        "tokens",
        &script,
        &[
            "TokenCommit Committed",
            "TokenCommit FORBIDDEN",
            "TokenCommit NO_CHANGES",
            "TokenCommit UNAUTHORIZED",
            "TokenRead Done",
            "TokenRead FORBIDDEN",
            "TokenRead UNAUTHORIZED",
            "MintToken ALREADY_EXISTS",
        ],
    );
}
