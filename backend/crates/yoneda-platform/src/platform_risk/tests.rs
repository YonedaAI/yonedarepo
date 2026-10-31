//! The Risk score: the same input gives the same score, each input moves it the way it
//! should, and what cannot be read never lowers it.
use super::sensitive::{Sensitive, kind};
use super::*;
use crate::platform_instruments::{CommitFacts, FileFacts};
use std::collections::BTreeMap;

fn file(path: &str, lines: u64) -> FileFacts {
    FileFacts {
        path: path.to_owned(),
        old_path: None,
        additions: Some(lines),
        deletions: Some(0),
    }
}

fn classed(class: &str) -> CommitFacts {
    CommitFacts {
        classes: BTreeMap::from([(class.to_owned(), 1)]),
        unclassified: 0,
        unread: false,
    }
}

fn no_class() -> CommitFacts {
    CommitFacts {
        unclassified: 1,
        ..CommitFacts::default()
    }
}

fn points(reading: &RiskReading, input: RiskInput) -> u32 {
    reading
        .reasons
        .iter()
        .find(|r| r.input == input)
        .map_or(0, |r| r.points)
}

#[test]
fn the_same_input_gives_the_same_score() {
    let files = [file("src/auth.rs", 80), file(".github/workflows/ci.yml", 3)];
    let first = score(&classed("logic"), &files, 2);
    let second = score(&classed("logic"), &files, 2);
    assert_eq!(first.score, second.score);
    assert_eq!(first.level, second.level);
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(&second).unwrap()
    );
}

#[test]
fn a_commit_with_no_class_reads_higher_than_any_class() {
    let files = [file("src/a.rs", 10)];
    let missing = score(&no_class(), &files, 0).score;
    for class in [
        "docs",
        "formatting",
        "comment_only",
        "logic",
        "instructions",
        "unknown",
    ] {
        let classed = score(&classed(class), &files, 0).score;
        assert!(missing > classed, "{class}: {classed} not below {missing}");
    }
}

#[test]
fn one_unclassified_commit_among_clean_ones_still_counts() {
    let mixed = CommitFacts {
        classes: BTreeMap::from([("docs".to_owned(), 9)]),
        unclassified: 1,
        unread: false,
    };
    let files = [file("README.md", 2)];
    assert_eq!(
        score(&mixed, &files, 0).score,
        score(&no_class(), &files, 0).score
    );
}

#[test]
fn commits_that_could_not_be_read_count_as_unclassified() {
    let unread = CommitFacts {
        classes: BTreeMap::from([("docs".to_owned(), 1)]),
        unclassified: 0,
        unread: true,
    };
    let files = [file("README.md", 2)];
    let reading = score(&unread, &files, 0);
    assert_eq!(reading.score, score(&no_class(), &files, 0).score);
    assert!(reading.reasons[0].why.contains("could not be read"));
}

#[test]
fn a_clean_small_docs_change_reads_low_with_zero() {
    let reading = score(&classed("docs"), &[file("README.md", 4)], 0);
    assert_eq!((reading.score, reading.level), (0, RiskLevel::Low));
    assert_eq!(reading.reasons.len(), 4, "every input is shown");
}

#[test]
fn more_files_and_lines_never_lower_the_score() {
    let mut last = 0;
    for (files, lines) in [(1, 10), (5, 100), (20, 400), (50, 1000), (150, 3000)] {
        let list: Vec<_> = (0..files)
            .map(|n| file(&format!("src/f{n}.rs"), lines / files))
            .collect();
        let now = score(&classed("logic"), &list, 0).score;
        assert!(
            now > last,
            "{files} files, {lines} lines: {now} after {last}"
        );
        last = now;
    }
}

#[test]
fn a_file_that_could_not_be_measured_raises_the_score() {
    let measured = [file("src/a.rs", 10), file("src/b.rs", 10)];
    let mut unmeasured = measured.clone();
    unmeasured[1].additions = None;
    unmeasured[1].deletions = None;
    let reading = score(&classed("logic"), &unmeasured, 0);
    assert!(reading.score > score(&classed("logic"), &measured, 0).score);
    assert!(reading.reasons[1].why.contains("1 not measured"));
}

