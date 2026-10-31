//! Separation: CTC holds a Landing while one ahead of it in the queue touches the same files with
//! a read conflict, and says which. Ahead means queued or cleared: a Landing that is merely
//! waiting holds nobody, or one left open would block every Landing behind it. Whatever clears
//! the way asks for the held Landing's job. Landing's own conflict rules don't change.
use super::land_when_cleared::{
    assess, branch, change, decisions, land, landing, switch_on, waiting,
};
use super::*;

/// `seeded` with the switch on, and a commit on `name` writing `path`, reading `reads`.
fn work(h: &Harness, root: &str, name: &str, path: &str, reads: Value) -> (String, i64) {
    let id = h
        .commit(AGENT, Some(root), 1, json!([file(path, name)]), reads)
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":name,"commit":id,"expected":null}),
    );
    let number = landing(h, name);
    h.approve_and_check(&id);
    (id, number)
}

fn repo() -> (Harness, String) {
    let (h, root) = seeded();
    switch_on(&h);
    (h, root)
}

/// A cleared Landing writing `src/a.rs`, then one that read it.
fn pair() -> (Harness, (String, i64), (String, i64)) {
    let (h, root) = repo();
    let front = work(&h, &root, "front", "src/a.rs", json!([]));
    assert_eq!(assess(&h, front.1)["state"], "cleared");
    let behind = work(&h, &root, "behind", "src/b.rs", json!(["src/a.rs"]));
    (h, front, behind)
}

#[test]
fn a_read_conflict_with_a_landing_ahead_holds_it_and_names_that_landing() {
    let (h, front, behind) = pair();
    let held = assess(&h, behind.1);
    assert_eq!(held["state"], "hold", "{held}");
    assert_eq!(waiting(&held), ["SEPARATION"]);
    let why = held["reasons"][0]["reason"].as_str().unwrap();
    assert!(why.contains(&format!("Landing {}", front.1)), "{why}");
    assert!(why.contains("src/a.rs"), "{why}");
    // The record says so, and the job could not land it if it tried.
    assert_eq!(decisions(&h, behind.1)[0]["reasons"][0]["code"], "SEPARATION");
    assert_eq!(code(land(&h, behind.1, &behind.0)), "SEPARATION");
    // The page reads the same decision.
    let gates = h.ok(OWNER, json!({"op":"repo_change_gates","number":behind.1}));
    assert_eq!(gates["land_when_cleared"]["reasons"][0]["code"], "SEPARATION");
}

#[test]
fn the_landing_ahead_is_not_held_by_the_one_behind() {
    let (h, front, behind) = pair();
    assess(&h, behind.1);
    assert_eq!(assess(&h, front.1)["state"], "cleared");
    assert_eq!(land(&h, front.1, &front.0).unwrap()["landed"], true);
}

#[test]
fn it_reads_both_ways_and_a_write_with_no_declared_reads_counts_as_a_read() {
    let (h, root) = repo();
    // The one ahead read what this one writes.
    let front = work(&h, &root, "front", "src/x.rs", json!(["src/shared.rs"]));
    assert_eq!(assess(&h, front.1)["state"], "cleared");
    let writes = work(&h, &root, "writes", "src/shared.rs", json!(["src/y.rs"]));
    assert_eq!(waiting(&assess(&h, writes.1)), ["SEPARATION"]);
    // Two writers of one file where neither declared a read.
    let (h, root) = repo();
    let front = work(&h, &root, "front", "src/x.rs", json!([]));
    assert_eq!(assess(&h, front.1)["state"], "cleared");
    let second = work(&h, &root, "second", "src/x.rs", json!([]));
    assert_eq!(waiting(&assess(&h, second.1)), ["SEPARATION"]);
}

#[test]
fn landings_on_other_files_pass_each_other() {
    let (h, root) = repo();
    let front = work(&h, &root, "front", "src/a.rs", json!([]));
    assert_eq!(assess(&h, front.1)["state"], "cleared");
    let other = work(&h, &root, "other", "src/b.rs", json!(["src/c.rs"]));
    assert_eq!(assess(&h, other.1)["state"], "cleared");
}

#[test]
fn a_landing_that_is_only_waiting_holds_nobody() {
    let (h, root) = repo();
    // Older, on the same file, and nobody will ever approve it.
    let id = branch(&h, AGENT, &root, "abandoned", "src/a.rs");
    let older = landing(&h, "abandoned");
    let _ = (id, older);
    let newer = work(&h, &root, "newer", "src/a.rs", json!(["src/a.rs"]));
    assert_eq!(assess(&h, newer.1)["state"], "cleared");
}

