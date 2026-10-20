use super::*;

#[test]
fn planner_describes_the_approved_app_host_instead_of_a_static_only_constraint() {
    let payload = json!({"run":{"intent":"Complete a persistent booking app","criteria":["Real API and durable registrations"],"agents":[{"provider":"codex","model":"gpt-5.6-luna"}]},"policy":{"build":{"app":{"version":1,"entrypoint":"dist/worker.js","export_name":"App","migrations":[],"seed":[]}}}});
    let result = prompt(&payload).unwrap();
    assert!(result.contains("managed SQLite"));
    assert!(result.contains("JS/TS"));
    assert!(result.contains("outbound network"));
    assert!(!result.contains("does not deploy backend servers or SQLite databases"));
    assert!(!result.contains("required separate deployment"));
}

#[test]
fn planner_uses_actual_brief_and_frozen_roster_without_source_authority() {
    let payload = json!({"run":{"intent":"Build a bilingual bike club with SQLite API","criteria":["English and Spanish"],"agents":[{"provider":"mimo","model":"selected-model"}],"base":{"commit":"exact-base"},"context_records":[{"id":"prior-contract"}]},"policy":{"build":{"static_dir":"public"}}});
    let result = prompt(&payload).unwrap();
    for required in [
        "bilingual bike club",
        "SQLite API",
        "English and Spanish",
        "selected-model",
        "exact-base",
        "prior-contract",
        "do not create",
        "team_plan_propose",
        "separate deployment",
        "one-agent teams",
    ] {
        assert!(result.contains(required), "Missing {required}");
    }
    assert!(prompt(&json!({"run":{"agents":[]}})).is_err());
}
