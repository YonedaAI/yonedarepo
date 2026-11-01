//! Land when cleared: with the repository's switch on, a queue job lands an open Landing once
//! its exact head clears. Each test plays the job: `repo_land_clearance`, again with the head's
//! Risk once nothing else stands in the way, then `repo_land` with the head it evaluated. Every
//! decision is recorded with its reasons and that head. Off, nothing changes.
use super::forks::{FORK_ID, FORKER, fork};
use super::*;
use crate::storage::SqlStore;

const LANDER: &str = "platform:land-when-cleared";
const MERGER: &str = "platform:merge";

pub(super) fn switch_on(h: &Harness) {
    h.ok(
        OWNER,
        json!({"op":"repo_auto_landings","land_when_cleared":true}),
    );
}

/// A commit on `parent` touching `path`, on branch `name`.
pub(super) fn branch(h: &Harness, who: &str, parent: &str, name: &str, path: &str) -> String {
    let id = h
        .commit(who, Some(parent), 1, json!([file(path, "x\n")]), json!([]))
        .unwrap();
    h.ok(
        who,
        json!({"op":"repo_branch_set","ref":name,"commit":id,"expected":null}),
    );
    id
}

/// An open Landing of `name` on main.
pub(super) fn landing(h: &Harness, name: &str) -> i64 {
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":name,"title":"Add it"}),
    )["number"]
        .as_i64()
        .unwrap()
}

/// The job's decision: it scores Risk only when asked to.
pub(super) fn assess(h: &Harness, number: i64) -> Value {
    let first = h.ok(LANDER, json!({"op":"repo_land_clearance","number":number}));
    if first["needs_risk"] != true {
        return first;
    }
    scored(h, number, "low")
}

pub(super) fn scored(h: &Harness, number: i64, level: &str) -> Value {
    let risk = json!({"level":level,"score":10,"why":["Small"]});
    h.ok(
        LANDER,
        json!({"op":"repo_land_clearance","number":number,"risk":risk}),
    )
}

pub(super) fn land(h: &Harness, number: i64, head: &str) -> yoneda_core::Result<Value> {
    h.run(
        LANDER,
        json!({"op":"repo_land","ref":"main","commit":head,"enqueue":true,
            "clearance":number,"expected_head":head}),
    )
}

pub(super) fn change(h: &Harness, number: i64) -> Value {
    h.ok(OWNER, json!({"op":"repo_change_show","number":number}))
}

fn main_head(h: &Harness) -> Value {
    h.ok(OWNER, json!({"op":"repo_refs"}))["refs"]["refs/heads/main"].clone()
}

fn newest_entry(h: &Harness) -> Value {
    let rows =
        h.db.query("SELECT entry FROM txlog ORDER BY version DESC LIMIT 1", &[]);
    serde_json::from_str(rows.unwrap()[0]["entry"].as_str().unwrap()).unwrap()
}

fn landings(h: &Harness) -> u64 {
    let rows = h.db.query(
        "SELECT COUNT(*) AS n FROM landings WHERE refname='refs/heads/main'",
        &[],
    );
    rows.unwrap()[0]["n"].as_u64().unwrap()
}

/// A second person's token, who may approve or reject what the owner's agents wrote.
fn reviewer(h: &Harness) -> &'static str {
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"reviewer","scopes":["read","review"],
            "_secret":"reviewer-secret-0123456789abcdef0123456789"}),
    );
    "token:reviewer"
}

pub(super) fn decisions(h: &Harness, number: i64) -> Vec<Value> {
    let shown = change(h, number);
    shown["clearances"].as_array().cloned().unwrap_or_default()
}

