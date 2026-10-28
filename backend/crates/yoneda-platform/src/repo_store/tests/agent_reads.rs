//! Repository-wide agent records for the web: sessions newest first with CLI, model and
//! branch filters and a cursor; one session with its commit, declared reads and the other
//! commits of the same session; contract records, pins and bisects. Path-restricted tokens
//! read no sessions, pins or bisects, and only the contract records inside their grant.
use super::*;

fn record(h: &Harness, who: &str, commit: &str, cli: &str, transcript: Option<&str>) -> Value {
    h.ok(
        who,
        json!({ "op": "repo_session_record", "commit": commit, "cli": cli,
                "model": format!("{cli}-model"), "summary": format!("{cli} on {}", &commit[..6]),
                "transcript_ref": transcript }),
    )
}

fn ids(listed: &Value) -> Vec<i64> {
    listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_i64().unwrap())
        .collect()
}

#[test]
fn sessions_list_newest_first_with_filters_and_cursor() {
    let (h, root) = seeded();
    // `branch` is cut from main and never lands: its sessions are not on main.
    let branch = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn b() {}\n")]),
            json!(["src/"]),
        )
        .unwrap();
    let on_main = record(&h, OWNER, &root, "claude-code", Some("claude-code:s1"))["session"]
        .as_i64()
        .unwrap();
    let first = record(&h, AGENT, &branch, "opencode", Some("opencode:s2"))["session"]
        .as_i64()
        .unwrap();
    let second = h.ok(
        AGENT,
        json!({ "op": "repo_session_record", "commit": branch, "cli": "opencode",
                "summary": "follow-up", "transcript_ref": "opencode:s2" }),
    )["session"]
        .as_i64()
        .unwrap();

    let all = h.ok(CI, json!({"op":"repo_session_list"}));
    assert_eq!(ids(&all), [second, first, on_main]);
    assert_eq!(all["sessions"][0]["subject"], "change");
    assert_eq!(all["sessions"][1]["reads"], 1);
    assert_eq!(all["clis"], json!(["claude-code", "opencode"]));
    assert_eq!(
        all["models"],
        json!(["claude-code-model", "opencode-model"])
    );
    assert_eq!(all["next"], Value::Null);

    let by_cli = h.ok(CI, json!({"op":"repo_session_list","cli":"claude-code"}));
    assert_eq!(ids(&by_cli), [on_main]);
    let by_model = h.ok(
        CI,
        json!({"op":"repo_session_list","model":"opencode-model"}),
    );
    assert_eq!(ids(&by_model), [first]);
    let on_branch = h.ok(CI, json!({"op":"repo_session_list","ref":"main"}));
    assert_eq!(ids(&on_branch), [on_main]);
    assert_eq!(on_branch["ref"], "refs/heads/main");
    assert!(
        ids(&h.ok(CI, json!({"op":"repo_session_list","ref":"nowhere"}))).is_empty(),
        "an unknown branch holds no sessions"
    );

    // One page at a time: `next` is the cursor for the page after.
    let page = h.ok(CI, json!({"op":"repo_session_list","limit":2}));
    assert_eq!(ids(&page), [second, first]);
    let rest = h.ok(
        CI,
        json!({"op":"repo_session_list","limit":2,"before":page["next"]}),
    );
    assert_eq!(ids(&rest), [on_main]);
    assert_eq!(rest["next"], Value::Null);
    assert_eq!(
        code(h.run(CI, json!({"op":"repo_session_list","before":-1}))),
        "INVALID_INPUT"
    );

    // One session: its commit, declared reads and the session's other commit records.
    let shown = h.ok(CI, json!({"op":"repo_session_show","id":first}));
    assert_eq!(shown["session"]["cli"], "opencode");
    assert_eq!(shown["commit"]["id"], json!(branch));
    assert_eq!(shown["commit"]["parents"], json!([root]));
    assert_eq!(shown["reads"], json!(["src/"]));
    let related: Vec<i64> = shown["related"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_i64().unwrap())
        .collect();
    assert_eq!(related, [second]);
    assert_eq!(
        code(h.run(CI, json!({"op":"repo_session_show","id":999}))),
        "NOT_FOUND"
    );

    // A path-restricted token reads none of it.
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read"],"paths":["docs/"],
        "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    for op in ["repo_session_list", "repo_pin_list", "repo_bisect_list"] {
        assert_eq!(code(h.run("token:docs", json!({"op":op}))), "FORBIDDEN");
    }
    assert_eq!(
        code(h.run("token:docs", json!({"op":"repo_session_show","id":first}))),
        "FORBIDDEN"
    );
}