#[test]
fn a_queued_ticket_is_ahead() {
    let (h, root) = repo();
    let front = work(&h, &root, "front", "src/a.rs", json!([]));
    // main moves, so the landing has to wait for a merge.
    let moved = work(&h, &root, "moved", "src/m.rs", json!([]));
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":moved.0}));
    let queued = h.ok(
        OWNER,
        json!({"op":"repo_land_enqueue","ref":"main","commit":front.0}),
    );
    assert_eq!(queued["queued"], true, "{queued}");
    let behind = work(&h, &root, "behind", "src/b.rs", json!(["src/a.rs"]));
    assert_eq!(waiting(&assess(&h, behind.1)), ["SEPARATION"]);
}

#[test]
fn landing_the_one_ahead_asks_for_the_held_landing_then_its_own_rules_decide() {
    let (h, front, behind) = pair();
    assess(&h, behind.1);
    let landed = land(&h, front.1, &front.0).unwrap();
    let again = landed["land_checks"].as_array().unwrap();
    assert!(again.contains(&json!(behind.1)), "{landed}");
    // Separation only ordered them: the stale read is landing's own conflict.
    let judged = assess(&h, behind.1);
    assert_eq!(judged["state"], "go_around", "{judged}");
    assert_eq!(waiting(&judged), ["CONFLICT"]);
}

#[test]
fn closing_the_one_ahead_or_its_failing_clears_the_way() {
    let (h, front, behind) = pair();
    assess(&h, behind.1);
    let closed = h.ok(OWNER, json!({"op":"repo_change_close","number":front.1}));
    assert!(
        closed["land_checks"].as_array().unwrap().contains(&json!(behind.1)),
        "{closed}"
    );
    assert_eq!(assess(&h, behind.1)["state"], "cleared");

    let (h, front, behind) = pair();
    assess(&h, behind.1);
    let failed = h.ok(
        "platform:land-when-cleared",
        json!({"op":"repo_land_clearance","number":front.1,
               "failed":{"head":front.0,"code":"MERGE_FAILED","message":"It did not land"}}),
    );
    assert_eq!(failed["land_checks"], json!([behind.1]), "{failed}");
    assert_eq!(assess(&h, behind.1)["state"], "cleared");
}

#[test]
fn a_new_head_on_the_one_ahead_clears_the_way() {
    let (h, front, behind) = pair();
    assess(&h, behind.1);
    let newer = h
        .commit(AGENT, Some(&front.0), 1, json!([file("src/new.rs", "x")]), json!([]))
        .unwrap();
    let moved = h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"front","commit":newer,"expected":front.0}),
    );
    assert!(
        moved["land_checks"].as_array().unwrap().contains(&json!(behind.1)),
        "{moved}"
    );
    assert_eq!(assess(&h, behind.1)["state"], "cleared");
}

#[test]
fn a_clearance_nobody_acted_on_stops_holding_after_a_while() {
    let (h, _, behind) = pair();
    assert_eq!(waiting(&assess(&h, behind.1)), ["SEPARATION"]);
    // The job died between clearing and landing, and its last word was lost too.
    *h.now.borrow_mut() += 11 * 60 * 1000;
    assert_eq!(assess(&h, behind.1)["state"], "cleared");
}

#[test]
fn a_person_lands_past_a_hold_as_ever() {
    let (h, _, behind) = pair();
    assert_eq!(waiting(&assess(&h, behind.1)), ["SEPARATION"]);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":behind.0}));
    assert_eq!(change(&h, behind.1)["status"], "landed");
}

#[test]
fn off_nothing_is_ahead_and_no_read_is_added() {
    let (h, root) = seeded();
    let front = work(&h, &root, "front", "src/a.rs", json!([]));
    let _ = front;
    let gates = |h: &Harness, n| {
        let before = h.db.counts();
        h.ok(OWNER, json!({"op":"repo_change_gates","number":n}));
        h.db.counts() - before
    };
    let first = gates(&h, 1);
    let behind = work(&h, &root, "behind", "src/b.rs", json!(["src/a.rs"]));
    assert_eq!(gates(&h, behind.1).statements, first.statements);
}