pub(super) fn waiting(answer: &Value) -> Vec<&str> {
    answer["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["code"].as_str().unwrap())
        .collect()
}

/// `seeded`, with the switch on and a Landing that has cleared.
fn cleared() -> (Harness, String, String, i64) {
    let (h, root) = seeded();
    switch_on(&h);
    let id = branch(&h, AGENT, &root, "fix", "src/a.rs");
    let number = landing(&h, "fix");
    h.approve_and_check(&id);
    assert_eq!(assess(&h, number)["state"], "cleared");
    (h, root, id, number)
}

#[test]
fn off_changes_nothing() {
    let (h, root) = seeded();
    let id = branch(&h, AGENT, &root, "fix", "src/a.rs");
    let number = landing(&h, "fix");
    let passed = h.ok(
        CI,
        json!({"op":"repo_check","commit":id,"name":"unit","status":"pass"}),
    );
    assert!(passed.get("land_checks").is_none(), "{passed}");
    let approved = h.ok(
        OWNER,
        json!({"op":"repo_review","commit":id,"decision":"approve"}),
    );
    assert!(approved.get("land_checks").is_none(), "{approved}");
    // The job finds the switch off and does nothing, even on a head that has cleared.
    assert_eq!(assess(&h, number)["state"], "off");
    assert_eq!(code(land(&h, number, &id)), "NOT_READY");
    assert_eq!(change(&h, number)["status"], "open");
    assert_eq!(decisions(&h, number), Vec::<Value>::new());
    // Reads hold nothing new.
    let gates = h.ok(OWNER, json!({"op":"repo_change_gates","number":number}));
    assert!(gates.get("land_when_cleared").is_none(), "{gates}");
    let commit = h.ok(OWNER, json!({"op":"repo_commit","commit":id,"ref":"main"}));
    assert!(commit["gates"].get("open_findings").is_none(), "{commit}");
    // An explicit landing is the same as ever.
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
    assert_eq!(change(&h, number)["status"], "landed");
    assert_eq!(decisions(&h, number), Vec::<Value>::new());
}

#[test]
fn what_can_clear_a_landing_asks_for_its_job() {
    let (h, root) = seeded();
    switch_on(&h);
    let id = branch(&h, AGENT, &root, "fix", "src/a.rs");
    let created = h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"fix","title":"Add it"}),
    );
    let number = created["number"].as_i64().unwrap();
    assert_eq!(created["land_checks"], json!([number]), "a new Landing");
    let check = json!({"op":"repo_check","commit":id,"name":"unit","status":"pass"});
    assert_eq!(h.ok(CI, check)["land_checks"], json!([number]));
    let failed = json!({"op":"repo_check","commit":id,"name":"lint","status":"fail"});
    assert!(h.ok(OWNER, failed).get("land_checks").is_none());
    let review = json!({"op":"repo_review","commit":id,"decision":"approve"});
    assert_eq!(h.ok(OWNER, review)["land_checks"], json!([number]));
    // A comment changes nothing; resolving one can clear.
    let anchor = json!({"op":"repo_change_comment","number":number,"commit":id,
        "path":"src/a.rs","line":1,"side":"new","body":"Why?"});
    assert!(h.ok(OWNER, anchor).get("land_checks").is_none());
    let resolve = json!({"op":"repo_change_comment","number":number,"commit":id,
        "path":"src/a.rs","line":1,"side":"new","resolve":true});
    assert_eq!(h.ok(OWNER, resolve)["land_checks"], json!([number]));
    // A new head.
    let next = h
        .commit(
            AGENT,
            Some(&id),
            1,
            json!([file("src/b.rs", "y\n")]),
            json!([]),
        )
        .unwrap();
    let moved = json!({"op":"repo_branch_set","ref":"fix","commit":next,"expected":id});
    assert_eq!(h.ok(AGENT, moved)["land_checks"], json!([number]));
    // Another commit's result has no Landing to clear.
    let other = json!({"op":"repo_check","commit":root,"name":"unit","status":"pass"});
    assert!(h.ok(CI, other).get("land_checks").is_none());
}

#[test]
fn a_cleared_landing_lands_as_the_platform_with_its_reasons() {
    let (h, _root, id, number) = cleared();
    let answer = assess(&h, number);
    assert_eq!(answer["state"], "cleared", "{answer}");
    assert_eq!(answer["commit"], id);
    assert_eq!(answer["ref"], "refs/heads/main");
    let landed = land(&h, number, &id).unwrap();
    assert_eq!(landed["landed"], true);
    assert_eq!(main_head(&h), id);
    let shown = change(&h, number);
    assert_eq!(shown["status"], "landed");
    let record = &shown["clearances"][0];
    assert_eq!(record["decision"], "cleared");
    assert_eq!(record["actor"], LANDER);
    assert_eq!(record["head"], id);
    assert_eq!(record["landed_version"], landed["version"]);
    assert_eq!(record["state"]["approved_by"], json!([OWNER]));
    assert_eq!(record["state"]["risk"]["level"], "low", "{record}");
    let gates = record["state"]["requirements"].as_array().unwrap();
    assert!(gates.iter().any(|g| g["name"] == "unit"), "{record}");
    assert!(gates.iter().any(|g| g["name"] == "Approvals"), "{record}");
    // The log says who moved main, and webhooks read that entry as for any landing.
    assert_eq!(newest_entry(&h)["actor"], LANDER);
    assert_eq!(newest_entry(&h)["refname"], "refs/heads/main");
}

#[test]
fn it_says_what_it_is_waiting_for_and_lands_nothing() {
    let (h, root) = seeded();
    switch_on(&h);
    let id = branch(&h, AGENT, &root, "fix", "src/a.rs");
    let number = landing(&h, "fix");
    let answer = assess(&h, number);
    assert_eq!(answer["state"], "hold");
    assert_eq!(waiting(&answer), ["GATES", "GATES"], "{answer}");
    // The page's answer is the job's: one function decides both.
    let gates = h.ok(OWNER, json!({"op":"repo_change_gates","number":number}));
    assert_eq!(gates["land_when_cleared"]["decision"], "hold");
    assert_eq!(gates["land_when_cleared"]["reasons"], answer["reasons"]);
    assert_eq!(code(land(&h, number, &id)), "GATES");
    assert_eq!(main_head(&h), json!(root));
    let recorded = decisions(&h, number);
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0]["decision"], "hold");
    assert_eq!(recorded[0]["head"], id);
    assert_eq!(recorded[0]["reasons"], answer["reasons"]);
}

