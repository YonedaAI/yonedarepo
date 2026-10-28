//! Organizations on a repository: team entries (`team:<org>/<team>`) give their members the
//! entry's role (the highest of a caller's own row and its teams' wins), in the authority
//! and on the published head's snapshot alike; leaving the team ends that at once. The
//! org's owners act as the owner of a repository the org owns (here ws-1 plays the org),
//! and a personal token limited to one org is refused everywhere else.
use super::*;

/// `account`'s session, with the org access the adapter resolved for it.
fn with_orgs(h: &Harness, account: &str, orgs: Value, mut c: Value) -> yoneda_core::Result<Value> {
    *h.now.borrow_mut() += 1_000;
    c["now"] = json!(*h.now.borrow());
    c["_session"] = json!({"workspace": account, "principal": format!("user:{account}"),
        "human": true, "orgs": orgs});
    execute_repo_store(&h.db, c)
}
fn pat(h: &Harness, account: &str, extra: Value, mut c: Value) -> yoneda_core::Result<Value> {
    *h.now.borrow_mut() += 1_000;
    c["now"] = json!(*h.now.borrow());
    let mut grant = json!({"workspace": account, "principal": format!("user:{account}"),
        "id": "pat_0123456789abcdef", "scopes": ["repo:read", "repo:write", "repo:admin"], "repos": null});
    for (k, v) in extra.as_object().unwrap() {
        grant[k] = v.clone();
    }
    c["_pat"] = grant;
    execute_repo_store(&h.db, c)
}
fn devs(teams: Value) -> Value {
    json!({"acme": {"role": "member", "teams": teams}})
}
fn branch(at: &str, name: &str) -> Value {
    json!({"op":"repo_branch_set","ref":name,"commit":at,"expected":null})
}
fn put(h: &Harness, account: &str, role: &str) -> yoneda_core::Result<Value> {
    h.run(
        OWNER,
        json!({"op":"repo_member_put","account":account,"role":role}),
    )
}

#[test]
fn a_team_entry_grants_its_role_and_leaving_the_team_revokes_it() {
    let (h, root) = seeded();
    for bad in [
        "team:acme",
        "team:Acme/devs",
        "team:a@b.co/devs",
        "team:acme/Devs",
        "team:acme/",
    ] {
        assert_eq!(code(put(&h, bad, "write")), "INVALID_INPUT", "{bad}");
    }
    put(&h, "team:acme/devs", "write").unwrap();
    let listed = h.ok(OWNER, json!({"op":"repo_members"}));
    assert_eq!(listed["members"][0]["account"], "team:acme/devs");

    let status = json!({"op":"repo_status"});
    assert_eq!(
        code(with_orgs(
            &h,
            "bob",
            devs(json!(["devs"])),
            branch(&root, "b")
        )),
        "OK"
    );
    // Another org's team of the same name, or no team, is a stranger.
    let other = json!({"other": {"role": "member", "teams": ["devs"]}});
    assert_eq!(
        code(with_orgs(&h, "bob", other, status.clone())),
        "FORBIDDEN"
    );
    assert_eq!(
        code(with_orgs(&h, "bob", devs(json!([])), status.clone())),
        "FORBIDDEN"
    );
    // The highest role wins: a direct read row does not cap the team's write.
    put(&h, "bob", "read").unwrap();
    assert_eq!(
        code(with_orgs(
            &h,
            "bob",
            devs(json!(["devs"])),
            branch(&root, "b2")
        )),
        "OK"
    );
    assert_eq!(
        code(with_orgs(&h, "bob", devs(json!([])), branch(&root, "b3"))),
        "FORBIDDEN"
    );
    // A personal token holds what both it and the team allow.
    assert_eq!(
        code(pat(
            &h,
            "bob",
            json!({"orgs": devs(json!(["devs"]))}),
            branch(&root, "b4")
        )),
        "OK"
    );

    // The published head carries the team row; decisions there resolve it the same way.
    let head = h.ok(
        "platform:projection",
        json!({"op":"repo_head","ref":"main"}),
    );
    let decide = |teams: Value| {
        let credentials = json!({"_session": {"workspace":"bob","principal":"user:bob","human":true,
            "orgs": devs(teams)}});
        crate::platform_head::head_begin(
            &json!({"head": head, "credentials": credentials, "paths": ["a.txt"]}),
        )
    };
    assert_eq!(code(decide(json!(["devs"]))), "OK");
    assert_eq!(code(decide(json!([]))), "FORBIDDEN");
    // Corrupt adapter state fails closed.
    assert_eq!(
        code(with_orgs(&h, "bob", json!(["acme"]), status.clone())),
        "INVALID_INPUT"
    );
    assert_eq!(
        code(with_orgs(
            &h,
            "bob",
            json!({"acme": {"role":"member","teams":[1]}}),
            status
        )),
        "INVALID_INPUT"
    );
}

#[test]
fn org_owners_act_as_the_owner_of_the_orgs_repositories() {
    let (h, root) = seeded();
    let owner = json!({"ws-1": {"role": "owner", "teams": []}});
    let member = json!({"ws-1": {"role": "member", "teams": []}});
    // Only the owner manages admins: an org owner can, an org member is a stranger.
    let admin = json!({"op":"repo_member_put","account":"ada","role":"admin"});
    assert_eq!(
        code(with_orgs(&h, "alice", owner.clone(), admin.clone())),
        "OK"
    );
    assert_eq!(
        code(with_orgs(&h, "carl", member, admin.clone())),
        "FORBIDDEN"
    );
    assert_eq!(
        code(with_orgs(&h, "alice", owner.clone(), branch(&root, "a"))),
        "OK"
    );
    // Through a repo:admin personal token too; an org owner of another org is not.
    assert_eq!(
        code(pat(&h, "alice", json!({"orgs": owner}), admin.clone())),
        "OK"
    );
    let elsewhere = json!({"acme": {"role": "owner", "teams": []}});
    assert_eq!(
        code(pat(&h, "alice", json!({"orgs": elsewhere}), admin)),
        "FORBIDDEN"
    );
}

#[test]
fn a_token_limited_to_an_org_is_refused_on_every_other_repository() {
    let (h, root) = seeded();
    put(&h, "bob", "write").unwrap();
    assert_eq!(
        code(pat(&h, "bob", json!({"org": null}), branch(&root, "a"))),
        "OK"
    );
    assert_eq!(
        code(pat(&h, "bob", json!({"org": "acme"}), branch(&root, "b"))),
        "FORBIDDEN"
    );
    assert_eq!(
        code(pat(&h, "bob", json!({"org": "ws-1"}), branch(&root, "c"))),
        "OK"
    );
    // On the head too.
    let head = h.ok(
        "platform:projection",
        json!({"op":"repo_head","ref":"main"}),
    );
    let credentials = json!({"_pat": {"workspace":"bob","principal":"user:bob","id":"pat_0123456789abcdef",
        "scopes":["repo:read"],"repos":null,"org":"acme"}});
    assert_eq!(
        code(crate::platform_head::head_access(
            &json!({"head": head, "credentials": credentials})
        )),
        "FORBIDDEN"
    );
}
