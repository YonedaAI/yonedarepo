//! Go-around: a session pulls the open findings of its branch's change; nothing is pushed to
//! it. A finding is an unresolved comment on a line. Those on the head lead. A token that
//! commented on a newer commit looked again, so what it did not repeat is no longer open; a
//! person's comment stays until it is resolved. The list is bounded and the bodies cut.
use super::*;

const BOT: &str = "token:reviewer";
const PERSON: &str = OWNER;

fn setup() -> (Harness, String, i64) {
    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"reviewer","scopes":["read","review"],
        "_secret":"reviewer-secret-0123456789abcdef0123456789"}),
    );
    let head = push(&h, "fix", &root, None);
    let number = h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"fix","title":"Retry"}),
    )["number"]
        .as_i64()
        .unwrap();
    (h, head, number)
}

fn push(h: &Harness, branch: &str, parent: &str, expected: Option<&str>) -> String {
    let id = h
        .commit(
            AGENT,
            Some(parent),
            1,
            json!([file("src/retry.rs", &format!("{parent}\n"))]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":branch,"commit":id,"expected":expected}),
    );
    id
}

fn finding(h: &Harness, who: &str, number: i64, commit: &str, line: u64, body: &str) {
    h.ok(
        who,
        json!({"op":"repo_change_comment","number":number,"commit":commit,"body":body,
        "path":"src/retry.rs","line":line,"side":"new"}),
    );
}

fn context(h: &Harness) -> Value {
    h.ok(CI, json!({"op":"repo_agent_context","branch":"fix"}))["go_around"].clone()
}

fn lines(go_around: &Value) -> Vec<u64> {
    go_around["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["line"].as_u64().unwrap())
        .collect()
}

#[test]
fn open_findings_reach_a_new_session_on_the_branch() {
    let (h, head, number) = setup();
    assert_eq!(context(&h)["open"], 0);
    // General discussion is not a finding.
    h.ok(
        BOT,
        json!({"op":"repo_change_comment","number":number,"body":"Reviewed."}),
    );
    finding(&h, BOT, number, &head, 12, "**High: off by one**");
    let found = context(&h);
    assert_eq!(found["change"], number);
    assert_eq!(found["open"], 1);
    let first = &found["findings"][0];
    assert_eq!(first["path"], "src/retry.rs");
    assert_eq!(first["line"], 12);
    assert_eq!(first["side"], "new");
    assert_eq!(first["body"], "**High: off by one**");
    assert_eq!(first["principal"], BOT);
    assert_eq!(first["on_head"], true);
    assert_eq!(
        h.ok(CI, json!({"op":"repo_change_show","number":number}))["go_around"],
        found,
        "change show answers the same"
    );

    h.ok(
        BOT,
        json!({"op":"repo_change_comment","number":number,"commit":head,"path":"src/retry.rs",
        "line":12,"side":"new","resolve":true}),
    );
    assert_eq!(context(&h)["open"], 0);
}

#[test]
fn a_branch_without_an_open_change_has_nothing_to_go_around() {
    let (h, head, number) = setup();
    finding(&h, BOT, number, &head, 12, "Finding");
    assert_eq!(
        h.ok(CI, json!({"op":"repo_agent_context"}))["go_around"],
        Value::Null
    );
    assert_eq!(
        h.ok(CI, json!({"op":"repo_agent_context","branch":"other"}))["go_around"],
        Value::Null
    );
    h.ok(AGENT, json!({"op":"repo_change_close","number":number}));
    assert_eq!(context(&h), Value::Null);
}

#[test]
fn a_re_review_replaces_a_tokens_findings_and_a_persons_stay() {
    let (h, first, number) = setup();
    finding(&h, BOT, number, &first, 3, "Bot, first pass");
    finding(&h, PERSON, number, &first, 4, "Person, first pass");
    let second = push(&h, "fix", &first, Some(&first));

    // Pushed but not looked at again: both stand, flagged as on an older commit.
    let waiting = context(&h);
    assert_eq!(lines(&waiting), [4, 3]);
    assert_eq!(waiting["findings"][0]["on_head"], false);

    // The token's re-review says nothing on line 3: its first pass is over, even with no
    // new finding on a line. The person's comment stays, after what is on the head.
    h.ok(
        BOT,
        json!({"op":"repo_change_comment","number":number,"commit":second,"body":"Passed."}),
    );
    assert_eq!(lines(&context(&h)), [4]);
    finding(&h, PERSON, number, &second, 9, "Person, second pass");
    finding(&h, BOT, number, &second, 8, "Bot, second pass");
    let now = context(&h);
    assert_eq!(lines(&now), [8, 9, 4]);
    assert_eq!(now["open"], 3);
    assert_eq!(now["findings"][2]["on_head"], false);
}

#[test]
fn the_list_is_bounded_and_the_bodies_are_cut() {
    let (h, head, number) = setup();
    let limit = super::super::go_around::MAX_FINDINGS;
    for line in 1..=(limit + 3) {
        finding(&h, BOT, number, &head, line, &"é".repeat(4000));
    }
    let found = context(&h);
    assert_eq!(found["open"], limit + 3);
    assert_eq!(found["findings"].as_array().unwrap().len(), limit as usize);
    let body = found["findings"][0]["body"].as_str().unwrap();
    assert_eq!(
        body.chars().count(),
        super::super::go_around::MAX_BODY_CHARS as usize
    );
    assert_eq!(found["findings"][0]["line"], limit + 3, "newest first");
}

#[test]
fn a_path_restricted_token_reads_no_findings() {
    let (h, head, number) = setup();
    finding(&h, BOT, number, &head, 12, "Finding");
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read"],"paths":["docs/"],
        "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    assert_eq!(
        code(h.run(
            "token:docs",
            json!({"op":"repo_agent_context","branch":"fix"})
        )),
        "FORBIDDEN"
    );
}
