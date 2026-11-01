use super::*;

/// A reason's code, and what brings it about.
type Case = (&'static str, fn(&mut LandingState));

/// A Landing nothing stands in the way of.
fn clear() -> LandingState {
    LandingState {
        gates_ready: true,
        approvals: 1,
        approved_by: vec!["user:ada".into()],
        requirements: vec![line("Approvals", RequirementState::Ready)],
        base_exists: true,
        ..LandingState::default()
    }
}

fn line(name: &str, state: RequirementState) -> Requirement {
    Requirement {
        name: name.into(),
        state,
        why: "why".into(),
    }
}

fn codes(clearance: &Clearance) -> Vec<&str> {
    clearance
        .reasons()
        .iter()
        .map(|r| r.code.as_str())
        .collect()
}

#[test]
fn a_clear_landing_is_cleared_and_says_nothing() {
    assert_eq!(clearance(&clear()), Clearance::Cleared);
    assert!(clearance(&clear()).reasons().is_empty());
}

#[test]
fn each_rule_holds_on_its_own() {
    let cases: Vec<Case> = vec![
        ("DRAFT", |s| s.draft = true),
        ("GATES", |s| {
            s.gates_ready = false;
            s.requirements = vec![line("Approvals", RequirementState::Waiting)];
        }),
        ("GATES", |s| s.gates_ready = false),
        ("COMMENTS", |s| s.unresolved_comments = true),
        ("NO_BASE", |s| s.base_exists = false),
        ("AUTOMATION_PAUSED", |s| {
            s.paused_by = Some("user:ada".into())
        }),
        ("OUTSIDE_GRANT", |s| s.outside_grant = true),
        ("LEGAL_HOLD", |s| s.legal_hold = Some("Held".into())),
        ("REPO_FULL", |s| s.repo_full = Some("Full".into())),
        ("FORK_NEEDS_APPROVAL", |s| {
            s.from_fork = true;
            s.approvals = 0;
            s.auto_approved = true;
        }),
        ("NOTHING_REQUIRED", |s| s.approvals = 0),
    ];
    for (code, change) in cases {
        let mut state = clear();
        change(&mut state);
        let decided = clearance(&state);
        assert_eq!(decided.decision(), Decision::Hold, "{code}");
        assert_eq!(codes(&decided), [code]);
    }
}

#[test]
fn what_the_work_has_to_answer_goes_around() {
    let cases: Vec<Case> = vec![
        ("GATES", |s| {
            s.gates_ready = false;
            s.requirements = vec![line("unit", RequirementState::Blocked)];
        }),
        ("FINDINGS", |s| {
            s.gates_ready = false;
            s.open_findings = 2;
        }),
        ("CHECK_FAILED", |s| s.failed_checks = vec!["lint".into()]),
        ("CONFLICT", |s| s.conflict = Some("Stale read".into())),
    ];
    for (code, change) in cases {
        let mut state = clear();
        change(&mut state);
        let decided = clearance(&state);
        assert_eq!(decided.decision(), Decision::GoAround, "{code}");
        assert_eq!(codes(&decided), [code]);
    }
}

#[test]
fn a_go_around_outranks_a_hold_and_keeps_every_reason() {
    let mut state = clear();
    state.draft = true;
    state.failed_checks = vec!["lint".into()];
    let decided = clearance(&state);
    assert_eq!(decided.decision(), Decision::GoAround);
    assert_eq!(codes(&decided), ["CHECK_FAILED", "DRAFT"]);
}

#[test]
fn an_auto_approved_landing_or_a_required_check_is_evidence() {
    let mut state = clear();
    state.approvals = 0;
    state.auto_approved = true;
    assert_eq!(clearance(&state), Clearance::Cleared);
    state.auto_approved = false;
    state.rules_ask = true;
    assert_eq!(clearance(&state), Clearance::Cleared);
}

#[test]
fn the_same_state_always_gives_the_same_decision() {
    let mut state = clear();
    state.draft = true;
    state.unresolved_comments = true;
    state.failed_checks = vec!["a".into(), "b".into()];
    let first = clearance(&state);
    let replayed: LandingState =
        serde_json::from_value(serde_json::to_value(&state).unwrap()).unwrap();
    assert_eq!(replayed, state);
    assert_eq!(clearance(&replayed), first);
}

#[test]
fn a_failed_attempt_goes_around_only_for_what_the_work_must_answer() {
    assert_eq!(
        attempt_failed("CONFLICT", "x").decision(),
        Decision::GoAround
    );
    assert_eq!(
        attempt_failed("STALE_PARENT", "x").decision(),
        Decision::GoAround
    );
    assert_eq!(attempt_failed("UNFINISHED", "x").decision(), Decision::Hold);
    assert_eq!(
        attempt_failed("REPO_FULL", "x").reasons()[0].code,
        "REPO_FULL"
    );
}

#[test]
fn a_landing_ahead_with_a_read_conflict_holds_it_by_name() {
    let mut state = clear();
    state.ahead = vec![Ahead {
        landing: 7,
        paths: vec!["src/a.rs".into(), "src/b.rs".into()],
    }];
    let held = clearance(&state);
    assert_eq!(held.decision(), Decision::Hold);
    assert_eq!(codes(&held), ["SEPARATION"]);
    assert_eq!(
        held.reasons()[0].reason,
        "Landing 7 is ahead in the queue on src/a.rs, src/b.rs: it lands first"
    );
    // A go-around outranks it.
    state.conflict = Some("stale".into());
    assert_eq!(clearance(&state).decision(), Decision::GoAround);
}

#[test]
fn a_state_recorded_before_separation_replays() {
    let mut recorded = serde_json::to_value(clear()).unwrap();
    assert!(
        recorded.get("ahead").is_none(),
        "nothing ahead: nothing recorded"
    );
    recorded.as_object_mut().unwrap().remove("ahead");
    let state: LandingState = serde_json::from_value(recorded).unwrap();
    assert_eq!(clearance(&state), Clearance::Cleared);
}