#[test]
fn contracts_pins_and_bisects_list_for_the_repository() {
    let (h, root) = seeded();
    let digest = "c".repeat(64);
    for (path, summary) in [("src/lib.rs", "Does a."), ("docs/a.md", "Docs.")] {
        h.ok(
            AGENT,
            json!({"op":"repo_record_contract","commit":root,"path":path,"symbol_path":"a",
                   "node_digest":digest,"contract":{"summary":summary}}),
        );
    }
    let contracts = h.ok(CI, json!({"op":"repo_contract_list","limit":1}));
    assert_eq!(contracts["records"][0]["path"], "docs/a.md");
    assert_eq!(contracts["records"][0]["contract"]["summary"], "Docs.");
    let older = h.ok(
        CI,
        json!({"op":"repo_contract_list","before":contracts["next"]}),
    );
    assert_eq!(older["records"][0]["path"], "src/lib.rs");
    assert_eq!(older["next"], Value::Null);
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read"],"paths":["docs/"],
        "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    let granted = h.ok("token:docs", json!({"op":"repo_contract_list"}));
    assert_eq!(granted["records"].as_array().unwrap().len(), 1);
    assert_eq!(granted["records"][0]["path"], "docs/a.md");

    assert_eq!(h.ok(CI, json!({"op":"repo_pin_list"}))["pins"], json!([]));
    h.ok(
        AGENT,
        json!({"op":"repo_pin","commit":root,"reason":"long job"}),
    );
    let pins = h.ok(CI, json!({"op":"repo_pin_list"}));
    assert_eq!(pins["pins"][0]["commit"], json!(root));
    assert_eq!(pins["pins"][0]["reason"], "long job");
    assert_eq!(pins["pins"][0]["pinned_by"], AGENT);

    let mut set = runner_policy(60);
    set["policy"]["required_checks"] = json!([]);
    set["policy"]["approvals"] = json!(0);
    set["op"] = json!("repo_set_policy");
    h.ok(OWNER, set);
    let mut chain = vec![root];
    for i in 1..=4 {
        let id = h
            .commit(
                AGENT,
                chain.last().map(String::as_str),
                i,
                json!([file("n.txt", &format!("{i}\n"))]),
                json!([]),
            )
            .unwrap();
        h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
        chain.push(id);
    }
    let started = h.ok(CI, json!({"op":"repo_bisect_start","ref":"main","check":"unit","good":chain[0],"bad":chain[4]}));
    let listed = h.ok(CI, json!({"op":"repo_bisect_list"}));
    let bisect = &listed["bisects"][0];
    assert_eq!(bisect["id"], started["id"]);
    assert_eq!(bisect["status"], "running");
    assert_eq!(bisect["check"], "unit");
    assert_eq!(bisect["ref"], "refs/heads/main");
    assert_eq!(bisect["candidates"], 4);
    assert_eq!(bisect["bad"], json!(chain[4]));
    assert_eq!(bisect["testing"], started["testing"]);
    assert_eq!(bisect["remaining"], started["remaining"]);
}

#[test]
fn sessions_list_the_commits_a_head_adds_over_its_base() {
    let (h, root) = seeded();
    let first = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn b() {}\n")]),
            json!(["src/"]),
        )
        .unwrap();
    let second = h
        .commit(
            AGENT,
            Some(&first),
            1,
            json!([file("src/lib.rs", "pub fn c() {}\n")]),
            json!(["src/"]),
        )
        .unwrap();
    let on_root = record(&h, OWNER, &root, "claude-code", None)["session"]
        .as_i64()
        .unwrap();
    let on_first = record(&h, AGENT, &first, "opencode", None)["session"]
        .as_i64()
        .unwrap();
    let on_second = record(&h, AGENT, &second, "codex", None)["session"]
        .as_i64()
        .unwrap();

    let range = h.ok(
        CI,
        json!({"op":"repo_session_list","head":second,"base":root}),
    );
    assert_eq!(
        ids(&range),
        [on_second, on_first],
        "the base's sessions are left out"
    );
    assert_eq!(range["head"], json!(second));
    assert_eq!(range["base"], json!(root));
    assert_eq!(range["branch_scan_truncated"], false);
    let whole = h.ok(CI, json!({"op":"repo_session_list","head":second}));
    assert_eq!(ids(&whole), [on_second, on_first, on_root]);
    let on_main = h.ok(
        CI,
        json!({"op":"repo_session_list","ref":"main","base":root}),
    );
    assert!(
        ids(&on_main).is_empty(),
        "main adds nothing over its own head"
    );

    for bad in [
        json!({"op":"repo_session_list","base":root}),
        json!({"op":"repo_session_list","ref":"main","head":second}),
        json!({"op":"repo_session_list","head":"not-a-commit"}),
        json!({"op":"repo_session_list","head":7}),
    ] {
        assert_eq!(code(h.run(CI, bad)), "INVALID_INPUT");
    }
}
