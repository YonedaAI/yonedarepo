//! Finite semantic counterexamples, not model performance or semantic resolution.
//! Reproduce: cargo test -p yoneda-runtime semantic_merge_benchmark -- --nocapture
//! Set YONEDA_SEMANTIC_BENCHMARK_OUTPUT=1 to retain bundles and JSON under .local.
use crate::{capture, conflict_merge::refresh, git, git::capture_fresh};
use serde_json::{Value, json};
use std::{fs, path::Path};
use yoneda_core::{Evaluation, Policy, Revision, validate_evaluation};

#[path = "semantic_merge_benchmark/cases.rs"]
mod cases;
use cases::{cases, workspace};
#[path = "semantic_merge_benchmark/event_booking.rs"]
mod event_booking;

fn policy(node: &str, oracle: &Path) -> Policy {
    serde_json::from_value(json!({
        "version":"semantic-benchmark-v1","suite":"commands-v1",
        "environment":yoneda_core::build::ENVIRONMENT,
        "required_checks":["syntax","behavior"],"build":{"checks":[
            {"name":"syntax","argv":[node,"--input-type=module","-e",
                "import {execFileSync} from 'node:child_process';for(const p of ['producer.mjs','consumer.mjs'])execFileSync(process.execPath,['--check',p]);"],"timeout_seconds":10},
            {"name":"behavior","argv":[node,oracle.to_str().unwrap()],"timeout_seconds":10}
        ]}
    })).unwrap()
}

async fn evaluate(repository: &Path, commit: &str, policy: &Policy) -> Value {
    let revision = Revision {
        repository: "offline/semantic-benchmark".into(),
        commit: commit.into(),
    };
    let files = crate::git::read_git_revision(repository.to_str().unwrap(), commit)
        .await
        .unwrap();
    let clean = tempfile::tempdir().unwrap();
    // No oracle or mutable branch checkout is trusted as captured source.
    crate::transport::materialize_git(clean.path(), &files).unwrap();
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
    let evaluation = Evaluation {
        id: "offline-evaluation".into(),
        candidate: "measured".into(),
        revision: revision.clone(),
        policy: policy.version.clone(),
        suite: policy.suite.clone(),
        environment: policy.environment.clone(),
        checks: yoneda_core::build::checks_from_report(policy, &report).unwrap(),
        evidence: yoneda_core::digest(&serde_json::to_vec(&report).unwrap()),
    };
    let verdict = validate_evaluation(&evaluation, "measured", &revision, policy);
    // A syntax-only policy explicitly demonstrates the coverage boundary.
    let mut weak = policy.clone();
    weak.required_checks = vec!["syntax".into()];
    let syntax_only = validate_evaluation(&evaluation, "measured", &revision, &weak).is_ok();
    let mut wrong_revision = revision.clone();
    wrong_revision.commit = "0".repeat(40);
    assert_eq!(
        validate_evaluation(&evaluation, "measured", &wrong_revision, policy)
            .unwrap_err()
            .code,
        "EVIDENCE_MISMATCH"
    );
    json!({"revision":revision,"evaluation":evaluation,"report":report,
        "accepted":verdict.is_ok(),"rejection":verdict.err().map(|e|e.code),
        "syntax_only_accepted":syntax_only,"stale_evidence_rejection":"EVIDENCE_MISMATCH"})
}