#[test]
fn a_race_with_a_new_push_lands_nothing() {
    let (h, root, id, number) = cleared();
    assert_eq!(assess(&h, number)["state"], "cleared");
    let next = h
        .commit(
            AGENT,
            Some(&id),
            1,
            json!([file("src/b.rs", "y\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"fix","commit":next,"expected":id}),
    );
    // The land call carries the head it evaluated.
    assert_eq!(code(land(&h, number, &id)), "HEAD_MOVED");
    assert_eq!(main_head(&h), json!(root));
    assert_eq!(change(&h, number)["status"], "open");
    // The new head has no approvals of its own, so its job waits.
    assert_eq!(assess(&h, number)["state"], "hold");
}

#[test]
fn a_new_push_after_the_ticket_is_queued_fails_the_ticket() {
    let (h, root, id, number) = cleared();
    moved_on(&h, &root);
    let queued = land(&h, number, &id).unwrap();
    assert_eq!(queued["queued"], true, "{queued}");
    let next = h
        .commit(
            AGENT,
            Some(&id),
            1,
            json!([file("src/b.rs", "y\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"fix","commit":next,"expected":id}),
    );
    let claim = h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}));
    assert_eq!(claim["items"], json!([]), "{claim}");
    assert_eq!(
        claim["failed"][0]["result"]["code"], "HEAD_MOVED",
        "{claim}"
    );
    assert_eq!(change(&h, number)["status"], "open");
}

/// Main moves past the Landing, so a landing needs the merge path.
fn moved_on(h: &Harness, root: &str) {
    let other = h
        .commit(
            AGENT,
            Some(root),
            1,
            json!([file("src/m.rs", "m\n")]),
            json!([]),
        )
        .unwrap();
    h.approve_and_check(&other);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":other}));
}

#[test]
fn a_duplicate_delivery_lands_once() {
    let (h, _root, id, number) = cleared();
    assert_eq!(assess(&h, number)["state"], "cleared");
    assert_eq!(assess(&h, number)["state"], "cleared");
    let first = land(&h, number, &id).unwrap();
    let again = land(&h, number, &id).unwrap();
    assert_eq!(again["already"], true, "{again}");
    assert_eq!(assess(&h, number)["state"], "done");
    assert_eq!(landings(&h), 2, "the seed and this one");
    let recorded = decisions(&h, number);
    assert_eq!(recorded.len(), 2, "cleared, then landed: {recorded:?}");
    assert_eq!(recorded[0]["landed_version"], first["version"]);
}

#[test]
fn a_duplicate_delivery_shares_one_ticket() {
    let (h, root, id, number) = cleared();
    moved_on(&h, &root);
    let first = land(&h, number, &id).unwrap();
    let again = land(&h, number, &id).unwrap();
    assert_eq!(first["ticket"], again["ticket"]);
}

#[test]
fn a_rejection_arriving_at_the_same_time_stops_it() {
    let (h, root, id, number) = cleared();
    assert_eq!(assess(&h, number)["state"], "cleared");
    let reject = json!({"op":"repo_review","commit":id,"decision":"reject","reason":"No"});
    h.ok(reviewer(&h), reject);
    assert_eq!(code(land(&h, number, &id)), "GATES");
    assert_eq!(main_head(&h), json!(root));
    assert_eq!(change(&h, number)["status"], "open");
}

#[test]
fn a_rejection_after_the_ticket_is_queued_fails_the_ticket() {
    let (h, root, id, number) = cleared();
    moved_on(&h, &root);
    let ticket = land(&h, number, &id).unwrap()["ticket"].clone();
    let reject = json!({"op":"repo_review","commit":id,"decision":"reject","reason":"No"});
    h.ok(reviewer(&h), reject);
    let claim = h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}));
    assert_eq!(claim["items"], json!([]), "{claim}");
    assert_eq!(claim["failed"][0]["ticket"], ticket, "{claim}");
    assert_eq!(change(&h, number)["status"], "open");
}

#[test]
fn a_rejection_while_the_merge_is_built_sends_the_batch_back() {
    let (h, root, id, number) = cleared();
    moved_on(&h, &root);
    let ticket = land(&h, number, &id).unwrap()["ticket"].clone();
    let claim = h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}));
    assert_eq!(claim["items"].as_array().unwrap().len(), 1, "{claim}");
    let reject = json!({"op":"repo_review","commit":id,"decision":"reject","reason":"No"});
    h.ok(reviewer(&h), reject);
    let batch = h.run(
        MERGER,
        json!({"op":"repo_land_batch","ref":"main","epoch":claim["epoch"],
            "head":claim["head"],"landed":[ticket]}),
    );
    assert_eq!(code(batch), "STALE_HEAD");
    assert_eq!(main_head(&h), claim["head"]);
}

#[test]
fn a_queued_landing_records_its_reasons_when_it_lands() {
    let (h, root, id, number) = cleared();
    moved_on(&h, &root);
    let ticket = land(&h, number, &id).unwrap()["ticket"].clone();
    let queued = &decisions(&h, number)[0];
    assert_eq!(queued["landed_version"], Value::Null, "not landed yet");
    let claim = h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}));
    let blob = yoneda_core::git_object::hash_object(ObjectKind::Blob, b"x\n");
    let merge = h
        .commit_with(
            MERGER,
            claim["head"].as_str(),
            2,
            json!([{"path":"src/a.rs","blob":blob,"type":"blob"}]),
            json!([]),
            json!({"merge_parents": [id]}),
        )
        .unwrap();
    h.ok(
        MERGER,
        json!({"op":"repo_land_batch","ref":"main","epoch":claim["epoch"],
            "head":claim["head"],"merge":merge,"landed":[ticket]}),
    );
    let shown = change(&h, number);
    assert_eq!(shown["status"], "landed");
    let record = &shown["clearances"][0];
    assert_eq!(record["decision"], "cleared");
    assert_eq!(record["actor"], LANDER);
    assert!(record["landed_version"].is_u64(), "{record}");
    assert_eq!(record["state"]["approved_by"], json!([OWNER]));
}

