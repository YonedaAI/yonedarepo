//! Repository members: another account's session or personal token acts by its role
//! (capped by the token's scopes), the published head's snapshot carries members so
//! stateless decisions honour them, removal ends access at once, only the owner manages
//! admins or deletes, and approvals count distinct accounts other than the author's.
use super::*;
use crate::storage::SqlStore;

/// `account`'s own signed-in session on ws-1's repository.
fn member(h: &Harness, account: &str, mut c: Value) -> yoneda_core::Result<Value> {
    *h.now.borrow_mut() += 1_000;
    c["now"] = json!(*h.now.borrow());
    c["_session"] =
        json!({"workspace": account, "principal": format!("user:{account}"), "human": true});
    execute_repo_store(&h.db, c)
}
/// `account`'s personal token holding `scopes`.
fn member_pat(
    h: &Harness,
    account: &str,
    scopes: Value,
    mut c: Value,
) -> yoneda_core::Result<Value> {
    *h.now.borrow_mut() += 1_000;
    c["now"] = json!(*h.now.borrow());
    c["_pat"] = json!({"workspace": account, "principal": format!("user:{account}"),
        "id": "pat_0123456789abcdef", "scopes": scopes, "repos": null});
    execute_repo_store(&h.db, c)
}
fn add(h: &Harness, account: &str, role: &str) {
    h.ok(
        OWNER,
        json!({"op":"repo_member_put","account":account,"role":role}),
    );
}
fn branch(at: &str, name: &str) -> Value {
    json!({"op":"repo_branch_set","ref":name,"commit":at,"expected":null})
}
impl Harness {
    /// A commit on `root` by `who` (a member account, through its session).
    fn commit_as(&self, who: &str, root: &str, text: &str) -> String {
        let principal = format!("member:{who}");
        self.commit(
            &principal,
            Some(root),
            1,
            json!([file("src/lib.rs", text)]),
            json!([]),
        )
        .unwrap()
    }
}

#[test]
fn roles_map_to_scopes_and_strangers_stay_out() {
    let (h, root) = seeded();
    assert_eq!(
        code(member(&h, "stranger", json!({"op":"repo_status"}))),
        "FORBIDDEN"
    );
    for (account, role) in [("rita", "read"), ("will", "write"), ("lana", "land")] {
        add(&h, account, role);
    }
    // read: reads and clones, nothing else.
    assert_eq!(
        member(&h, "rita", json!({"op":"repo_status"})).unwrap()["viewer"]["role"],
        "read"
    );
    assert_eq!(
        code(member(&h, "rita", json!({"op":"repo_clone_access"}))),
        "OK"
    );
    assert_eq!(code(member(&h, "rita", branch(&root, "r"))), "FORBIDDEN");
    // write: branches and unrequired checks; no review, no landing on main.
    assert_eq!(code(member(&h, "will", branch(&root, "w"))), "OK");
    assert_eq!(
        code(member(
            &h,
            "will",
            json!({"op":"repo_check","commit":root,"name":"lint","status":"pass"})
        )),
        "OK"
    );
    // A required check stays with the posters the policy binds it to.
    assert_eq!(
        code(member(
            &h,
            "will",
            json!({"op":"repo_check","commit":root,"name":"unit","status":"pass"})
        )),
        "FORBIDDEN"
    );
    let agents = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn a() { 1 }\n")]),
            json!([]),
        )
        .unwrap();
    let review = json!({"op":"repo_review","commit":agents,"decision":"approve"});
    assert_eq!(code(member(&h, "will", review.clone())), "FORBIDDEN");
    let land = json!({"op":"repo_land","ref":"main","commit":agents});
    assert_eq!(code(member(&h, "will", land.clone())), "FORBIDDEN");
    // land: reviews and lands main once the gates pass.
    assert_eq!(code(member(&h, "lana", review)), "OK");
    h.ok(
        CI,
        json!({"op":"repo_check","commit":agents,"name":"unit","status":"pass"}),
    );
    assert_eq!(member(&h, "lana", land).unwrap()["commit"], json!(agents));
    // No member manages tokens, policy, hooks or members except admins.
    for op in [
        json!({"op":"repo_tokens"}),
        json!({"op":"repo_members"}),
        json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":0}}),
        json!({"op":"repo_member_put","account":"zed","role":"read"}),
    ] {
        assert_eq!(code(member(&h, "lana", op.clone())), "FORBIDDEN", "{op}");
    }
    // Only an account's own session is a member; an admin bearer naming it is not.
    let mut bearer = json!({"op":"repo_status","now":1});
    bearer["_session"] = json!({"workspace": "lana", "principal": "admin"});
    assert_eq!(code(execute_repo_store(&h.db, bearer)), "FORBIDDEN");
}

