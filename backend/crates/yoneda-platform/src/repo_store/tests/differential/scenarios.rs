//! Scripted cases for outcomes the random cases reach only rarely: each script must reach
//! the outcome it names, under the same model, platform and Git checks.
use super::{Driver, git};
use std::collections::BTreeSet;
use yoneda_refmodel::{Access, Caller, MAIN, MIRROR, Op, Role, Scope};

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
    // A deleted repository has nothing left for Git to read.
    if !driver.model.deleted
        && let Err(e) = git::check(&driver)
    {
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
    run_reaching(
        "public anonymous",
        &script,
        &["Probe UNAUTHORIZED", "Probe FORBIDDEN"],
    );
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

fn tag(name: &str, message: Option<&str>) -> Op {
    Op::Tag {
        name: name.into(),
        at: MAIN.into(),
        message: message.map(str::to_owned),
    }
}

#[test]
fn tags_are_created_once_annotated_or_not() {
    let script = [
        tag("refs/tags/v1", Some("First release")),
        // A second annotated request is a new tag object: refused, as is a lightweight one.
        tag("refs/tags/v1", Some("First release")),
        tag("refs/tags/v1", None),
        tag("refs/tags/v2", None),
        tag("refs/tags/v2", None),
        tag("refs/tags/v2", Some("Too late")),
        put(MAIN, "a.txt", "moved on", false),
        tag("refs/tags/v1", Some("Elsewhere")),
    ];
    run_reaching(
        "tags",
        &script,
        &["Tag Moved", "Tag Already", "Tag ALREADY_EXISTS"],
    );
}

fn shard(path: &str, text: &str, read: bool) -> Op {
    Op::ShardCommit {
        path: path.into(),
        content: format!("{text}\n"),
        read,
        on: None,
    }
}

/// The combiner submits `picks` alone, and the projector runs right after.
fn submit(picks: Vec<usize>) -> Op {
    Op::Submit {
        picks,
        chained: false,
        project: true,
    }
}

/// Commits begun from a published head that trails the log (the race CI met): each lands
/// as what the log since its base allows, never as if main had not moved.
#[test]
fn shard_commits_on_a_trailing_published_head_land_as_the_log_allows() {
    let script = [
        Op::Publish,
        // Main moves past the published head on a.txt and README.md.
        put(MAIN, "a.txt", "main moved", false),
        put(MAIN, "README.md", "main moved", false),
        // Begun on the trailing head: a new path lands as a changeset, projected as a
        // merge with main; a path main since wrote takes the merge path; a path it read
        // that main since wrote is a conflict.
        shard("src/b.rs", "on the trailing head", false),
        submit(vec![0]),
        shard("a.txt", "on the trailing head", false),
        submit(vec![1]),
        shard("README.md", "read on the trailing head", true),
        submit(vec![2]),
        Op::RunQueue,
        // Two members of one submission writing one file: the second waits, and on its
        // own later it meets the first's changeset and takes the merge path.
        Op::Publish,
        shard("docs.md", "first", false),
        shard("docs.md", "second", false),
        submit(vec![3, 4]),
        submit(vec![4]),
        // A landed member submitted again answers with its version.
        submit(vec![3]),
        Op::RunQueue,
    ];
    run_reaching(
        "trailing head",
        &script,
        &[
            "Submit landed",
            "Submit queued",
            "Submit failed",
            "Submit deferred+landed",
            "Submit already",
        ],
    );
}

fn land_on(branch: &str, onto: &str) -> Op {
    Op::LandOn {
        branch: branch.into(),
        onto: onto.into(),
    }
}

/// Working branches land without gates; off their head, concurrency counts from where the
/// landed work's parent landed on the branch, not from the (later) version it read.
#[test]
fn landings_on_working_branches_count_from_the_parents_landing() {
    let (b2, b3) = ("refs/heads/b2", "refs/heads/b3");
    let script = [
        branch_off_main(),
        off_main(b2),
        put(b2, "src/b.rs", "first", false),
        // b1 is at b2's parent: a fast-forward.
        land_on(b2, B1),
        // b1 moves on; b3 starts from b2, whose tip landed on b1.
        put(B1, "a.txt", "b1 moved", false),
        Op::CreateBranch {
            name: b3.into(),
            from: b2.into(),
        },
        // Built on what landed, reading a later version: b1's write after that landing is
        // concurrent. Another path needs a merge; a path it read conflicts.
        put(b2, "src/b.rs", "second", false),
        land_on(b2, B1),
        put(b3, "a.txt", "b3 read it", true),
        land_on(b3, B1),
        // A parent that never landed on b1: nothing there is concurrent, but b1 is not
        // its parent either.
        put(b2, "README.md", "third", false),
        land_on(b2, B1),
    ];
    run_reaching(
        "working branches",
        &script,
        &[
            "LandOn Moved",
            "LandOn MERGE_REQUIRED",
            "LandOn CONFLICT",
            "LandOn STALE_PARENT",
        ],
    );
}

fn member(by: &Caller, account: &str, role: Option<Role>) -> Op {
    Op::Member {
        by: by.clone(),
        account: account.into(),
        role,
    }
}

/// Admins manage read and write members and act as the owner, but never grant or change
/// an admin, nor the repository's visibility.
#[test]
fn admins_manage_members_but_not_admins_or_visibility() {
    let (rita, will) = (
        Caller::Account("rita".into()),
        Caller::Account("will".into()),
    );
    let push = |caller: &Caller| Op::Probe {
        caller: caller.clone(),
        access: Access::Push,
    };
    let script = [
        member(&Caller::Owner, "rita", Some(Role::Admin)),
        member(&rita, "will", Some(Role::Write)),
        member(&rita, "will", Some(Role::Admin)),
        member(&rita, "rita", None),
        member(&rita, "stranger", None),
        Op::SetVisibility {
            caller: rita.clone(),
            public: true,
        },
        push(&rita),
        member(&will, "stranger", Some(Role::Read)),
        member(&Caller::Account("stranger".into()), "will", None),
        member(&Caller::Owner, "rita", Some(Role::Read)),
        push(&rita),
        member(&rita, "will", None),
    ];
    run_reaching(
        "admins",
        &script,
        &[
            "Member Done",
            "Member FORBIDDEN",
            "Member NOT_FOUND",
            "SetVisibility FORBIDDEN",
        ],
    );
}

fn fork_put(path: &str, text: &str) -> Op {
    Op::ForkCommit {
        path: path.into(),
        content: format!("{text}\n"),
    }
}

/// Fork work carried back lands on the parent as of where its history landed there: the
/// parent's later writes count against it, whatever the fork's own log says.
#[test]
fn carried_fork_work_is_based_where_its_history_landed_in_the_parent() {
    let script = [
        Op::Fork,
        Op::Fork,
        put(MAIN, "README.md", "parent moved", false),
        fork_put("src/fork.rs", "from the fork"),
        Op::Carry,
        Op::Carry,
        // Its base is main's root landing (version 1), so main's README.md write is
        // concurrent: a merge is required, and a merge landing builds one.
        Op::Land {
            branch: MIRROR.into(),
        },
        Op::MergeLand {
            branch: MIRROR.into(),
        },
        // More fork work moves the mirror forward.
        fork_put("src/fork.rs", "more from the fork"),
        Op::Carry,
    ];
    run_reaching(
        "fork",
        &script,
        &[
            "Fork Done",
            "Fork Already",
            "ForkCommit Committed",
            "Carry Moved",
            "Carry Already",
            "Land MERGE_REQUIRED",
            "MergeLand Committed",
        ],
    );
}

/// Found by the long differential run (seed 31), fixed on claude/fix-fork-mirror: when a
/// parent writer moves the mirror branch off the fork's head and the unchanged fork
/// branch is carried again, the mirror moves back.
#[test]
fn carrying_again_moves_the_mirror_back_to_the_fork_head() {
    let script = [
        Op::Fork,
        fork_put("src/fork.rs", "from the fork"),
        Op::Carry,
        // A writer of the parent moves the mirror elsewhere.
        Op::MoveBranch {
            name: MIRROR.into(),
            to: MAIN.into(),
            expected: MIRROR.into(),
        },
        Op::Carry,
    ];
    run("mirror back", &script, "Carry Moved");
}

/// A client's next shard commit built on its own unlanded one: alone it needs its chain;
/// sent with the chain it takes the merge path (both adopted). Between a landing and
/// its projection, reads of the refs, plans and claims are refused and direct landings
/// wait; the published head stays at the last projection.
#[test]
fn chained_shard_commits_and_the_window_before_projection() {
    let unprojected = |picks: Vec<usize>| Op::Submit {
        picks,
        chained: false,
        project: false,
    };
    let script = [
        Op::Publish,
        shard("a.txt", "first", false),
        Op::ShardCommit {
            path: "src/b.rs".into(),
            content: "on the first\n".into(),
            read: false,
            on: Some(0),
        },
        submit(vec![1]),
        Op::Submit {
            picks: vec![1],
            chained: true,
            project: true,
        },
        Op::RunQueue,
        // A landing the projector has not built yet.
        shard("README.md", "in the window", false),
        unprojected(vec![2]),
        Op::Probe {
            caller: Caller::Owner,
            access: Access::Refs,
        },
        Op::Land {
            branch: MAIN.into(),
        },
        put(MAIN, "a.txt", "waits", false),
        Op::RunQueue,
        Op::Publish,
        shard("docs.md", "on the projected head", false),
        Op::Project,
        submit(vec![3]),
    ];
    run_reaching(
        "chains and window",
        &script,
        &[
            "Submit need_chain",
            "Submit queued",
            "Submit landed",
            "Probe PROJECTION_PENDING",
            "Commit MERGE_REQUIRED",
            "Project made",
        ],
    );
}

/// The parent cannot go while its fork lives; deleting the fork makes the parent forget
/// it, and then the parent goes. Afterwards its authority answers GONE (the delete itself
/// answers already); work built without it (a shard commit) still builds.
#[test]
fn a_parent_goes_only_after_its_fork_and_then_answers_gone() {
    let script = [
        Op::Fork,
        Op::DeleteRepo { confirmed: false },
        Op::DeleteRepo { confirmed: true },
        fork_put("src/fork.rs", "from the fork"),
        Op::DeleteFork,
        Op::DeleteFork,
        fork_put("src/fork.rs", "after"),
        Op::Carry,
        Op::DeleteRepo { confirmed: true },
        Op::DeleteRepo { confirmed: true },
        Op::Probe {
            caller: Caller::Owner,
            access: Access::Status,
        },
        Op::Publish,
        put(MAIN, "a.txt", "too late", false),
        shard("a.txt", "built anyway", false),
        submit(vec![0]),
    ];
    run_reaching(
        "deletion",
        &script,
        &[
            "DeleteRepo INVALID_INPUT",
            "DeleteRepo CONFLICT",
            "DeleteFork Done",
            "DeleteFork Already",
            "ForkCommit GONE",
            "Carry GONE",
            "DeleteRepo Done",
            "DeleteRepo Already",
            "Probe GONE",
            "Commit GONE",
            "ShardCommit Committed",
            "Submit GONE",
        ],
    );
}
