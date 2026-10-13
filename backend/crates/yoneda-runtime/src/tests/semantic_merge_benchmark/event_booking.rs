//! Exact Git captures checked through the independent workerd/DO SQLite oracle.
use crate::{capture, git, git::capture_fresh};
use serde_json::{Value, json};
use std::{fs, path::Path};
use yoneda_core::{Evaluation, FileEntry, Policy, Revision, Workspace, validate_evaluation};

fn repository_root() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}

fn reference(files: &Workspace, stage: &str) -> Workspace {
    let root = repository_root();
    let output = std::process::Command::new("node")
        .current_dir(&root)
        .args(["--input-type=module", "-e", "import {readFileSync} from 'node:fs';import {reference} from './fixtures/event-booking/controls/reference.mjs';process.stdout.write(reference(readFileSync('fixtures/event-booking/source/booking.mjs','utf8'),process.argv[1]));", stage])
        .output().unwrap();
    assert!(output.status.success());
    let mut files = files.clone();
    files.insert(
        "booking.mjs".into(),
        FileEntry::from_bytes(output.stdout, false),
    );
    files
}

async fn observe(store: &Path, captured: &Value, stage: &str) -> Value {
    let root = repository_root();
    let node = std::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(node.status.success());
    let node = String::from_utf8(node.stdout).unwrap().trim().to_owned();
    let policy: Policy = serde_json::from_value(json!({
        "version":format!("booking-{stage}-local-v1"),"suite":"commands-v1",
        "environment":yoneda_core::build::ENVIRONMENT,"required_checks":["booking-acceptance"],
        "build":{"setup":[{"name":"bundle","argv":[node,"build.mjs"],"timeout_seconds":10}],
        "checks":[{"name":"booking-acceptance","argv":[node,
            root.join("fixtures/event-booking/oracle/run.mjs"),stage,
            root.join("node_modules/vitest/vitest.mjs")],"timeout_seconds":80}]}
    }))
    .unwrap();
    let commit = captured["commit"].as_str().unwrap();
    let source = crate::git::read_git_revision(store.to_str().unwrap(), commit)
        .await
        .unwrap();
    let clean = tempfile::tempdir().unwrap();
    crate::transport::materialize_git(clean.path(), &source).unwrap();
    #[cfg(target_os = "linux")]
    if unsafe { libc::geteuid() } == 0 {
        assert!(
            std::process::Command::new("/usr/bin/chown")
                .args(["-R", "1000:1000"])
                .arg(clean.path())
                .status()
                .unwrap()
                .success()
        );
    }
    let report = crate::evaluation::run_profile(clean.path(), policy.build.as_ref().unwrap())
        .await
        .unwrap();
    let revision = Revision {
        repository: "offline/booking".into(),
        commit: commit.into(),
    };
    let evaluation = Evaluation {
        id: "booking-independent".into(),
        candidate: "captured".into(),
        revision: revision.clone(),
        policy: policy.version.clone(),
        suite: policy.suite.clone(),
        environment: policy.environment.clone(),
        checks: yoneda_core::build::checks_from_report(&policy, &report).unwrap(),
        evidence: yoneda_core::digest(&serde_json::to_vec(&report).unwrap()),
    };
    let verdict = validate_evaluation(&evaluation, "captured", &revision, &policy);
    let mut stale = revision.clone();
    stale.commit = "0".repeat(40);
    assert_eq!(
        validate_evaluation(&evaluation, "captured", &stale, &policy)
            .unwrap_err()
            .code,
        "EVIDENCE_MISMATCH"
    );
    json!({"stage":stage,"revision":revision,"report":report,"evaluation":evaluation,
        "accepted":verdict.is_ok(),"rejection":verdict.err().map(|error|error.code),
        "runtime":"actual workerd DO SQLite","agent_evidence":false})
}