#[test]
fn admins_act_as_the_owner_except_for_admins_and_deletion() {
    let (h, _root) = seeded();
    add(&h, "ada", "admin");
    add(&h, "abe", "admin");
    let ada = |c: Value| member(&h, "ada", c);
    assert_eq!(code(ada(json!({"op":"repo_tokens"}))), "OK");
    assert_eq!(
        code(ada(
            json!({"op":"repo_set_policy","policy":{"required_checks":["unit"],"approvals":1}})
        )),
        "OK"
    );
    assert_eq!(
        code(ada(
            json!({"op":"repo_member_put","account":"will","role":"write"})
        )),
        "OK"
    );
    assert_eq!(
        code(ada(
            json!({"op":"repo_member_put","account":"will","role":"land"})
        )),
        "OK"
    );
    assert_eq!(
        code(ada(json!({"op":"repo_member_remove","account":"will"}))),
        "OK"
    );
    // Admins never grant, change or remove admins, never delete the repository, and never
    // break glass, even from their own signed-in session.
    let glass = ada(json!({"op":"repo_break_glass","action":"pause","reason":"x"}));
    assert_eq!(
        glass.unwrap_err().message,
        "Break-glass recovery is only for a signed-in human owner"
    );
    for op in [
        json!({"op":"repo_member_put","account":"will","role":"admin"}),
        json!({"op":"repo_member_put","account":"abe","role":"read"}),
        json!({"op":"repo_member_remove","account":"abe"}),
        json!({"op":"repo_delete","confirm":"demo"}),
    ] {
        assert_eq!(code(ada(op.clone())), "FORBIDDEN", "{op}");
    }
    // Nobody makes the owner a member or removes it; unknown roles and accounts refuse.
    for op in [
        json!({"op":"repo_member_put","account":"ws-1","role":"read"}),
        json!({"op":"repo_member_remove","account":"ws-1"}),
    ] {
        assert_eq!(code(h.run(OWNER, op.clone())), "FORBIDDEN", "{op}");
    }
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_member_put","account":"zed","role":"root"})
        )),
        "INVALID_INPUT"
    );
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_member_put","account":"9 bad","role":"read"})
        )),
        "INVALID_INPUT"
    );
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_member_remove","account":"nobody"}))),
        "NOT_FOUND"
    );
    // The owner manages admins.
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_member_put","account":"abe","role":"write"})
        )),
        "OK"
    );
    let listed = h.ok(OWNER, json!({"op":"repo_members"}));
    let roles: Vec<_> = listed["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["account"].as_str().unwrap().to_owned(),
                m["role"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        roles,
        [
            ("abe".into(), "write".into()),
            ("ada".into(), "admin".into())
        ]
    );
    assert_eq!(listed["members"][1]["added_by"], OWNER);
}

