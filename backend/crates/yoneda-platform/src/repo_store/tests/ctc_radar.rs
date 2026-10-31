//! The radar: every open Landing, CTC's state, what it waits for, its place in line, what it
//! overlaps and the last decision on it. The same decision the job makes, read and never
//! recorded, in a read bounded by the Landings shown.
use super::land_when_cleared::{assess, land, switch_on};
use super::*;
use crate::storage::SqlStore;

fn radar(h: &Harness) -> Value {
    h.ok(OWNER, json!({"op":"repo_ctc_radar"}))
}

fn row(radar: &Value, number: i64) -> &Value {
    radar["landings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["number"] == number)
        .unwrap_or_else(|| panic!("no {number} in {radar}"))
}

fn work(h: &Harness, root: &str, name: &str, path: &str, reads: Value) -> (String, i64) {
    let id = h
        .commit(AGENT, Some(root), 1, json!([file(path, name)]), reads)
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":name,"commit":id,"expected":null}),
    );
    let created = json!({"op":"repo_change_create","branch":name,"title":format!("On {name}")});
    (id, h.ok(AGENT, created)["number"].as_i64().unwrap())
}

#[test]
fn nothing_open_is_an_empty_radar() {
    let (h, _) = seeded();
    let empty = radar(&h);
    assert_eq!(empty["landings"], json!([]));
    assert_eq!(empty["land_when_cleared"], false);
    assert_eq!(empty["truncated"], false);
}

#[test]
fn it_shows_each_landings_state_and_what_it_waits_for() {
    let (h, root) = seeded();
    switch_on(&h);
    let (_, waiting) = work(&h, &root, "waiting", "src/a.rs", json!([]));
    let (ready, cleared) = work(&h, &root, "ready", "src/b.rs", json!([]));
    h.approve_and_check(&ready);
    assert_eq!(assess(&h, cleared)["state"], "cleared");
    let (bad, failed) = work(&h, &root, "bad", "src/c.rs", json!([]));
    h.ok(
        OWNER,
        json!({"op":"repo_check","commit":bad,"name":"lint","status":"fail"}),
    );
    let seen = radar(&h);
    assert_eq!(seen["land_when_cleared"], true);
    let line = row(&seen, waiting);
    assert_eq!(line["decision"], "hold");
    assert!(line["reasons"].to_string().contains("GATES"), "{line}");
    assert_eq!(line["last"], Value::Null);
    assert_eq!(line["title"], "On waiting");
    assert_eq!(line["base"], "main");
    let ahead = row(&seen, cleared);
    assert_eq!(ahead["decision"], "cleared");
    assert_eq!(ahead["last"]["decision"], "cleared");
    assert_eq!(ahead["last"]["on_head"], true);
    assert_eq!(row(&seen, failed)["decision"], "go_around");
    // Reading it recorded nothing.
    let shown = h.ok(OWNER, json!({"op":"repo_change_show","number":waiting}));
    assert!(shown.get("clearances").is_none(), "{shown}");
}

#[test]
fn the_line_runs_queued_then_oldest_cleared_then_waiting() {
    let (h, root) = seeded();
    switch_on(&h);
    let (first, one) = work(&h, &root, "one", "src/a.rs", json!([]));
    let (second, two) = work(&h, &root, "two", "src/b.rs", json!([]));
    let (_, three) = work(&h, &root, "three", "src/c.rs", json!([]));
    // Cleared the other way round from opened.
    h.approve_and_check(&second);
    h.approve_and_check(&first);
    assert_eq!(assess(&h, two)["state"], "cleared");
    assert_eq!(assess(&h, one)["state"], "cleared");
    let seen = radar(&h);
    let order: Vec<_> = seen["landings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            (
                l["number"].as_i64().unwrap(),
                l["place"]["position"].clone(),
            )
        })
        .collect();
    assert_eq!(order, [(two, json!(1)), (one, json!(2)), (three, json!(3))]);
    assert_eq!(row(&seen, two)["place"]["line"], "cleared");
    assert_eq!(row(&seen, three)["place"]["line"], "waiting");
    // A ticket goes to the front: main moves, so `one` waits for a merge.
    h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":second}),
    );
    let queued = land(&h, one, &first).unwrap();
    assert_eq!(queued["queued"], true, "{queued}");
    let seen = radar(&h);
    assert_eq!(row(&seen, one)["place"]["line"], "queued");
    assert_eq!(row(&seen, one)["place"]["position"], 1);
    assert_eq!(row(&seen, one)["place"]["ticket"], queued["ticket"]);
}

#[test]
fn a_landing_going_around_has_no_place_in_line() {
    let (h, root) = seeded();
    let (bad, number) = work(&h, &root, "bad", "src/c.rs", json!([]));
    h.ok(
        OWNER,
        json!({"op":"repo_check","commit":bad,"name":"lint","status":"fail"}),
    );
    assert_eq!(row(&radar(&h), number)["place"], Value::Null);
}

