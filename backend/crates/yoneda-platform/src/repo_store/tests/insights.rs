//! Who made a repository's recent commits (`repo_insights`), for its Insights page. The page's
//! traffic figures are served only after this answers, so it is where access is decided.
use super::*;
use crate::storage::SqlStore;

fn insights(h: &Harness, principal: &str, since: i64) -> Value {
    h.ok(principal, json!({"op":"repo_insights","since":since}))
}

#[test]
fn counts_commits_by_who_made_them_since_a_time() {
    let (h, root) = seeded();
    // The seed is imported history in spirit, but its commit was made here: it counts.
    let before = *h.now.borrow();
    let first = h
        .commit(AGENT, Some(&root), 1, json!([file("a", "1\n")]), json!([]))
        .unwrap();
    h.commit(AGENT, Some(&first), 1, json!([file("b", "2\n")]), json!([]))
        .unwrap();
    h.commit(OWNER, Some(&root), 1, json!([file("c", "3\n")]), json!([]))
        .unwrap();
    assert_eq!(
        insights(&h, OWNER, before)["contributors"],
        json!([
            {"principal": AGENT, "commits": 2},
            {"principal": OWNER, "commits": 1},
        ])
    );
    // Nothing after the newest commit.
    let after = *h.now.borrow() + 2_000;
    assert_eq!(insights(&h, OWNER, after)["contributors"], json!([]));
}

#[test]
fn only_a_reader_of_the_whole_repository_gets_an_answer() {
    let (h, _) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read"],"paths":["docs/"],
               "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    assert_eq!(
        code(h.run("token:docs", json!({"op":"repo_insights","since":0}))),
        "FORBIDDEN"
    );
    // A stranger is told nothing of a private repository, and reads a public one.
    let stranger = "member:stranger";
    let ask = json!({"op":"repo_insights","since":0});
    assert_eq!(code(h.run(stranger, ask.clone())), "NOT_FOUND");
    h.ok(
        OWNER,
        json!({"op":"repo_set_visibility","visibility":"public"}),
    );
    assert_eq!(h.ok(stranger, ask.clone())["contributors"][0]["commits"], 1);
    // Going private takes it back at once.
    h.ok(
        OWNER,
        json!({"op":"repo_set_visibility","visibility":"private"}),
    );
    assert_eq!(code(h.run(stranger, ask)), "NOT_FOUND");
}

#[test]
fn a_missing_time_is_refused() {
    let (h, _) = seeded();
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_insights"}))),
        "INVALID_INPUT"
    );
}

#[test]
fn it_reads_the_newest_commits_and_not_all_of_history() {
    let (h, _) = seeded();
    assert_eq!(
        insights(&h, OWNER, 0)["contributors"][0]["principal"],
        OWNER
    );
    // 5,000 newer rows push the seed out of what is read.
    h.db.query(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000) \
         INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,\
         recorded_at) SELECT printf('%040x',i),'t','[]',1,1,'user:busy','m','[]',0 FROM n",
        &[],
    )
    .unwrap();
    let answer = insights(&h, OWNER, 0);
    assert_eq!(
        answer["contributors"],
        json!([{"principal": "user:busy", "commits": 5000}])
    );
    assert_eq!(answer["more"], false);
}
