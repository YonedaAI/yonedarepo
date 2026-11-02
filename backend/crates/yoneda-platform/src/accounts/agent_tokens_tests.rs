//! Agent sign-up: an agent is a named personal token (`origin: "agent:<name>"`) under an
//! account, asked for through the device flow. Its grant is narrower than a login's, and an
//! account holds a few of them. Tokens without that origin behave as they always have.
use super::execute_workspace;
use crate::native::NativeStore;
use serde_json::{Value, json};

const DAY: i64 = 24 * 60 * 60 * 1000;
const REPO: &str = "r0123456789abcdef0123";

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn code(result: yoneda_core::Result<Value>) -> String {
    result.err().map(|e| e.code).unwrap_or_default()
}
fn account() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    at(&db, 1000, json!({"op":"signup","username":"alice","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)})).unwrap();
    db
}
fn device(op: &str, extra: Value) -> Value {
    let mut command = json!({"op":op,"user_code":"BCDFGHJK","secret_hash":"f".repeat(64)});
    for (k, v) in extra.as_object().unwrap() {
        command[k] = v.clone();
    }
    command
}
fn asked(agent: Value) -> NativeStore {
    let db = NativeStore::memory().unwrap();
    at(
        &db,
        0,
        device(
            "device_create",
            json!({"client_name":"yoneda-cli","host":"ci-1","agent":agent}),
        ),
    )
    .unwrap();
    db
}
/// `pat_create` for token `n` of an agent, or of no agent with origin null.
fn pat(n: u64, origin: Value, extra: Value) -> Value {
    let mut command = json!({"op":"pat_create","id":format!("pat_{n:016x}"),"name":format!("t{n}"),
        "token_hash":format!("{n:064x}"),"scopes":["repo:read","repo:write"],
        "expires_days":30,"repos":[REPO],"origin":origin,"host":Value::Null});
    for (k, v) in extra.as_object().unwrap() {
        command[k] = v.clone();
    }
    command
}
fn agent(n: u64, name: &str) -> Value {
    pat(n, json!(format!("agent:{name}")), json!({}))
}

#[test]
fn a_code_carries_the_agents_name_and_the_page_can_read_it() {
    let db = asked(json!("review-bot"));
    let shown = at(&db, 1, device("device_show", json!({}))).unwrap();
    assert_eq!(
        (&shown["agent"], &shown["host"]),
        (&json!("review-bot"), &json!("ci-1"))
    );
    let plain = NativeStore::memory().unwrap();
    at(
        &plain,
        0,
        device("device_create", json!({"client_name":"yoneda-cli"})),
    )
    .unwrap();
    let shown = at(&plain, 1, device("device_show", json!({}))).unwrap();
    assert_eq!(shown["agent"], Value::Null);
    assert_eq!(
        code(at(&plain, 11 * 60 * 1000, device("device_show", json!({})))),
        "EXPIRED_TOKEN"
    );
}

#[test]
fn agent_names_are_short_lowercase_words_and_no_client_can_spell_one_itself() {
    for bad in ["", "Bot", "a/b", "a b", "-bot", "a:b", &"x".repeat(33)] {
        let db = NativeStore::memory().unwrap();
        assert_eq!(
            code(at(
                &db,
                0,
                device(
                    "device_create",
                    json!({"client_name":"yoneda-cli","agent":bad})
                )
            )),
            "INVALID_INPUT",
            "{bad}"
        );
    }
    let db = NativeStore::memory().unwrap();
    assert_eq!(
        code(at(
            &db,
            0,
            device("device_create", json!({"client_name":"agent:bot"}))
        )),
        "INVALID_INPUT"
    );
}

#[test]
fn approving_an_agent_grants_no_more_than_repository_work() {
    for scope in ["repo:admin", "account:ssh-keys"] {
        let db = asked(json!("bot"));
        assert_eq!(
            code(at(
                &db,
                1,
                device(
                    "device_approve",
                    json!({"account":"alice","agent_signup":true,"scopes":["repo:read",scope],"repos":[REPO],"expires_days":30})
                )
            )),
            "INVALID_INPUT",
            "{scope}"
        );
    }
    let db = asked(json!("bot"));
    assert_eq!(
        code(at(
            &db,
            1,
            device(
                "device_approve",
                json!({"account":"alice","agent_signup":true,"scopes":["repo:read"],"repos":[REPO],"org":"acme","expires_days":30})
            )
        )),
        "INVALID_INPUT"
    );
}

#[test]
fn an_agent_has_no_repositories_until_some_are_chosen() {
    let db = asked(json!("bot"));
    let grant = json!({"account":"alice","agent_signup":true,"scopes":["repo:read"],"repos":null,"expires_days":30});
    assert_eq!(
        code(at(&db, 1, device("device_approve", grant.clone()))),
        "INVALID_INPUT"
    );
    let mut all = grant;
    all["all_repos"] = json!(true);
    at(&db, 2, device("device_approve", all)).unwrap();
    let polled = at(&db, 6_000, device("device_poll", json!({}))).unwrap();
    assert_eq!(polled["status"], "APPROVED");
    assert_eq!(polled["grant"]["repos"], Value::Null);
    assert_eq!(polled["agent"], "bot");
}

#[test]
fn an_agent_is_refused_while_the_switch_is_off_and_can_still_be_denied() {
    let db = asked(json!("bot"));
    let grant = json!({"account":"alice","scopes":["repo:read"],"repos":[REPO],"expires_days":30});
    assert_eq!(
        code(at(&db, 1, device("device_approve", grant))),
        "NOT_SUPPORTED"
    );
    let denied = at(
        &db,
        2,
        device("device_approve", json!({"account":"alice","deny":true})),
    )
    .unwrap();
    assert_eq!(denied["approved"], false);
}

#[test]
fn a_login_keeps_every_scope_and_all_repositories_by_default() {
    let db = NativeStore::memory().unwrap();
    at(
        &db,
        0,
        device("device_create", json!({"client_name":"yoneda-cli"})),
    )
    .unwrap();
    at(
        &db,
        1,
        device(
            "device_approve",
            json!({"account":"alice","scopes":["repo:admin","account:ssh-keys"],"repos":null,"expires_days":30}),
        ),
    )
    .unwrap();
    let polled = at(&db, 6_000, device("device_poll", json!({}))).unwrap();
    assert_eq!(polled["status"], "APPROVED");
    assert_eq!(polled["agent"], Value::Null);
}

#[test]
fn an_agent_token_cannot_be_made_with_more_than_repository_work_either() {
    let db = account();
    for (n, extra) in [
        json!({"scopes":["repo:read","repo:admin"]}),
        json!({"scopes":["account:ssh-keys"]}),
        json!({"org":"acme"}),
        json!({"expires_days":91}),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            code(at(
                &db,
                2000,
                pat(n as u64, json!("agent:bot"), extra.clone())
            )),
            "INVALID_INPUT",
            "{extra}"
        );
    }
    for origin in ["agent:", "agent:Bot", "robot", "agent:a/b"] {
        assert_eq!(
            code(at(&db, 2000, pat(9, json!(origin), json!({})))),
            "INVALID_INPUT",
            "{origin}"
        );
    }
}

#[test]
fn an_account_holds_ten_live_agents() {
    let db = account();
    for n in 0..10 {
        let made = at(&db, 2000, agent(n, &format!("bot-{n}"))).unwrap();
        assert_eq!(made["origin"], format!("agent:bot-{n}"));
    }
    assert_eq!(
        code(at(&db, 2000, agent(10, "bot-10"))),
        "CONFLICT",
        "the eleventh"
    );
    assert_eq!(
        code(at(
            &db,
            2000,
            json!({"op":"pat_agent_room","name":"bot-10"})
        )),
        "CONFLICT"
    );
    // Other tokens are not agents, and take no place.
    at(&db, 2000, pat(20, Value::Null, json!({}))).unwrap();
    at(&db, 2000, pat(21, json!("login"), json!({}))).unwrap();
    // A revoked agent frees its place.
    at(
        &db,
        2000,
        json!({"op":"pat_revoke","id":format!("pat_{:016x}", 3)}),
    )
    .unwrap();
    at(&db, 2000, json!({"op":"pat_agent_room","name":"bot-10"})).unwrap();
    at(&db, 2000, agent(10, "bot-10")).unwrap();
    // So does an expired one.
    let later = 2000 + 31 * DAY;
    at(&db, later, json!({"op":"pat_agent_room","name":"bot-11"})).unwrap();
    at(&db, later, agent(11, "bot-11")).unwrap();
}

#[test]
fn a_live_name_is_one_agent() {
    let db = account();
    at(&db, 2000, agent(1, "bot")).unwrap();
    assert_eq!(code(at(&db, 2000, agent(2, "bot"))), "CONFLICT");
    assert_eq!(
        code(at(&db, 2000, json!({"op":"pat_agent_room","name":"bot"}))),
        "CONFLICT"
    );
    at(
        &db,
        2000,
        json!({"op":"pat_revoke","id":format!("pat_{:016x}", 1)}),
    )
    .unwrap();
    at(&db, 2000, agent(2, "bot")).unwrap();
}

#[test]
fn tokens_without_an_agent_origin_are_as_they_were() {
    let db = account();
    let plain = at(
        &db,
        2000,
        pat(
            1,
            Value::Null,
            json!({"scopes":["repo:admin","account:ssh-keys"],"repos":null}),
        ),
    )
    .unwrap();
    assert_eq!(plain["origin"], Value::Null);
    let checked = at(
        &db,
        2001,
        json!({"op":"pat_check","token_hash":format!("{:064x}", 1)}),
    )
    .unwrap();
    assert_eq!(checked["scopes"], json!(["repo:admin", "account:ssh-keys"]));
    assert_eq!(checked["origin"], Value::Null);
}

#[test]
fn an_agent_token_says_what_it_is_when_checked() {
    let db = account();
    at(&db, 2000, agent(1, "bot")).unwrap();
    let checked = at(
        &db,
        2001,
        json!({"op":"pat_check","token_hash":format!("{:064x}", 1)}),
    )
    .unwrap();
    assert_eq!(checked["origin"], "agent:bot");
    let listed = at(&db, 2001, json!({"op":"pat_list"})).unwrap();
    assert_eq!(listed["tokens"][0]["origin"], "agent:bot");
}
