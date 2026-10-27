//! Model runners (`kind: "model"`): parsed and validated with the policy, digest-stable
//! for command runners, claimed with the rubric and the commit message, posted only by the
//! platform's own run, and gated like any check.
use super::*;

fn set(h: &Harness, policy: Value) -> yoneda_core::Result<Value> {
    h.run(OWNER, json!({"op":"repo_set_policy","policy":policy}))
}

fn security(rubric: &str) -> Value {
    json!({"required_checks":["security"],"approvals":0,
        "runners":{"security":{"kind":"model","rubric":rubric}}})
}

#[test]
fn model_runners_parse_with_catalog_defaults_and_reject_bad_shapes() {
    let (h, _) = seeded();
    let saved = set(&h, security("Fail on SQL built by string concatenation.")).unwrap();
    // The default model is filled in, so the digest names exactly what runs.
    assert_eq!(
        saved["policy"]["runners"]["security"],
        json!({"kind":"model","rubric":"Fail on SQL built by string concatenation.","model":"glm-5.3-flash"})
    );
    for runner in [
        json!({"kind":"model","rubric":""}),
        json!({"kind":"model","rubric":"   "}),
        json!({"kind":"model","rubric":"x".repeat(8_001)}),
        json!({"kind":"model","rubric":"x","model":"claude-opus-5-5"}),
        json!({"kind":"model","rubric":"x","command":["sh"]}),
        json!({"kind":"model","rubric":"x","tools":["bash"]}),
        json!({"kind":"agent","rubric":"x"}),
        json!({"kind":7,"command":["x"]}),
        json!({"kind":"command","rubric":"x"}),
    ] {
        let policy = json!({"required_checks":[],"approvals":0,"runners":{"review":runner}});
        assert_eq!(code(set(&h, policy)), "INVALID_INPUT", "{runner}");
    }
}

#[test]
fn command_runner_digests_are_unchanged_by_model_runner_support() {
    let (h, _) = seeded();
    let plain = json!({"required_checks":["unit"],"approvals":1,
        "runners":{"unit":{"command":["sh","-c","test"],"timeout_seconds":600}}});
    let saved = set(&h, plain.clone()).unwrap();
    // Exactly the digest the policy had before runner kinds existed.
    assert_eq!(
        saved["policy_digest"],
        json!(yoneda_core::fingerprint(&plain).unwrap())
    );
    let mut tagged = plain.clone();
    tagged["runners"]["unit"]["kind"] = json!("command");
    assert_eq!(
        set(&h, tagged).unwrap()["policy_digest"],
        saved["policy_digest"]
    );
    // Rubric, model and truncation all bind the digest of a model runner.
    let a = set(&h, security("a")).unwrap()["policy_digest"].clone();
    let b = set(&h, security("b")).unwrap()["policy_digest"].clone();
    let mut lenient = security("a");
    lenient["runners"]["security"]["allow_truncated"] = json!(true);
    let c = set(&h, lenient).unwrap()["policy_digest"].clone();
    assert!(a != b && a != c && b != c);
}

#[test]
fn model_runs_are_claimed_with_rubric_and_intent_and_gate_landing() {
    let (h, root) = seeded();
    set(&h, security("No SQL string concatenation.")).unwrap();
    let id = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("db.py", "q = 'x'\n")]),
            json!([]),
        )
        .unwrap();
    let detail = h.ok(OWNER, json!({"op":"repo_commit","commit":id}));
    let run = detail["check_runs"][0]["id"].as_str().unwrap().to_owned();
    // A runner-named check comes only from the platform's run (B2a), model runners too.
    for poster in [AGENT, OWNER] {
        let posted = h.run(
            poster,
            json!({"op":"repo_check","commit":id,"name":"security","status":"pass"}),
        );
        assert_eq!(code(posted), "FORBIDDEN");
    }
    let claimed = h.ok(SYSTEM, json!({"op":"repo_check_claim","run_id":run}));
    assert_eq!(claimed["kind"], "model");
    assert_eq!(claimed["rubric"], "No SQL string concatenation.");
    assert_eq!(claimed["model"], "glm-5.3-flash");
    assert_eq!(claimed["message"], "change");
    assert_eq!(claimed["parents"], json!([root]));
    assert!(claimed.get("command").is_none());
    // Its lease covers two bounded calls, not a container's ten minutes.
    assert!(h.ok(SYSTEM, json!({"op":"repo_check_claim","run_id":run}))["busy"] == true);
    *h.now.borrow_mut() += 120_000 + 5 * 60_000;
    let epoch = h.ok(SYSTEM, json!({"op":"repo_check_claim","run_id":run}))["epoch"].clone();
    assert_eq!(epoch, 2);

    // An error (model unreachable, malformed twice) records nothing: still blocked.
    h.ok(
        SYSTEM,
        json!({"op":"repo_check_complete","run_id":run,"epoch":epoch,
        "outcome":"error","evidence":{"kind":"model","code":"MODEL_CHECK_ERROR"}}),
    );
    let gates = &h.ok(OWNER, json!({"op":"repo_commit","commit":id}))["gates"];
    assert_eq!(gates["missing_checks"], json!(["security"]));
    let land = json!({"op":"repo_land","ref":"main","commit":id});
    assert_eq!(code(h.run(OWNER, land.clone())), "NOT_READY");

    // A fail verdict is a failing check with the findings as evidence.
    let rerun = h.ok(
        CI,
        json!({"op":"repo_check_request","commit":id,"name":"security"}),
    )["runs"][0]["id"]
        .clone();
    let epoch = h.ok(SYSTEM, json!({"op":"repo_check_claim","run_id":rerun}))["epoch"].clone();
    let evidence = json!({"kind":"model","verdict":"fail","score":10,
        "findings":[{"path":"db.py","line":1,"severity":"high","message":"SQL concatenation"}]});
    h.ok(
        SYSTEM,
        json!({"op":"repo_check_complete","run_id":rerun,"epoch":epoch,
        "outcome":"fail","evidence":evidence}),
    );
    let detail = h.ok(OWNER, json!({"op":"repo_commit","commit":id}));
    assert_eq!(detail["gates"]["failing_checks"], json!(["security"]));
    assert_eq!(detail["checks"][0]["status"], "fail");
    assert_eq!(code(h.run(OWNER, land)), "NOT_READY");
}