#[test]
fn a_fork_landing_needs_an_approval_even_where_the_rules_need_none() {
    let (parent, root) = seeded();
    let policy = json!({"required_checks":[],"approvals":0});
    parent.ok(OWNER, json!({"op":"repo_set_policy","policy":policy}));
    switch_on(&parent);
    let fork = fork(&parent);
    let feature = fork
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/fork.rs", "f\n")]),
            json!([]),
        )
        .unwrap();
    let current = fork.ok(AGENT, json!({"op":"repo_refs"}))["refs"]["refs/heads/feature"].clone();
    fork.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":"feature","commit":feature,"expected":current}]}),
    );
    let carried = fork.ok(
        FORKER,
        json!({"op":"repo_fork_branch","branch":"feature","haves":[root]}),
    );
    let pushed: Vec<Value> = carried["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let id = c["commit"].as_str().unwrap();
            json!({"commit": id, "data_b64": STANDARD.encode(&fork.objects.borrow()[id].1),
                "touches": c["touches"], "objects": [{"id": id, "kind": "commit"}], "check": false})
        })
        .collect();
    parent.ok(FORKER, json!({"op":"repo_record_pushed","commits":pushed}));
    parent.ok(
        FORKER,
        json!({"op":"repo_fork_mirror","fork":FORK_ID,"branch":"feature","commit":feature}),
    );
    let number = parent.ok(
        OWNER,
        json!({"op":"repo_change_create","branch":format!("forks/{FORK_ID}/feature"),
            "title":"From a fork","source_repo":FORK_ID,"source_branch":"feature"}),
    )["number"]
        .as_i64()
        .unwrap();
    // Anyone who can read a public repository can fork it, so green is not enough.
    let answer = assess(&parent, number);
    assert_eq!(waiting(&answer), ["FORK_NEEDS_APPROVAL"], "{answer}");
    assert_eq!(code(land(&parent, number, &feature)), "FORK_NEEDS_APPROVAL");
    parent.ok(
        OWNER,
        json!({"op":"repo_review","commit":feature,"decision":"approve"}),
    );
    let answer = assess(&parent, number);
    assert_eq!(answer["state"], "cleared", "{answer}");
    assert_eq!(answer["source_repo"], FORK_ID);
    assert_eq!(answer["source_branch"], "feature");
    land(&parent, number, &feature).unwrap();
    assert_eq!(change(&parent, number)["status"], "landed");
}

/// A token limited to `docs/`, with `write`.
fn limited(h: &Harness) -> &'static str {
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read","write"],"paths":["docs/"],
            "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    "token:docs"
}

