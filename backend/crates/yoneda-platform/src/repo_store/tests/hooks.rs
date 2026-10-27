//! Webhooks: owner-managed hooks with SSRF-checked targets and write-once secrets; events
//! fanned out from the log cursor in version order (plus refusals and checks); one
//! leased delivery at a time per hook, retried with backoff, switched off after 50
//! consecutive failures; payloads without contents, messages only within the hook's grant.
use super::*;
use crate::storage::SqlStore;

const HOOKS: &str = "platform:hooks";
const REPO: &str = "r0123456789abcdef0123";

fn create(h: &Harness, who: &str, extra: Value) -> yoneda_core::Result<Value> {
    let mut c = json!({"op":"repo_hook_create","url":"https://ci.example.com/hook",
        "_secret":"whsec_0123456789abcdef0123456789abcdef","_repo":REPO,
        "_workers_subdomain":"mlong-f01"});
    for (k, v) in extra.as_object().unwrap() {
        c[k] = v.clone();
    }
    h.run(who, c)
}

fn fanout(h: &Harness) -> Value {
    h.ok(HOOKS, json!({"op":"repo_hooks_fanout"}))
}

/// Delivers every payload of `hook` that the receiver accepts, returning their bodies.
fn drain(h: &Harness, hook: &Value) -> Vec<Value> {
    let mut bodies = Vec::new();
    loop {
        let claim = h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":hook}));
        if claim["idle"] == true {
            return bodies;
        }
        bodies.push(serde_json::from_str(claim["body"].as_str().unwrap()).unwrap());
        h.ok(
            HOOKS,
            json!({"op":"repo_hook_settle","hook_id":hook,"seq":claim["seq"],"attempt":claim["attempt"],"ok":true,"status":200,"ms":5}),
        );
    }
}

/// Commits `path` on main's head and lands it (`_root` names the seeded history).
fn landed_child(h: &Harness, _root: &str, path: &str) -> String {
    let refs = h.ok(OWNER, json!({"op":"repo_refs"}));
    let head = refs["refs"]["refs/heads/main"].as_str().unwrap().to_owned();
    let version = refs["version"].as_u64().unwrap();
    let id = h
        .commit(
            AGENT,
            Some(&head),
            version,
            json!([file(path, "x\n")]),
            json!([]),
        )
        .unwrap();
    h.approve_and_check(&id);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
    id
}

#[test]
fn owners_manage_hooks_with_public_https_targets_and_write_once_secrets() {
    let (h, _) = seeded();
    assert_eq!(code(create(&h, AGENT, json!({}))), "FORBIDDEN");
    for url in [
        "http://ci.example.com/",
        "https://169.254.169.254/latest/meta-data",
        "https://10.0.0.1/",
        "https://localhost/",
        "https://[::1]/",
        "https://bench.mlong-f01.workers.dev/hooks",
    ] {
        assert_eq!(
            code(create(&h, OWNER, json!({ "url": url }))),
            "INVALID_INPUT",
            "{url}"
        );
    }
    assert_eq!(
        code(create(&h, OWNER, json!({"events":["push"]}))),
        "INVALID_INPUT"
    );
    let made = create(&h, OWNER, json!({"events":["land","check","land"]})).unwrap();
    assert_eq!(made["events"], json!(["land", "check"]));
    assert_eq!(made["active"], true);
    let listed = h.ok(OWNER, json!({"op":"repo_hooks"}));
    assert_eq!(listed["hooks"][0]["url"], "https://ci.example.com/hook");
    assert!(!listed.to_string().contains("whsec_"), "{listed}");
    assert_eq!(code(h.run(AGENT, json!({"op":"repo_hooks"}))), "FORBIDDEN");
    // Only the platform's hook job claims payloads (and so reads the secret).
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_hook_claim","hook_id":made["id"]}))),
        "FORBIDDEN"
    );
    h.ok(OWNER, json!({"op":"repo_hook_delete","hook_id":made["id"]}));
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_hook_delete","hook_id":made["id"]}))),
        "NOT_FOUND"
    );
    assert_eq!(h.ok(OWNER, json!({"op":"repo_hooks"}))["hooks"], json!([]));
}

