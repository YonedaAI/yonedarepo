//! Complexity gates: what one request costs the authority (SQL statements, rows and their
//! bytes, objects asked of the adapter) must not grow with the repository's history. Each
//! gate measures a request after 10 and after 1,000 landed commits. A gate that fails today
//! is `#[ignore]`d as known-failing, with the measured numbers and its target; run it with
//! `cargo test -p yoneda-platform --lib access_gates -- --include-ignored`.
use super::batches::open;
use super::*;
use yoneda_store::counted::SqlCounts;

/// What one request cost: the store's counts and the adapter's object reads.
#[derive(Debug, PartialEq, Eq)]
struct Cost {
    sql: SqlCounts,
    objects: u64,
    object_bytes: u64,
}

impl Cost {
    /// Whether `self` (after the longer history) is `small`'s cost: the same statements,
    /// rows, transactions and object reads; row bytes may grow by a few digits (versions).
    fn flat(&self, small: &Cost) -> bool {
        let digits = SqlCounts {
            row_bytes: small.sql.row_bytes,
            ..self.sql
        };
        digits == small.sql
            && self.sql.row_bytes <= small.sql.row_bytes + small.sql.row_bytes / 50
            && (self.objects, self.object_bytes) == (small.objects, small.object_bytes)
    }
}

fn measure<T>(h: &Harness, request: impl FnOnce() -> T) -> (T, Cost) {
    let (sql, (objects, bytes)) = (h.db.counts(), h.object_reads.get());
    let answer = request();
    let (after_objects, after_bytes) = h.object_reads.get();
    let cost = Cost {
        sql: h.db.counts() - sql,
        objects: after_objects - objects,
        object_bytes: after_bytes - bytes,
    };
    (answer, cost)
}

/// A repository whose main has `commits` landed one-file commits: each rewrites one of ten
/// files under log/, except the first, middle and last, which rewrite rare.txt. Answers
/// the harness, main's tip and its version.
fn landed(commits: u64) -> (Harness, String, u64) {
    let (h, root) = open();
    let mut tip = root;
    for i in 0..commits {
        let path = if [0, commits / 2, commits - 1].contains(&i) {
            "rare.txt".to_owned()
        } else {
            format!("log/{}.txt", i % 10)
        };
        let change = json!([file(&path, &format!("{i}\n"))]);
        tip = h
            .commit(AGENT, Some(&tip), i + 1, change, json!([]))
            .unwrap();
        h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":tip}));
    }
    (h, tip, commits + 1)
}

/// What `request` answers and costs (as it measures) after 10 and after 1,000 commits.
fn after_10_and_1000(request: impl Fn(&Harness, &str, u64) -> (Value, Cost)) -> [(Value, Cost); 2] {
    [10, 1_000].map(|commits| {
        let (h, tip, version) = landed(commits);
        let measured = request(&h, &tip, version);
        eprintln!("after {commits}: {:?}", measured.1);
        measured
    })
}

fn one_file_commit(h: &Harness, tip: &str, version: u64) -> String {
    let change = json!([file("x.txt", "x\n")]);
    h.commit(AGENT, Some(tip), version, change, json!([]))
        .unwrap()
}

#[test]
fn a_one_file_commit_costs_the_same_after_10_or_1000_commits() {
    let [(_, small), (_, large)] = after_10_and_1000(|h, tip, version| {
        let (made, cost) = measure(h, || one_file_commit(h, tip, version));
        (json!(made), cost)
    });
    assert!(large.flat(&small), "{large:?} vs {small:?}");
}

#[test]
fn landing_a_one_file_commit_costs_the_same_after_10_or_1000_commits() {
    let [(_, small), (_, large)] = after_10_and_1000(|h, tip, version| {
        let made = one_file_commit(h, tip, version);
        measure(h, || {
            h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":made}))
        })
    });
    assert!(large.flat(&small), "{large:?} vs {small:?}");
}

#[test]
fn a_page_of_the_log_costs_the_same_after_10_or_1000_commits() {
    let [(small_log, small), (large_log, large)] = after_10_and_1000(|h, _, _| {
        measure(h, || {
            h.ok(CI, json!({"op":"repo_log","ref":"main","limit":5}))
        })
    });
    assert_eq!(small_log["commits"].as_array().unwrap().len(), 5);
    assert_eq!(large_log["commits"].as_array().unwrap().len(), 5);
    assert!(large.flat(&small), "{large:?} vs {small:?}");
}

#[test]
#[ignore = "known-failing: repo_path_history walks first parents (3 statements per commit, \
            up to MAX_SCAN 5,000). rare.txt (3 versions) after 10 commits: 38 statements, \
            71 rows, 12.8 KB; after 1,000: 3,008 statements, 3,041 rows, 911 KB. Target: \
            the 10-commit cost after 1,000 (statements and rows equal)"]
fn a_rarely_touched_path_history_costs_the_same_after_10_or_1000_commits() {
    let [(small_history, small), (large_history, large)] = after_10_and_1000(|h, _, _| {
        measure(h, || {
            h.ok(
                CI,
                json!({"op":"repo_path_history","ref":"main","path":"rare.txt"}),
            )
        })
    });
    assert_eq!(small_history["commits"].as_array().unwrap().len(), 3);
    assert_eq!(large_history["commits"].as_array().unwrap().len(), 3);
    assert!(large.flat(&small), "{large:?} vs {small:?}");
}