#[test]
fn a_path_limited_authors_grant_must_cover_all_it_would_land() {
    let (h, root) = seeded();
    switch_on(&h);
    h.ok(OWNER, json!({"op":"repo_auto_landings","create":true}));
    let token = limited(&h);
    // Inside its grant: a push opens the Landing and it lands once cleared.
    let id = branch(&h, token, &root, "docs", "docs/a.md");
    let number = h.ok(OWNER, json!({"op":"repo_changes"}))["changes"][0]["number"]
        .as_i64()
        .unwrap();
    h.approve_and_check(&id);
    assert_eq!(assess(&h, number)["state"], "cleared");
    // Someone else's commit on the branch takes it past what that token covers.
    let wider = h
        .commit(
            AGENT,
            Some(&id),
            1,
            json!([file("src/b.rs", "y\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"docs","commit":wider,"expected":id}),
    );
    h.approve_and_check(&wider);
    let answer = assess(&h, number);
    assert_eq!(waiting(&answer), ["OUTSIDE_GRANT"], "{answer}");
    assert_eq!(code(land(&h, number, &wider)), "OUTSIDE_GRANT");
    assert_eq!(main_head(&h), json!(root));
}

/// The owner, signed in, sets the automation pause.
fn pause(h: &Harness, action: &str) -> Value {
    let person = json!({"workspace":"ws-1","principal":OWNER,"human":true});
    let command = json!({"op":"repo_break_glass","action":action,"reason":"Stop","now":1,
        "_session":person});
    execute_repo_store(&h.db, command).unwrap()
}

#[test]
fn a_pause_refuses_and_a_resume_lets_the_next_trigger_land() {
    let (h, _root, id, number) = cleared();
    pause(&h, "pause_automation");
    let answer = assess(&h, number);
    assert_eq!(waiting(&answer), ["AUTOMATION_PAUSED"], "{answer}");
    assert_eq!(code(land(&h, number, &id)), "AUTOMATION_PAUSED");
    pause(&h, "resume_automation");
    assert_eq!(assess(&h, number)["state"], "cleared");
}

/// Nothing about a held Landing changes when the owner resumes, so resuming has to ask: with no
/// later event a cleared head would sit open for good.
#[test]
fn a_resume_asks_again_for_what_the_pause_held() {
    let (h, _root, id, number) = cleared();
    pause(&h, "pause_automation");
    assert_eq!(waiting(&assess(&h, number)), ["AUTOMATION_PAUSED"]);
    let resumed = pause(&h, "resume_automation");
    assert_eq!(resumed["land_checks"], json!([number]), "{resumed}");
    assert_eq!(assess(&h, number)["state"], "cleared");
    land(&h, number, &id).unwrap();
    assert_eq!(main_head(&h), json!(id));
}

#[test]
fn a_resume_with_nothing_held_asks_for_nothing() {
    let (h, _root, _id, _number) = cleared();
    pause(&h, "pause_automation");
    let resumed = pause(&h, "resume_automation");
    assert!(resumed.get("land_checks").is_none(), "{resumed}");
}

#[test]
fn a_legal_hold_refuses_and_says_so() {
    let (h, _root, id, number) = cleared();
    let risk = json!({"level":"low","score":10,"why":[]});
    let held = json!({"op":"repo_land_clearance","number":number,"risk":risk.clone(),
        "_hold":{"held":true}});
    let answer = h.ok(LANDER, held);
    assert_eq!(waiting(&answer), ["LEGAL_HOLD"], "{answer}");
    let record = decisions(&h, number)[0].clone();
    assert_eq!(record["decision"], "hold");
    assert_eq!(record["reasons"][0]["code"], "LEGAL_HOLD");
    assert_eq!(record["head"], id);
    // Not answered yet: the adapter asks the owner and sends it again.
    let unasked = h.run(
        LANDER,
        json!({"op":"repo_land_clearance","number":number,"risk":risk,"_hold":null}),
    );
    assert_eq!(code(unasked), "HOLD_UNCHECKED");
    let land_held = h.run(
        LANDER,
        json!({"op":"repo_land","ref":"main","commit":id,"clearance":number,
            "expected_head":id,"_hold":{"held":true}}),
    );
    assert_eq!(code(land_held), "LEGAL_HOLD");
}

#[test]
fn a_full_repository_refuses_and_says_so() {
    let (h, _root, id, number) = cleared();
    let risk = json!({"level":"low","score":10,"why":[]});
    let full = json!({"op":"repo_land_clearance","number":number,"risk":risk,
        "_storage_guard":1});
    let answer = h.ok(LANDER, full);
    assert_eq!(waiting(&answer), ["REPO_FULL"], "{answer}");
    assert_eq!(decisions(&h, number)[0]["reasons"][0]["code"], "REPO_FULL");
    let land_full = h.run(
        LANDER,
        json!({"op":"repo_land","ref":"main","commit":id,"clearance":number,
            "expected_head":id,"_storage_guard":1}),
    );
    assert_eq!(code(land_full), "REPO_FULL");
}

#[test]
fn an_unresolved_review_comment_holds_it_until_resolved() {
    let (h, _root, id, number) = cleared();
    let anchor = json!({"number":number,"commit":id,"path":"src/a.rs","line":1,"side":"new"});
    let mut comment = anchor.clone();
    comment["op"] = json!("repo_change_comment");
    comment["body"] = json!("Why?");
    h.ok(OWNER, comment);
    let answer = assess(&h, number);
    assert_eq!(waiting(&answer), ["COMMENTS"], "{answer}");
    assert_eq!(code(land(&h, number, &id)), "COMMENTS");
    let mut resolve = anchor;
    resolve["op"] = json!("repo_change_comment");
    resolve["resolve"] = json!(true);
    h.ok(OWNER, resolve);
    assert_eq!(assess(&h, number)["state"], "cleared");
}

#[test]
fn a_stale_read_is_a_conflict_with_a_visible_reason() {
    let (h, root) = seeded();
    switch_on(&h);
    let main_write = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn m() {}\n")]),
            json!([]),
        )
        .unwrap();
    h.approve_and_check(&main_write);
    h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":main_write}),
    );
    let id = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/a.rs", "x\n")]),
            json!(["src/lib.rs"]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"fix","commit":id,"expected":null}),
    );
    let number = landing(&h, "fix");
    h.approve_and_check(&id);
    let answer = assess(&h, number);
    assert_eq!(waiting(&answer), ["CONFLICT"], "{answer}");
    assert!(
        answer["reasons"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("src/lib.rs")
    );
}

#[test]
fn a_failed_landing_stays_open_with_its_reason_and_starts_nothing() {
    let (h, _root, id, number) = cleared();
    let failed = json!({"op":"repo_land_clearance","number":number,
        "failed":{"head":id,"code":"CONFLICT","message":"Merge conflicts on a.md"}});
    let answer = h.ok(LANDER, failed.clone());
    assert!(answer.get("land_checks").is_none(), "{answer}");
    let shown = change(&h, number);
    assert_eq!(shown["status"], "open");
    assert_eq!(shown["clearances"][0]["decision"], "go_around");
    assert_eq!(shown["clearances"][0]["reasons"][0]["code"], "CONFLICT");
    assert_eq!(shown["clearances"][0]["head"], id);
    let gates = h.ok(OWNER, json!({"op":"repo_change_gates","number":number}));
    assert_eq!(
        gates["land_when_cleared"]["refused"]["reason"],
        "Merge conflicts on a.md"
    );
    // A later attempt at this head can still land it, and the record then says so.
    land(&h, number, &id).unwrap();
    assert!(decisions(&h, number)[0]["landed_version"].is_u64());
    assert_eq!(
        code(h.run(OWNER, failed)),
        "FORBIDDEN",
        "only the platform's job reports"
    );
}