#[tokio::test]
async fn frozen_booking_captures_preserve_disjoint_merge_and_reject_seeded_duplicates() {
    let files =
        crate::export_workspace(&repository_root().join("fixtures/event-booking/source")).unwrap();
    assert!(
        !files
            .keys()
            .any(|path| path.contains("oracle") || path.starts_with("dist/"))
    );
    let canonical = tempfile::tempdir().unwrap();
    let base = capture(canonical.path(), None, &files, "Booking initial control")
        .await
        .unwrap();
    let initial = observe(canonical.path(), &base, "initial_build").await;
    assert_eq!(initial["accepted"], true, "{initial}");
    let mut head_files = files.clone();
    head_files
        .get_mut("public/style.css")
        .unwrap()
        .content
        .push_str("\n/* unrelated presentation revision */\n");
    let head = capture(
        canonical.path(),
        base["commit"].as_str(),
        &head_files,
        "Presentation branch",
    )
    .await
    .unwrap();
    let branch = tempfile::tempdir().unwrap();
    let feature = capture_fresh(
        branch.path(),
        canonical.path().to_str().unwrap(),
        base["commit"].as_str().unwrap(),
        &crate::transport::from_legacy(reference(&files, "waitlist_feature")).unwrap(),
        "Hand-authored waitlist control",
    )
    .await
    .unwrap();
    crate::git_revision::fetch_git(
        canonical.path(),
        branch.path().to_str().unwrap(),
        feature["commit"].as_str().unwrap(),
    )
    .await
    .unwrap();
    let merged = crate::conflict_merge::refresh(
        canonical.path(),
        base["commit"].as_str().unwrap(),
        head["commit"].as_str().unwrap(),
        feature["commit"].as_str().unwrap(),
        "offline/booking",
        &["booking.mjs".into()],
    )
    .await
    .unwrap();
    assert_eq!(merged["status"], "clean");
    assert_eq!(merged["evidence"]["overlapping_paths"], json!([]));
    let merged_capture = json!({"commit":merged["merge_commit"],"tree":merged["tree"]});
    let waitlist = observe(canonical.path(), &merged_capture, "waitlist_feature").await;
    assert_eq!(waitlist["accepted"], true, "{waitlist}");
    let seeded_bug = observe(
        canonical.path(),
        &merged_capture,
        "duplicate_registration_bugfix",
    )
    .await;
    assert_eq!(seeded_bug["rejection"], "CHECKS_FAILED", "{seeded_bug}");
    fs::write(
        canonical.path().join("booking.mjs"),
        reference(&files, "duplicate_registration_bugfix")["booking.mjs"]
            .content
            .as_bytes(),
    )
    .unwrap();
    let recheck = observe(
        canonical.path(),
        &merged_capture,
        "duplicate_registration_bugfix",
    )
    .await;
    assert_eq!(recheck["rejection"], "CHECKS_FAILED", "{recheck}");
    let mut repaired_files = reference(&files, "duplicate_registration_bugfix");
    repaired_files.insert(
        "public/style.css".into(),
        head_files["public/style.css"].clone(),
    );
    let fixed = capture_fresh(
        branch.path(),
        canonical.path().to_str().unwrap(),
        merged_capture["commit"].as_str().unwrap(),
        &crate::transport::from_legacy(repaired_files).unwrap(),
        "Hand-authored duplicate repair control",
    )
    .await
    .unwrap();
    let repaired = observe(branch.path(), &fixed, "duplicate_registration_bugfix").await;
    assert_eq!(repaired["accepted"], true, "{repaired}");
    if std::env::var("YONEDA_SEMANTIC_BENCHMARK_OUTPUT").as_deref() == Ok("1") {
        let output =
            repository_root().join(".local/semantic-context-investigation/booking-immutable");
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join("results.json"),serde_json::to_vec_pretty(&json!({"agent_evidence":false,"initial":initial,
            "refresh":merged,"waitlist":waitlist,"seeded_bug":seeded_bug,"recheck":recheck,"repaired":repaired})).unwrap()).unwrap();
        git(
            canonical.path(),
            &[
                "update-ref",
                "refs/heads/booking-merged",
                merged_capture["commit"].as_str().unwrap(),
            ],
        )
        .await
        .unwrap();
        for (store, name) in [
            (canonical.path(), "history.bundle"),
            (branch.path(), "repair.bundle"),
        ] {
            git(
                store,
                &[
                    "bundle",
                    "create",
                    output.join(name).to_str().unwrap(),
                    "--all",
                ],
            )
            .await
            .unwrap();
        }
    }
}
