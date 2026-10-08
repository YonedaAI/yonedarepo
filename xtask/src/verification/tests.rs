use super::*;
use serde_json::json;
#[test]
fn research_and_one_coder_do_not_prove_a_complete_exploration() {
    let s = json!({"executions":[{"harness":"claude","role":"research","status":"completed"},{"harness":"codex","role":"coding","strategy":"minimal","status":"completed"}],"decisions":[{"status":"published"}]});
    assert!(check(&s, &[], &json!({"coverage":"recorded"})).is_err());
}
fn complete_fixture() -> (Value, Vec<Value>, Value) {
    let policy = yoneda_core::Policy::default();
    let mut s = json!({"repository":{"pending":null,"published_commit":"c".repeat(40),"policy":policy},"decisions":[{"id":"decision","run_id":"run","candidate":"candidate-minimal","status":"published","created_at":1}],"executions":[{"id":"research","run_id":"run","role":"research","harness":"claude","status":"completed"}],"candidates":[],"evaluations":[],"artifacts":[{"id":"shared","producer":"research"}]});
    let mut events = Vec::new();
    for (i, (strategy, harness)) in [
        ("minimal", "codex"),
        ("defensive", "claude"),
        ("maintainable", "codex"),
    ]
    .into_iter()
    .enumerate()
    {
        s["executions"].as_array_mut().unwrap().push(json!({"id":strategy,"run_id":"run","role":"coding","strategy":strategy,"harness":harness,"status":"completed","epoch":1,"context":["shared"]}));
        let revision = json!({"repository":"yoneda/fork","commit":"c".repeat(40)});
        s["candidates"].as_array_mut().unwrap().push(json!({"id":format!("candidate-{strategy}"),"execution":strategy,"run_id":"run","revision":revision,"evaluation":strategy}));
        s["evaluations"].as_array_mut().unwrap().push(json!({"id":strategy,"candidate":format!("candidate-{strategy}"),"revision":revision,"policy":policy.version,"suite":policy.suite,"environment":policy.environment,"evidence":"e".repeat(64),"checks":[{"name":"build","status":"pass","detail":""},{"name":"behavior","status":"pass","detail":""}]}));
        events.push(json!({"kind":"artifact.retrieved","at":9,"data":{"execution":strategy,"artifact":"shared","epoch":1}}));
        events.push(json!({"kind":"job.progress","at":10+i,"data":{"id":format!("job:{strategy}"),"epoch":1,"progress":{"stage":"harness_running"}}}));
        events
            .push(json!({"kind":"job.completed","at":50,"data":{"id":format!("job:{strategy}"),"epoch":1}}));
    }
    events.sort_by_key(|e| e["at"].as_i64());
    let why = json!({"coverage":"recorded","nodes":[{"id":"decision","kind":"decision"},{"id":"candidate-defensive","kind":"candidate"},{"id":"assumption","kind":"assumption","data":{"statement":"Original assumption"}},{"id":"incident","kind":"observation","data":{"simulated":true}}],"edges":[{"source":"incident","target":"assumption","relation":"challenges"}]});
    (s, events, why)
}
#[test]
fn verification_requires_one_complete_run_overlap_current_checks_and_incident() {
    let (s, events, why) = complete_fixture();
    assert!(check(&s, &events, &why).is_ok());
    let mut failed = s.clone();
    failed["executions"][2]["status"] = json!("failed");
    assert!(check(&failed, &events, &why).is_err());
    let mut context = s.clone();
    context["executions"][2]["context"] = json!(["other"]);
    assert!(check(&context, &events, &why).is_err());
    let mut old = s.clone();
    old["evaluations"][0]["suite"] = json!("old");
    assert!(check(&old, &events, &why).is_err());
    let mut serial = events.clone();
    serial
        .iter_mut()
        .filter(|e| e["kind"] == "job.progress" && e["data"]["id"] == "job:defensive")
        .for_each(|e| e["at"] = json!(100));
    assert!(check(&s, &serial, &why).is_err());
    assert!(
        check(
            &s,
            &events,
            &json!({"coverage":"recorded","nodes":[],"edges":[]})
        )
        .is_err()
    );
}
#[test]
fn overlap_must_belong_to_the_completed_attempt_epochs() {
    let (mut s, mut events, why) = complete_fixture();
    for execution in s["executions"].as_array_mut().unwrap().iter_mut().skip(1) {
        execution["epoch"] = json!(2);
    }
    for event in &mut events {
        event["data"]["epoch"] = json!(if event["kind"] == "artifact.retrieved" {
            2
        } else {
            1
        });
    }
    assert!(check(&s, &events, &why).is_err());
}

#[test]
fn shared_context_requires_successful_reads_by_each_completed_attempt() {
    let (s, mut events, why) = complete_fixture();
    events.retain(|e| e["kind"] != "artifact.retrieved" || e["data"]["execution"] != "defensive");
    assert!(check(&s, &events, &why).is_err());
    let (s, mut events, why) = complete_fixture();
    for event in &mut events {
        if event["kind"] == "artifact.retrieved" && event["data"]["execution"] == "defensive" {
            event["data"]["epoch"] = json!(2);
        }
    }
    assert!(check(&s, &events, &why).is_err());
}