#[test]
fn a_refusal_on_an_older_head_is_not_shown_on_the_new_one() {
    let (h, _root, id, number) = cleared();
    h.ok(
        LANDER,
        json!({"op":"repo_land_clearance","number":number,
            "failed":{"head":id,"code":"CONFLICT","message":"Conflicted"}}),
    );
    let next = h
        .commit(
            AGENT,
            Some(&id),
            1,
            json!([file("src/b.rs", "y\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"fix","commit":next,"expected":id}),
    );
    let gates = h.ok(OWNER, json!({"op":"repo_change_gates","number":number}));
    assert_eq!(
        gates["land_when_cleared"]["refused"],
        Value::Null,
        "{gates}"
    );
}

/// An agent's finding on a line of the head, from its own token.
fn finding(h: &Harness, number: i64, id: &str) {
    let finding = json!({"op":"repo_change_comment","number":number,"commit":id,
        "path":"src/a.rs","line":1,"side":"new","body":"Medium: this looks wrong"});
    h.ok(AGENT, finding);
}

#[test]
fn findings_block_every_landing_with_the_option_on() {
    let (h, _root, id, number) = cleared();
    finding(&h, number, &id);
    h.ok(
        OWNER,
        json!({"op":"repo_auto_landings","findings_block":true}),
    );
    // Enforced at landing, for an explicit one too.
    let explicit = h.run(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
    assert_eq!(code(explicit), "NOT_READY");
    let gates = h.ok(OWNER, json!({"op":"repo_change_gates","number":number}));
    assert_eq!(gates["ready"], false, "{gates}");
    let row = gates["requirements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["kind"] == "findings")
        .unwrap()
        .clone();
    assert_eq!(row["state"], "blocked", "{gates}");
    assert_eq!(row["enforced"], true, "{gates}");
    let resolve = json!({"op":"repo_change_comment","number":number,"commit":id,
        "path":"src/a.rs","line":1,"side":"new","resolve":true});
    h.ok(OWNER, resolve);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
    assert_eq!(change(&h, number)["status"], "landed");
}

#[test]
fn findings_hold_the_platform_too_with_the_option_on() {
    let (h, _root, id, number) = cleared();
    finding(&h, number, &id);
    h.ok(
        OWNER,
        json!({"op":"repo_auto_landings","findings_block":true}),
    );
    let answer = assess(&h, number);
    assert!(waiting(&answer).contains(&"FINDINGS"), "{answer}");
    assert_eq!(code(land(&h, number, &id)), waiting(&answer)[0]);
}

/// A go-around's whole loop: the fix is pushed, the agent that raised the finding looks again and
/// says nothing more. Nobody resolves what it left on the older commit, so that must not hold
/// the Landing, or a review that passes could never let it land by itself.
#[test]
fn a_finding_the_agent_dropped_on_a_later_look_holds_nothing() {
    let (h, _root, id, number) = cleared();
    finding(&h, number, &id);
    h.ok(
        OWNER,
        json!({"op":"repo_auto_landings","findings_block":true}),
    );
    assert_eq!(assess(&h, number)["state"], "go_around");
    let fix = h
        .commit(
            AGENT,
            Some(&id),
            1,
            json!([file("src/a.rs", "y\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"fix","commit":fix,"expected":id}),
    );
    h.approve_and_check(&fix);
    let summary = json!({"op":"repo_change_comment","number":number,"body":"No findings"});
    h.ok(AGENT, summary);
    let answer = assess(&h, number);
    assert_eq!(answer["state"], "cleared", "{answer}");
    land(&h, number, &fix).unwrap();
    assert_eq!(change(&h, number)["status"], "landed");
}

/// The same with a person's comment: it stays until someone resolves it.
#[test]
fn a_persons_comment_on_an_older_head_still_holds() {
    let (h, _root, id, number) = cleared();
    let comment = json!({"op":"repo_change_comment","number":number,"commit":id,
        "path":"src/a.rs","line":1,"side":"new","body":"Not this"});
    h.ok(OWNER, comment);
    let fix = h
        .commit(
            AGENT,
            Some(&id),
            1,
            json!([file("src/a.rs", "y\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"fix","commit":fix,"expected":id}),
    );
    h.approve_and_check(&fix);
    assert_eq!(waiting(&assess(&h, number)), ["COMMENTS"]);
}

/// `yoneda change comment --resolve` names no commit, and a fix has moved the head past the
/// finding, so naming none has to reach the anchor where the finding sits.
#[test]
fn resolving_with_no_commit_reaches_an_older_head() {
    let (h, _root, id, number) = cleared();
    let comment = json!({"op":"repo_change_comment","number":number,"commit":id,
        "path":"src/a.rs","line":1,"side":"new","body":"Not this"});
    h.ok(OWNER, comment);
    let fix = h
        .commit(
            AGENT,
            Some(&id),
            1,
            json!([file("src/a.rs", "y\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"fix","commit":fix,"expected":id}),
    );
    let resolve = json!({"op":"repo_change_comment","number":number,
        "path":"src/a.rs","line":1,"side":"new","resolve":true});
    let answer = h.ok(OWNER, resolve);
    assert_eq!(answer["resolved"], 1, "{answer}");
    assert_eq!(answer["land_checks"], json!([number]), "{answer}");
    h.approve_and_check(&fix);
    assert_eq!(assess(&h, number)["state"], "cleared");
}

#[test]
fn findings_only_show_with_the_option_off() {
    let (h, _root, id, number) = cleared();
    finding(&h, number, &id);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
    assert_eq!(change(&h, number)["status"], "landed");
}

#[test]
fn a_failed_check_that_is_not_required_still_holds_it() {
    let (h, _root, id, number) = cleared();
    // What a managed agent posts when its value reaches `block_at`.
    h.ok(
        OWNER,
        json!({"op":"repo_check","commit":id,"name":"slop-review","status":"fail"}),
    );
    let answer = assess(&h, number);
    assert_eq!(waiting(&answer), ["CHECK_FAILED"], "{answer}");
    assert!(
        answer["reasons"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("slop-review")
    );
}

#[test]
fn a_failed_gate_is_a_go_around_and_a_missing_one_is_a_hold() {
    let (h, root) = seeded();
    switch_on(&h);
    let id = branch(&h, AGENT, &root, "fix", "src/a.rs");
    let number = landing(&h, "fix");
    assert_eq!(assess(&h, number)["state"], "hold");
    let failed = json!({"op":"repo_check","commit":id,"name":"unit","status":"fail"});
    h.ok(CI, failed);
    let answer = assess(&h, number);
    assert_eq!(answer["state"], "go_around", "{answer}");
    let first = answer["reasons"][0]["reason"].as_str().unwrap();
    assert!(first.contains("unit"), "{answer}");
    let gates = h.ok(OWNER, json!({"op":"repo_change_gates","number":number}));
    assert_eq!(gates["land_when_cleared"]["decision"], "go_around");
}

#[test]
fn risk_is_scored_last_and_a_high_head_is_held_for_a_person() {
    let (h, root) = seeded();
    switch_on(&h);
    let id = branch(&h, AGENT, &root, "fix", "src/a.rs");
    let number = landing(&h, "fix");
    let ask = json!({"op":"repo_land_clearance","number":number});
    // Something else stands in the way: the diff isn't read.
    assert!(h.ok(LANDER, ask.clone()).get("needs_risk").is_none());
    h.approve_and_check(&id);
    let first = h.ok(LANDER, ask);
    assert_eq!(first["needs_risk"], true, "{first}");
    assert_eq!(first["commit"], id);
    assert_eq!(
        decisions(&h, number).len(),
        1,
        "asking for a score decides nothing"
    );
    let answer = scored(&h, number, "high");
    assert_eq!(answer["state"], "hold");
    assert_eq!(waiting(&answer), ["RISK_HIGH"], "{answer}");
    assert_eq!(code(land(&h, number, &id)), "RISK_HIGH");
    let gates = h.ok(OWNER, json!({"op":"repo_change_gates","number":number}));
    assert_eq!(gates["land_when_cleared"]["reasons"], answer["reasons"]);
    // Scored again, it clears: review classes can arrive after a score.
    assert_eq!(scored(&h, number, "medium")["state"], "cleared");
    land(&h, number, &id).unwrap();
    assert_eq!(change(&h, number)["status"], "landed");
}

#[test]
fn a_head_the_job_could_not_score_is_held() {
    let (h, _root, _id, number) = cleared();
    let unknown = json!({"level":null,"score":0,"why":[]});
    let answer = h.ok(
        LANDER,
        json!({"op":"repo_land_clearance","number":number,"risk":unknown}),
    );
    assert_eq!(waiting(&answer), ["RISK_UNKNOWN"], "{answer}");
}

#[test]
fn every_decision_is_recorded_once_with_its_head_and_replays() {
    let (h, root) = seeded();
    switch_on(&h);
    let id = branch(&h, AGENT, &root, "fix", "src/a.rs");
    let number = landing(&h, "fix");
    assess(&h, number);
    assess(&h, number);
    assert_eq!(decisions(&h, number).len(), 1, "the same decision again");
    let check = json!({"op":"repo_check","commit":id,"name":"unit","status":"pass"});
    h.ok(CI, check);
    assess(&h, number);
    assert_eq!(decisions(&h, number).len(), 2, "its reasons changed");
    let review = json!({"op":"repo_review","commit":id,"decision":"approve"});
    h.ok(OWNER, review);
    assess(&h, number);
    land(&h, number, &id).unwrap();
    let recorded = decisions(&h, number);
    let said: Vec<&str> = recorded
        .iter()
        .map(|r| r["decision"].as_str().unwrap())
        .collect();
    assert_eq!(said, ["cleared", "cleared", "hold", "hold"], "newest first");
    assert!(recorded.iter().all(|r| r["head"] == id));
    // Rules only, on what was recorded: the same state gives the same decision.
    for row in &recorded {
        let state = serde_json::from_value(row["state"].clone()).unwrap();
        let again = crate::platform_ctc::clearance(&state);
        assert_eq!(json!(again.decision()), row["decision"]);
        assert_eq!(json!(again.reasons()), row["reasons"]);
    }
}

#[test]
fn the_record_stays_bounded_and_keeps_the_landing() {
    let (h, _root, id, number) = cleared();
    for n in 0..80 {
        let failed = json!({"head":id,"code":"UNFINISHED","message":format!("Try {n}")});
        h.ok(
            LANDER,
            json!({"op":"repo_land_clearance","number":number,"failed":failed}),
        );
    }
    assert_eq!(decisions(&h, number).len(), 32);
    assert_eq!(
        assess(&h, number)["state"],
        "cleared",
        "the job scores it again"
    );
    land(&h, number, &id).unwrap();
    let recorded = decisions(&h, number);
    assert_eq!(recorded.len(), 32);
    assert!(recorded[0]["landed_version"].is_u64());
    // A list reads no decisions: they're for the Landing's page.
    let listed = h.ok(OWNER, json!({"op":"repo_changes","status":"landed"}));
    assert!(listed["changes"][0].get("clearances").is_none(), "{listed}");
    assert!(listed["changes"][0].get("clearance").is_none(), "{listed}");
}

#[test]
fn a_draft_waits_for_its_title() {
    let (h, root) = seeded();
    switch_on(&h);
    let id = branch(&h, AGENT, &root, "fix", "src/a.rs");
    let number = h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"fix","title":"Draft: add it"}),
    )["number"]
        .as_i64()
        .unwrap();
    h.approve_and_check(&id);
    assert_eq!(waiting(&assess(&h, number)), ["DRAFT"]);
}

#[test]
fn rules_that_ask_for_nothing_clear_nothing() {
    let (h, root) = seeded();
    let policy = json!({"required_checks":[],"approvals":0});
    h.ok(OWNER, json!({"op":"repo_set_policy","policy":policy}));
    switch_on(&h);
    let id = branch(&h, AGENT, &root, "fix", "src/a.rs");
    let number = landing(&h, "fix");
    // `write` alone must not become `land`: an approval is still enough.
    assert_eq!(waiting(&assess(&h, number)), ["NOTHING_REQUIRED"]);
    h.ok(
        OWNER,
        json!({"op":"repo_review","commit":id,"decision":"approve"}),
    );
    assert_eq!(assess(&h, number)["state"], "cleared");
}

#[test]
fn a_rule_asking_for_an_approval_is_not_a_rule_asking_for_nothing() {
    let (h, root) = seeded();
    let policy = json!({"required_checks":[],"approvals":1});
    h.ok(OWNER, json!({"op":"repo_set_policy","policy":policy}));
    switch_on(&h);
    branch(&h, AGENT, &root, "fix", "src/a.rs");
    let number = landing(&h, "fix");
    assert_eq!(waiting(&assess(&h, number)), ["GATES"]);
}

#[test]
fn the_job_alone_uses_the_job_s_ways_in() {
    let (h, _root, id, number) = cleared();
    let assess_op = json!({"op":"repo_land_clearance","number":number});
    assert_eq!(code(h.run(OWNER, assess_op.clone())), "FORBIDDEN");
    assert_eq!(code(h.run(AGENT, assess_op)), "FORBIDDEN");
    // The job's role lands nothing without a Landing to answer for.
    let bare = json!({"op":"repo_land","ref":"main","commit":id});
    assert_eq!(code(h.run(LANDER, bare)), "FORBIDDEN");
    let queue = json!({"op":"repo_land_enqueue","ref":"main","commit":id});
    assert_eq!(code(h.run(LANDER, queue)), "FORBIDDEN");
    // A commit other than the head it evaluated.
    let other = json!({"op":"repo_land","ref":"main","commit":id,"clearance":number,
        "expected_head":"0".repeat(40)});
    assert_eq!(code(h.run(LANDER, other)), "HEAD_MOVED");
    // A client's `clearance` is nothing: its own rights decide, as ever.
    let client = json!({"op":"repo_land","ref":"main","commit":id,"clearance":number,
        "expected_head":id});
    assert_eq!(code(h.run(AGENT, client)), "FORBIDDEN");
}

#[test]
fn turning_it_off_between_the_job_s_two_calls_lands_nothing() {
    let (h, root, id, number) = cleared();
    assert_eq!(assess(&h, number)["state"], "cleared");
    h.ok(
        OWNER,
        json!({"op":"repo_auto_landings","land_when_cleared":false}),
    );
    assert_eq!(code(land(&h, number, &id)), "NOT_READY");
    assert_eq!(main_head(&h), json!(root));
}

#[test]
fn a_ticket_never_lands_through_the_changeset_path() {
    let (h, root, id, number) = cleared();
    moved_on(&h, &root);
    let ticket = land(&h, number, &id).unwrap()["ticket"].clone();
    let step = h.ok(MERGER, json!({"op":"repo_land_changesets","ref":"main"}));
    assert_eq!(step["landed"], json!([]), "{step}");
    let row = h.db.query(
        "SELECT slow,status FROM land_queue WHERE ticket=?",
        std::slice::from_ref(&ticket),
    );
    assert_eq!(row.unwrap()[0]["slow"], 1);
}