#[test]
fn events_fan_out_in_log_order_without_contents() {
    let (h, root) = seeded();
    // History before the hook existed is never delivered to it.
    landed_child(&h, &root, "early.txt");
    let hook = create(&h, OWNER, json!({})).unwrap()["id"].clone();
    let child = landed_child(&h, &root, "notes/a.txt");
    h.ok(
        OWNER,
        json!({"op":"repo_branch_set","ref":"feature","commit":child,"expected":null}),
    );
    h.ok(
        OWNER,
        json!({"op":"repo_tag_create","name":"v1","commit":child}),
    );
    let page = fanout(&h);
    assert_eq!(page["hooks"], json!([hook]));
    assert_eq!(
        fanout(&h)["hooks"],
        json!([hook]),
        "nothing is queued twice"
    );
    let bodies = drain(&h, &hook);
    let seen: Vec<(&str, Option<u64>)> = bodies
        .iter()
        .map(|b| (b["event"].as_str().unwrap(), b["version"].as_u64()))
        .collect();
    assert_eq!(
        seen,
        [
            ("check", None),
            ("land", Some(3)),
            ("branch", Some(4)),
            ("tag", Some(5))
        ]
    );
    let land = &bodies[1];
    assert_eq!(land["repo"], REPO);
    assert_eq!(land["ref"], "refs/heads/main");
    assert_eq!(
        (&land["commit"], &land["after"]),
        (&json!(child), &json!(child))
    );
    assert_eq!(land["actor"], OWNER);
    assert_eq!(land["message"], "change");
    assert!(land["at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(land["delivery_id"], format!("{REPO}.{hook}.2"));
    assert_eq!(bodies[2]["action"], "created");
    assert_eq!(bodies[3]["ref"], "refs/tags/v1");
    let text = serde_json::to_string(&bodies).unwrap();
    assert!(
        !text.contains("notes/a.txt") && !text.contains("x\\n"),
        "{text}"
    );
}

#[test]
fn a_grant_limited_hook_gets_no_message_for_commits_outside_it() {
    let (h, root) = seeded();
    let open = create(&h, OWNER, json!({"events":["land"]})).unwrap()["id"].clone();
    let limited = create(&h, OWNER, json!({"events":["land"],"paths":["docs/"]})).unwrap();
    assert_eq!(limited["paths"], json!(["docs/"]));
    landed_child(&h, &root, "src/secret.rs");
    fanout(&h);
    assert_eq!(drain(&h, &open)[0]["message"], "change");
    let hidden = &drain(&h, &limited["id"])[0];
    assert_eq!(hidden["event"], "land");
    assert!(hidden.get("message").is_none(), "{hidden}");
}

#[test]
fn refused_landings_and_completed_checks_are_events() {
    let (h, root) = seeded();
    let hook = create(&h, OWNER, json!({"events":["refused","check"]})).unwrap()["id"].clone();
    let make = |path: &str, read: Value| {
        let id = h
            .commit(AGENT, Some(&root), 1, json!([file(path, "x\n")]), read)
            .unwrap();
        h.approve_and_check(&id);
        id
    };
    let (first, stale) = (make("f.txt", json!([])), make("s.txt", json!(["f.txt"])));
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":first}));
    let ticket = h.ok(
        OWNER,
        json!({"op":"repo_land_enqueue","ref":"main","commit":stale}),
    )["ticket"]
        .clone();
    h.ok(
        "platform:merge",
        json!({"op":"repo_land_claim","ref":"main"}),
    );
    fanout(&h);
    let bodies = drain(&h, &hook);
    let names: Vec<&str> = bodies
        .iter()
        .map(|b| b["event"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["check", "check", "refused"]);
    assert_eq!(
        (&bodies[0]["name"], &bodies[0]["conclusion"]),
        (&json!("unit"), &json!("pass"))
    );
    assert_eq!(bodies[2]["ticket"], ticket);
    assert_eq!(bodies[2]["error_code"], "CONFLICT");
    assert_eq!(bodies[2]["commit"], json!(stale));
}

#[test]
fn delivery_is_leased_retried_with_backoff_and_switched_off_after_50_failures() {
    let (h, root) = seeded();
    let hook = create(&h, OWNER, json!({"events":["land"]})).unwrap()["id"].clone();
    landed_child(&h, &root, "a.txt");
    landed_child(&h, &root, "b.txt");
    fanout(&h);
    let claim = h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":hook}));
    assert_eq!(claim["secret"], "whsec_0123456789abcdef0123456789abcdef");
    assert_eq!(claim["url"], "https://ci.example.com/hook");
    let busy = h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":hook}));
    assert_eq!(
        (busy["busy"].clone(), busy["leased"].clone()),
        (json!(true), json!(true))
    );
    let settle = |claim: &Value, ok: bool| {
        h.ok(
            HOOKS,
            json!({"op":"repo_hook_settle","hook_id":hook,"seq":claim["seq"],"attempt":claim["attempt"],"ok":ok,"status":if ok {200} else {500},"ms":7}),
        )
    };
    let failed = settle(&claim, false);
    assert_eq!(failed["retry_after_ms"], 10_000);
    assert_eq!(
        settle(&claim, false)["stale"],
        true,
        "an attempt settles once"
    );
    let waiting = h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":hook}));
    assert_eq!(waiting["busy"], true);
    assert!(waiting.get("leased").is_none());
    // After the backoff the same payload (same delivery id, same bytes) is retried first.
    *h.now.borrow_mut() += 10_000;
    let again = h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":hook}));
    assert_eq!(
        (&again["seq"], &again["body"], again["attempt"].as_i64()),
        (&claim["seq"], &claim["body"], Some(2))
    );
    settle(&again, true);
    let log =
        h.ok(OWNER, json!({"op":"repo_hook_deliveries","hook_id":hook}))["deliveries"].clone();
    assert_eq!(
        log.as_array()
            .unwrap()
            .iter()
            .map(|d| (
                d["attempt"].as_i64().unwrap(),
                d["ok"].as_bool().unwrap(),
                d["status"].as_i64()
            ))
            .collect::<Vec<_>>(),
        [(2, true, Some(200)), (1, false, Some(500))]
    );

    // 50 consecutive failures switch the hook off; the log keeps the last 50 attempts.
    for _ in 0..50 {
        *h.now.borrow_mut() += 20 * 60_000;
        let next = h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":hook}));
        assert!(next["seq"].is_i64(), "{next}");
        settle(&next, false);
    }
    let listed = &h.ok(OWNER, json!({"op":"repo_hooks"}))["hooks"][0];
    assert_eq!(
        (&listed["active"], &listed["failures"]),
        (&json!(false), &json!(50))
    );
    assert_eq!(
        h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":hook}))["reason"],
        "inactive"
    );
    let log = h.ok(OWNER, json!({"op":"repo_hook_deliveries","hook_id":hook}));
    assert_eq!(log["deliveries"].as_array().unwrap().len(), 50);
    landed_child(&h, &root, "c.txt");
    assert_eq!(
        fanout(&h)["hooks"],
        json!([]),
        "an inactive hook gets nothing new"
    );
}

#[test]
fn a_deleted_hook_stops_delivery() {
    let (h, root) = seeded();
    let hook = create(&h, OWNER, json!({})).unwrap()["id"].clone();
    landed_child(&h, &root, "a.txt");
    fanout(&h);
    let claim = h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":hook}));
    h.ok(OWNER, json!({"op":"repo_hook_delete","hook_id":hook}));
    let settled = h.ok(
        HOOKS,
        json!({"op":"repo_hook_settle","hook_id":hook,"seq":claim["seq"],"attempt":claim["attempt"],"ok":true,"ms":1}),
    );
    assert_eq!(settled["stale"], true);
    assert_eq!(
        h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":hook}))["reason"],
        "deleted"
    );
}

#[test]
fn upgrades_from_the_checkpoint_digest_schema_and_stamps_rfc3339_times() {
    let db = crate::native::NativeStore::memory().unwrap();
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &PRE_HOOKS[..]).unwrap();
    db.query("INSERT INTO repo_settings(id,workspace,owner,object_store,policy,policy_digest,created_at) VALUES('repository','ws-1','user:owner','r2','{}','d',1)", &[]).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    assert_eq!(
        db.query("SELECT MAX(version) AS v FROM repo_schema_migrations", &[])
            .unwrap()[0]["v"],
        25
    );
    assert!(db.query("SELECT id FROM hooks", &[]).unwrap().is_empty());
    assert_eq!(
        db.query("SELECT owner FROM repo_settings", &[]).unwrap()[0]["owner"],
        "user:owner"
    );
    assert_eq!(super::super::hooks::iso(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(
        super::super::hooks::iso(1_700_000_123_456),
        "2023-11-14T22:15:23.456Z"
    );
    assert_eq!(
        super::super::hooks::iso(951_782_400_000),
        "2000-02-29T00:00:00.000Z"
    );
}

/// The schema as it stood before hooks (migrations 1-24).
static PRE_HOOKS: std::sync::LazyLock<Vec<(i64, &'static str)>> =
    std::sync::LazyLock::new(|| super::super::migration::MIGRATIONS[..24].to_vec());