#[test]
fn lockfile_lines_are_not_size_but_the_lockfile_is_sensitive() {
    let small = [file("Cargo.lock", 5000), file("src/a.rs", 10)];
    let reading = score(&classed("logic"), &small, 0);
    assert_eq!(points(&reading, RiskInput::Size), 0);
    assert!(points(&reading, RiskInput::Sensitive) > 0);
    assert!(reading.reasons[2].why.contains("Cargo.lock"));
}

#[test]
fn a_rename_out_of_a_sensitive_path_still_counts() {
    let mut moved = file("src/helpers.rs", 1);
    moved.old_path = Some("src/auth/login.rs".to_owned());
    let reading = score(&classed("logic"), &[moved], 0);
    assert!(points(&reading, RiskInput::Sensitive) > 0);
}

#[test]
fn open_findings_raise_it_up_to_a_cap() {
    let files = [file("src/a.rs", 1)];
    let at = |n| points(&score(&classed("docs"), &files, n), RiskInput::Findings);
    assert_eq!(at(0), 0);
    assert!(at(2) > at(1));
    assert_eq!(at(1000), at(u64::MAX));
    assert!(at(1000) <= 25);
}

#[test]
fn the_score_stops_at_100_and_high_is_reachable() {
    let mut files: Vec<_> = (0..200)
        .map(|n| file(&format!("src/f{n}.rs"), 50))
        .collect();
    files.extend([
        file(".github/workflows/ci.yml", 1),
        file("src/auth.rs", 1),
        file("db/migrations/1.sql", 1),
        file("CODEOWNERS", 1),
        file("pnpm-lock.yaml", 1),
    ]);
    let reading = score(&no_class(), &files, 50);
    assert_eq!((reading.score, reading.level), (100, RiskLevel::High));
}

#[test]
fn levels_sit_at_their_bands() {
    assert_eq!(level(0), RiskLevel::Low);
    assert_eq!(level(MEDIUM - 1), RiskLevel::Low);
    assert_eq!(level(MEDIUM), RiskLevel::Medium);
    assert_eq!(level(HIGH - 1), RiskLevel::Medium);
    assert_eq!(level(HIGH), RiskLevel::High);
}

#[test]
fn sensitive_paths_are_named_by_what_they_do() {
    for (path, want) in [
        (".github/workflows/deploy.yml", Sensitive::Workflows),
        (".gitlab-ci.yml", Sensitive::Workflows),
        ("ci/Jenkinsfile", Sensitive::Workflows),
        ("src/auth.rs", Sensitive::Auth),
        ("backend/oauth/client.py", Sensitive::Auth),
        ("src/useAuth.ts", Sensitive::Auth),
        ("lib/login_form.rb", Sensitive::Auth),
        ("config/secrets.yml", Sensitive::Auth),
        ("db/migrations/0042_add.sql", Sensitive::Migrations),
        ("rails/db/migrate/20240101_x.rb", Sensitive::Migrations),
        ("Cargo.lock", Sensitive::Lockfiles),
        ("frontend/pnpm-lock.yaml", Sensitive::Lockfiles),
        ("go.sum", Sensitive::Lockfiles),
        ("CODEOWNERS", Sensitive::Policy),
        (".github/CODEOWNERS", Sensitive::Policy),
        ("AGENTS.md", Sensitive::Policy),
        (".claude/settings.json", Sensitive::Policy),
        ("deploy/policy.rego", Sensitive::Policy),
    ] {
        assert_eq!(kind(path), Some(want), "{path}");
    }
}

#[test]
fn ordinary_paths_that_only_look_sensitive_are_not() {
    for path in [
        "src/author.rs",
        "docs/AUTHORS",
        "src/authoring/page.tsx",
        "src/secretary.py",
        "src/migrator_notes.md",
        "src/block.rs",
        "README.md",
        "src/policy_page_title.txt",
    ] {
        assert_eq!(kind(path), None, "{path}");
    }
}