#[test]
fn a_break_glass_pause_holds_admins_like_everyone_but_the_owner() {
    let (h, root) = seeded();
    add(&h, "ada", "admin");
    let owner = |c: Value| member(&h, "ws-1", c);
    let pause = |action: &str| json!({"op":"repo_break_glass","action":action,"reason":"agents misbehaving"});
    assert_eq!(owner(pause("pause_automation")).unwrap()["paused"], true);
    let check = json!({"op":"repo_check","commit":root,"name":"lint","status":"pass"});
    let branch = json!({"op":"repo_land","ref":"ada","commit":root});
    for op in [&check, &branch] {
        assert_eq!(
            code(member(&h, "ada", op.clone())),
            "AUTOMATION_PAUSED",
            "{op}"
        );
        assert_eq!(
            code(member_pat(&h, "ada", json!(["repo:admin"]), op.clone())),
            "AUTOMATION_PAUSED",
            "{op}"
        );
    }
    // The owner's own session still works, and the admin again once automation resumes.
    assert_eq!(code(owner(check.clone())), "OK");
    owner(pause("resume_automation")).unwrap();
    assert_eq!(code(member(&h, "ada", check)), "OK");
}

#[test]
fn personal_tokens_hold_what_both_token_and_role_allow() {
    let (h, root) = seeded();
    add(&h, "lana", "land");
    add(&h, "rita", "read");
    add(&h, "ada", "admin");
    let pat = |who: &str, scopes: Value, c: Value| code(member_pat(&h, who, scopes, c));
    assert_eq!(
        pat("lana", json!(["repo:read"]), json!({"op":"repo_status"})),
        "OK"
    );
    assert_eq!(
        pat("lana", json!(["repo:read"]), branch(&root, "a")),
        "FORBIDDEN"
    );
    assert_eq!(
        pat(
            "lana",
            json!(["repo:read", "repo:write"]),
            branch(&root, "b")
        ),
        "OK"
    );
    assert_eq!(
        pat(
            "lana",
            json!(["repo:read"]),
            json!({"op":"repo_clone_access"})
        ),
        "OK"
    );
    // repo:admin counts as every scope, still capped by the role.
    assert_eq!(
        pat("rita", json!(["repo:admin"]), branch(&root, "c")),
        "FORBIDDEN"
    );
    assert_eq!(
        pat("rita", json!(["repo:admin"]), json!({"op":"repo_status"})),
        "OK"
    );
    assert_eq!(
        pat("lana", json!(["repo:admin"]), json!({"op":"repo_tokens"})),
        "FORBIDDEN"
    );
    assert_eq!(
        pat("ada", json!(["repo:admin"]), json!({"op":"repo_tokens"})),
        "OK"
    );
    assert_eq!(
        pat("ada", json!(["repo:read"]), json!({"op":"repo_tokens"})),
        "FORBIDDEN"
    );
    assert_eq!(
        pat(
            "stranger",
            json!(["repo:admin"]),
            json!({"op":"repo_status"})
        ),
        "FORBIDDEN"
    );
}

#[test]
fn removal_ends_access_at_once_including_the_published_snapshot() {
    let (h, _root) = seeded();
    let before = h.ok(
        "platform:projection",
        json!({"op":"repo_head","ref":"main"}),
    );
    add(&h, "rita", "read");
    let head = h.ok(
        "platform:projection",
        json!({"op":"repo_head","ref":"main"}),
    );
    assert_ne!(head["access_version"], before["access_version"]);
    assert_eq!(head["members"], json!([{"account":"rita","role":"read"}]));
    let session = json!({"_session": {"workspace":"rita","principal":"user:rita","human":true}});
    let access = |head: &Value| {
        crate::platform_head::head_access(&json!({"head": head, "credentials": session}))
    };
    assert_eq!(access(&head).unwrap()["principal"], "user:rita");
    // A head published before members carries none: refused there, the authority decides.
    let mut old = head.clone();
    old.as_object_mut().unwrap().remove("members");
    assert_eq!(code(access(&old)), "FORBIDDEN");

    assert_eq!(code(member(&h, "rita", json!({"op":"repo_status"}))), "OK");
    h.ok(OWNER, json!({"op":"repo_member_remove","account":"rita"}));
    assert_eq!(
        code(member(&h, "rita", json!({"op":"repo_status"}))),
        "FORBIDDEN"
    );
    let after = h.ok(
        "platform:projection",
        json!({"op":"repo_head","ref":"main"}),
    );
    assert_eq!(after["access_version"], before["access_version"]);
    assert_eq!(code(access(&after)), "FORBIDDEN");
}