#[tokio::test]
async fn semantic_merge_benchmark_checks_exact_captures_and_rejects_incompatible_composition() {
    let node = std::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(
        node.status.success(),
        "Node is required for the deterministic benchmark"
    );
    let node = String::from_utf8(node.stdout).unwrap().trim().to_owned();
    let mut results = Vec::new();
    for case in cases() {
        let trusted = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(trusted.path(), fs::Permissions::from_mode(0o755)).unwrap();
        }
        let oracle = trusted.path().join("oracle.mjs");
        let source = format!(
            "import assert from 'node:assert/strict';import {{pathToFileURL}} from 'node:url';const {{act}}=await import(pathToFileURL(process.cwd()+'/consumer.mjs'));{}\n",
            case.oracle
        );
        fs::write(&oracle, &source).unwrap();
        let policy = policy(&node, &oracle);
        yoneda_core::build::validate_policy(&policy).unwrap();
        let repository = tempfile::tempdir().unwrap();
        let base = capture(
            repository.path(),
            None,
            &workspace(case.producer, case.consumer),
            "base",
        )
        .await
        .unwrap();
        let base_id = base["commit"].as_str().unwrap();
        let head = capture(
            repository.path(),
            Some(base_id),
            &workspace(case.head, case.consumer),
            "head",
        )
        .await
        .unwrap();
        let head_id = head["commit"].as_str().unwrap();
        let candidate_root = tempfile::tempdir().unwrap();
        let candidate = capture_fresh(
            candidate_root.path(),
            repository.path().to_str().unwrap(),
            base_id,
            &crate::transport::from_legacy(workspace(case.producer, case.candidate)).unwrap(),
            "candidate",
        )
        .await
        .unwrap();
        let candidate_id = candidate["commit"].as_str().unwrap();
        // Materialize actual captured objects in one Git store for the real refresh.
        crate::git_revision::fetch_git(
            repository.path(),
            candidate_root.path().to_str().unwrap(),
            candidate_id,
        )
        .await
        .unwrap();
        let merged = refresh(
            repository.path(),
            base_id,
            head_id,
            candidate_id,
            "offline/semantic-benchmark",
            &["consumer.mjs".into()],
        )
        .await
        .unwrap();
        assert_eq!(merged["status"], "clean");
        assert_eq!(merged["evidence"]["overlapping_paths"], json!([]));
        assert_eq!(
            merged["evidence"]["captured_paths"],
            json!(["consumer.mjs"])
        );
        assert_eq!(
            merged["evidence"]["intervening_paths"],
            json!(["producer.mjs"])
        );
        let merged_id = merged["merge_commit"].as_str().unwrap();
        crate::git_revision::verify_git_parents(
            repository.path().to_str().unwrap(),
            merged_id,
            &[head_id, candidate_id],
        )
        .await
        .unwrap();
        git(
            repository.path(),
            &["update-ref", "refs/heads/measured-merge", merged_id],
        )
        .await
        .unwrap();
        let mut observed = serde_json::Map::new();
        for (name, commit) in [
            ("base", base_id),
            ("head", head_id),
            ("candidate", candidate_id),
            ("merge", merged_id),
        ] {
            let result = evaluate(repository.path(), commit, &policy).await;
            assert_eq!(
                result["accepted"],
                name != "merge" || case.compatible,
                "{} {name}: {result}",
                case.id
            );
            assert_eq!(result["syntax_only_accepted"], true);
            observed.insert(name.into(), result);
        }
        // Repairing the mutable checkout must not change the captured verdict.
        fs::write(repository.path().join("consumer.mjs"), case.repair).unwrap();
        let recheck = evaluate(repository.path(), merged_id, &policy).await;
        assert_eq!(recheck["accepted"], case.compatible);
        if !case.compatible {
            assert_eq!(recheck["rejection"], "CHECKS_FAILED");
        }
        // Hand-authored repair control: this is not a paid resolver/model result.
        let repaired = capture_fresh(
            candidate_root.path(),
            repository.path().to_str().unwrap(),
            head_id,
            &crate::transport::from_legacy(workspace(case.head, case.repair)).unwrap(),
            "deterministic repair control",
        )
        .await
        .unwrap();
        let repair = evaluate(
            candidate_root.path(),
            repaired["commit"].as_str().unwrap(),
            &policy,
        )
        .await;
        assert_eq!(repair["accepted"], true);
        let result = json!({"case":case.id,"expected_compatible":case.compatible,"base_capture":base,
            "head_capture":head,"candidate_capture":candidate,"refresh":merged,"observed":observed,
            "recheck":recheck,"repair_capture":repaired,"repair":repair,
            "scope":"local macOS/Linux helper and core acceptance gate; no deployed ledger, paid resolver or browser acceptance"});
        if std::env::var("YONEDA_SEMANTIC_BENCHMARK_OUTPUT").as_deref() == Ok("1") {
            let output = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../.local/semantic-context-investigation/semantic")
                .join(case.id);
            fs::create_dir_all(&output).unwrap();
            fs::write(
                output.join("result.json"),
                serde_json::to_vec_pretty(&result).unwrap(),
            )
            .unwrap();
            fs::write(output.join("oracle.mjs"), source).unwrap();
            git(
                repository.path(),
                &[
                    "bundle",
                    "create",
                    output.join("history.bundle").to_str().unwrap(),
                    "--all",
                ],
            )
            .await
            .unwrap();
            git(
                candidate_root.path(),
                &[
                    "bundle",
                    "create",
                    output.join("repair.bundle").to_str().unwrap(),
                    "--all",
                ],
            )
            .await
            .unwrap();
        }
        println!(
            "semantic benchmark {}: Git clean, branches pass, composed behavior {}, exact recheck {}, repair passes",
            case.id, case.compatible, case.compatible
        );
        results.push(result);
    }
    assert_eq!(results.len(), 3);
}
