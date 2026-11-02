//! Who may approve a commit (reviewers.rs). A person never approves a commit they pushed
//! themselves (by session or personal token, both `user:<account>`), neither directly nor
//! through a repository token they created. A commit pushed *by* a repository token is the
//! token's (an agent's) work, and the account that created the token may approve it: agents
//! push with tokens the owner mints and the human approves their work. That is deliberate.
use super::*;

#[test]
fn the_token_creator_may_approve_what_the_token_pushed() {
    let (h, root) = seeded();
    // AGENT is token:agent, created by OWNER in Harness::new.
    let id = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/x.rs", "x\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        OWNER,
        json!({"op":"repo_review","commit":id,"decision":"approve"}),
    );
    let detail = h.ok(OWNER, json!({"op":"repo_commit","commit":id}));
    assert_eq!(detail["gates"]["approvals"], 1);
}

#[test]
fn a_person_never_approves_their_own_push_directly_or_through_their_token() {
    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"mine","scopes":["read","review"],
        "_secret":"mine-secret-0123456789abcdef0123456789"}),
    );
    let id = h
        .commit(
            OWNER,
            Some(&root),
            1,
            json!([file("src/own.rs", "x\n")]),
            json!([]),
        )
        .unwrap();
    for reviewer in [OWNER, "token:mine"] {
        assert_eq!(
            code(h.run(
                reviewer,
                json!({"op":"repo_review","commit":id,"decision":"approve"})
            )),
            "FORBIDDEN",
            "{reviewer} approved user:owner's own push"
        );
    }
    let detail = h.ok(OWNER, json!({"op":"repo_commit","commit":id}));
    assert_eq!(detail["gates"]["approvals"], 0);
}

/// `agent:owner/<name>`, an agent of user:owner, on a session of the repository's owner.
const BOT: &str = "agent:owner/bot";

fn pushed_by(h: &Harness, who: &str, root: &str) -> String {
    h.commit(
        who,
        Some(root),
        1,
        json!([file(&format!("src/{}.rs", who.len()), "x\n")]),
        json!([]),
    )
    .unwrap()
}

#[test]
fn the_owner_may_approve_what_their_agent_pushed() {
    let (h, root) = seeded();
    let id = pushed_by(&h, BOT, &root);
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_commit","commit":id}))["principal"],
        BOT
    );
    h.ok(
        OWNER,
        json!({"op":"repo_review","commit":id,"decision":"approve"}),
    );
    let detail = h.ok(OWNER, json!({"op":"repo_commit","commit":id}));
    assert_eq!(detail["gates"]["approvals"], 1);
}

#[test]
fn an_agent_never_approves_its_owners_work_or_another_agent_of_theirs() {
    let (h, root) = seeded();
    for author in [OWNER, BOT, "agent:owner/other"] {
        let id = pushed_by(&h, author, &root);
        assert_eq!(
            code(h.run(
                BOT,
                json!({"op":"repo_review","commit":id,"decision":"approve"})
            )),
            "FORBIDDEN",
            "{BOT} approved {author}'s push"
        );
    }
}

#[test]
fn an_account_and_its_agents_count_as_one_approval() {
    let (h, root) = seeded();
    let id = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/x.rs", "x\n")]),
            json!([]),
        )
        .unwrap();
    // A repository token is not user:friend's, so these all review it.
    for reviewer in ["user:friend", "agent:friend/a", "agent:friend/b"] {
        h.ok(
            reviewer,
            json!({"op":"repo_review","commit":id,"decision":"approve"}),
        );
    }
    let detail = h.ok(OWNER, json!({"op":"repo_commit","commit":id}));
    assert_eq!(detail["gates"]["approvals"], 1);
}