#[test]
fn approvals_count_distinct_accounts_other_than_the_author() {
    let (h, root) = seeded();
    for account in ["bob", "carol", "dave"] {
        add(&h, account, "land");
    }
    h.ok(
        OWNER,
        json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":2}}),
    );
    let bobs = h.commit_as("bob", &root, "pub fn a() { 7 }\n");
    let approve = json!({"op":"repo_review","commit":bobs,"decision":"approve"});
    // The author approves neither by session nor by personal token.
    assert_eq!(code(member(&h, "bob", approve.clone())), "FORBIDDEN");
    assert_eq!(
        code(member_pat(
            &h,
            "bob",
            json!(["repo:review"]),
            approve.clone()
        )),
        "FORBIDDEN"
    );
    member(&h, "carol", approve.clone()).unwrap();
    // The same account again, through its token: one person, one decision.
    assert_eq!(
        code(member_pat(
            &h,
            "carol",
            json!(["repo:review"]),
            approve.clone()
        )),
        "ALREADY_EXISTS"
    );
    let land = json!({"op":"repo_land","ref":"main","commit":bobs});
    assert_eq!(code(member(&h, "carol", land.clone())), "NOT_READY");
    member(&h, "dave", approve).unwrap();
    assert_eq!(member(&h, "carol", land).unwrap()["version"], 2);

    // The owner's own commit: a token the owner created reviews for the owner, so it
    // can't approve; two tokens of one account would count once anyway.
    h.ok(OWNER, json!({"op":"repo_token_create","name":"rev","scopes":["read","review"],"_secret":"rev-secret-0123456789abcdef0123456789"}));
    let owners = h
        .commit(
            OWNER,
            Some(&root),
            1,
            json!([file("README.md", "# owner\n")]),
            json!([]),
        )
        .unwrap();
    assert_eq!(
        code(h.run(
            "token:rev",
            json!({"op":"repo_review","commit":owners,"decision":"approve"})
        )),
        "FORBIDDEN"
    );
    // Rows written before this rule (or by any path around it) still don't count.
    h.db.query(
        "INSERT INTO reviews(commit_id,principal,decision,reason,recorded_at) VALUES(?,'token:rev','approve',NULL,1),(?,'user:owner','approve',NULL,1)",
        &[json!(owners), json!(owners)],
    )
    .unwrap();
    let id = yoneda_core::git_object::ObjectId::parse(&owners).unwrap();
    assert_eq!(super::super::reviewers::approvals(&h.db, &id).unwrap(), 0);
}

#[test]
fn upgrades_from_the_hooks_schema_with_no_members() {
    let db = crate::native::NativeStore::memory().unwrap();
    let pre = super::super::migration::MIGRATIONS[..25].to_vec();
    super::super::migration::migrate_with(
        &db,
        "repo_schema_migrations",
        Box::leak(pre.into_boxed_slice()),
    )
    .unwrap();
    db.query("INSERT INTO repo_settings(id,workspace,owner,object_store,policy,policy_digest,created_at) VALUES('repository','ws-1','user:owner','r2','{}','d',1)", &[]).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    assert_eq!(
        db.query("SELECT MAX(version) AS v FROM repo_schema_migrations", &[])
            .unwrap()[0]["v"],
        super::super::migration::MIGRATIONS.len()
    );
    assert!(
        db.query("SELECT account FROM members", &[])
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        db.query("SELECT owner FROM repo_settings", &[]).unwrap()[0]["owner"],
        "user:owner"
    );
    // The role constraint holds in the table itself.
    assert!(
        db.query(
            "INSERT INTO members(account,role,added_by,added_at) VALUES('x','root','y',1)",
            &[]
        )
        .is_err()
    );
}