#[test]
fn overlaps_name_the_other_landing_closest_first() {
    let (h, root) = seeded();
    let (mine, a) = work(&h, &root, "a", "src/net.rs", json!([]));
    let (theirs, b) = work(&h, &root, "b", "src/net.rs", json!([]));
    for (id, name) in [(&mine, "retry"), (&theirs, "retry::inner")] {
        h.ok(
            "platform:derive",
            json!({"op":"repo_record_symbols","commit":id,
                   "touches":[{"path":"src/net.rs","symbols":[name]}]}),
        );
    }
    let (_, c) = work(&h, &root, "c", "src/net.rs", json!([]));
    let (_, d) = work(&h, &root, "d", "docs/d.md", json!(["src/"]));
    let (_, alone) = work(&h, &root, "alone", "docs/e.md", json!(["README.md"]));
    let seen = radar(&h);
    let overlaps = &row(&seen, a)["overlaps"];
    assert_eq!(overlaps[0]["landing"], b);
    assert_eq!(overlaps[0]["overlap"], "symbol");
    assert_eq!(overlaps[0]["paths"], json!(["src/net.rs"]));
    assert_eq!(overlaps[0]["symbols"], json!(["retry"]));
    assert_eq!(overlaps[1]["landing"], c);
    assert_eq!(overlaps[1]["overlap"], "file");
    assert_eq!(overlaps[2]["landing"], d);
    assert_eq!(overlaps[2]["overlap"], "read");
    // Both sides of a read show it.
    assert_eq!(row(&seen, d)["overlaps"][0]["overlap"], "read");
    assert_eq!(row(&seen, alone)["overlaps"], json!([]));
}

#[test]
fn a_landing_whose_branch_is_gone_still_shows() {
    let (h, root) = seeded();
    let (_, number) = work(&h, &root, "gone", "src/a.rs", json!([]));
    h.db.query("DELETE FROM refs WHERE name='refs/heads/gone'", &[])
        .unwrap();
    let line = radar(&h);
    let line = row(&line, number);
    assert_eq!(line["decision"], Value::Null);
    assert_eq!(line["reasons"][0]["code"], "NO_BRANCH");
    assert_eq!(line["head"], Value::Null);
    assert_eq!(line["place"], Value::Null);
}

#[test]
fn the_shown_landings_are_bounded_and_the_line_always_shows() {
    let (h, root) = seeded();
    switch_on(&h);
    let (front, oldest) = work(&h, &root, "front", "src/a.rs", json!([]));
    h.approve_and_check(&front);
    assert_eq!(assess(&h, oldest)["state"], "cleared");
    for n in 0..4 {
        work(&h, &root, &format!("l{n}"), "docs/x.md", json!([]));
    }
    let cut = h.ok(OWNER, json!({"op":"repo_ctc_radar","limit":2}));
    assert_eq!(cut["truncated"], true);
    let shown: Vec<_> = cut["landings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["number"].as_i64().unwrap())
        .collect();
    assert_eq!(shown.len(), 3, "{shown:?}");
    assert_eq!(shown[0], oldest, "the first in line, however old");
    assert_eq!(
        h.run(OWNER, json!({"op":"repo_ctc_radar","limit":51}))
            .unwrap_err()
            .code,
        "INVALID_INPUT"
    );
}

#[test]
fn a_path_limited_token_gets_no_radar_and_a_public_reader_does() {
    let (h, root) = seeded();
    work(&h, &root, "fix", "src/a.rs", json!([]));
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read"],"paths":["docs/"],
               "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    let refused = h
        .run("token:docs", json!({"op":"repo_ctc_radar"}))
        .unwrap_err();
    assert_eq!(refused.code, "FORBIDDEN");
    // A stranger on a private repository, and on a public one.
    let stranger = "member:stranger";
    let hidden = h.run(stranger, json!({"op":"repo_ctc_radar"})).unwrap_err();
    assert_eq!(hidden.code, "NOT_FOUND", "{hidden:?}");
    h.ok(
        OWNER,
        json!({"op":"repo_set_visibility","visibility":"public"}),
    );
    assert_eq!(
        h.ok(stranger, json!({"op":"repo_ctc_radar"}))["landings"][0]["number"],
        1
    );
}

#[test]
fn the_cost_answers_for_the_landings_shown_not_for_history() {
    fn cost(h: &Harness) -> yoneda_store::counted::SqlCounts {
        let before = h.db.counts();
        radar(h);
        h.db.counts() - before
    }
    let (h, root) = seeded();
    switch_on(&h);
    h.ok(
        OWNER,
        json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":0}}),
    );
    let mut tip = root.clone();
    for n in 0..4 {
        work(&h, &tip, &format!("l{n}"), "src/hot.rs", json!([]));
    }
    let land_more = |tip: &mut String, from: u64, to: u64| {
        for n in from..to {
            let change = json!([file("src/hot.rs", &format!("{n}"))]);
            *tip = h
                .commit(AGENT, Some(tip), n + 1, change, json!([]))
                .unwrap();
            h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":*tip}));
        }
    };
    land_more(&mut tip, 0, 5);
    let few = cost(&h);
    land_more(&mut tip, 5, 35);
    let long = cost(&h);
    // Landings branched before all this stand still: nothing they read was touched, and one
    // indexed read proves it, however many log entries came after them.
    assert_eq!(few.statements, long.statements, "{few:?} {long:?}");
    assert_eq!(few.rows, long.rows, "{few:?} {long:?}");
    for n in 4..24 {
        work(&h, &tip, &format!("l{n}"), "src/hot.rs", json!([]));
    }
    let many = cost(&h);
    let per_landing = (many.statements - few.statements) / 20;
    assert!(
        per_landing <= 45,
        "{few:?} {many:?}: {per_landing} a Landing"
    );
}
