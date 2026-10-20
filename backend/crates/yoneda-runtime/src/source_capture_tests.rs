use crate::source_capture::capture_delta;
use serde_json::json;
use yoneda_agents_core::{
    source_changeset::{SourceChange, SourceChangeset},
    source_workspace::*,
};

pub(crate) fn fixture() -> (
    SourceBinding,
    SourceView,
    Vec<BaselineOverride>,
    SourceChangeset,
) {
    let base = SourceRevision {
        repository: "canonical".into(),
        commit: "1".repeat(40),
        tree: "2".repeat(40),
    };
    let input = SourceRevision {
        repository: "specialist".into(),
        commit: "3".repeat(40),
        tree: "4".repeat(40),
    };
    let file = |path: &str, revision: &SourceRevision, blob: &str| SourceFile {
        path: path.into(),
        mode: FileMode::Regular,
        size: 3,
        content: ContentRef::Git {
            path: path.into(),
            repository: revision.repository.clone(),
            commit: revision.commit.clone(),
            blob: blob.repeat(40),
        },
    };
    let view = SourceView {
        version: 1,
        base: base.clone(),
        files: vec![file("untouched", &base, "5")],
    };
    let overrides = vec![BaselineOverride {
        path: "specialist.bin".into(),
        file: Some(file("specialist.bin", &input, "6")),
    }];
    let digest = view_digest(&view, &overrides).unwrap();
    let id = workspace_id("repo", "producer", 1, &digest).unwrap();
    let binding:SourceBinding=serde_json::from_value(json!({"version":1,"transport":"api-source-v1","workspace_id":id,"repo_id":"repo","run_id":"run","job_id":"producer","epoch":1,"execution_id":"execution","role":"integrator","access":"read_write","view_digest":digest,"baseline_overrides_digest":yoneda_agents_core::fingerprint(&serde_json::to_value(&overrides).unwrap()).unwrap(),"base":base,"parents":[base.commit],"policy_digest":"7".repeat(64),"intent_digest":"8".repeat(64),"write_paths":["**"],"protected_paths":["schema.json"],"inputs":[base,input],"repo_base_version":0,"working_branch_id":null,"working_branch_version":null})).unwrap();
    let mut after = overrides[0].file.clone().unwrap();
    after.path = "added".into();
    let changeset = SourceChangeset {
        version: 1,
        transport: TRANSPORT.into(),
        workspace_id: binding.workspace_id.clone(),
        repo_id: binding.repo_id.clone(),
        run_id: binding.run_id.clone(),
        job_id: binding.job_id.clone(),
        epoch: binding.epoch,
        execution_id: binding.execution_id.clone(),
        view_digest: binding.view_digest.clone(),
        baseline_overrides: overrides.clone(),
        base: binding.base.clone(),
        parents: binding.parents.clone(),
        workspace_version: 1,
        policy_digest: binding.policy_digest.clone(),
        intent_digest: binding.intent_digest.clone(),
        write_paths: binding.write_paths.clone(),
        changes: vec![SourceChange {
            path: "added".into(),
            before: None,
            after: Some(after),
        }],
    };
    (binding, view, overrides, changeset)
}

#[test]
fn sealed_delta_keeps_untouched_specialist_overrides_but_never_deletes_unread_base() {
    let (binding, view, overrides, changeset) = fixture();
    let digest = changeset.digest().unwrap();
    let delta = capture_delta(&binding, &view, &overrides, &changeset, &digest).unwrap();
    assert_eq!(
        delta.len(),
        2,
        "unchanged specialist baseline must survive alongside the final source delta"
    );
    assert_eq!(delta["specialist.bin"], overrides[0].file);
    assert!(
        !delta.contains_key("untouched"),
        "unread source is not deleted or retransferred"
    );
}

#[test]
fn capture_rejects_wrong_producer_policy_digest_before_state_and_sha256_git() {
    let (binding, view, overrides, original) = fixture();
    let mut variants = vec![];
    let mut c = original.clone();
    c.epoch = 2;
    variants.push(c);
    let mut c = original.clone();
    c.policy_digest = "a".repeat(64);
    variants.push(c);
    let mut c = original.clone();
    c.changes[0].before = Some(overrides[0].file.clone().unwrap());
    variants.push(c);
    let mut c = original.clone();
    c.parents[0] = "1".repeat(64);
    variants.push(c);
    for c in variants {
        assert!(capture_delta(&binding, &view, &overrides, &c, &c.digest().unwrap()).is_err());
    }
    assert!(capture_delta(&binding, &view, &overrides, &original, &"f".repeat(64)).is_err());
    assert!(
        capture_delta(&binding, &view, &[], &original, &original.digest().unwrap()).is_err(),
        "frozen view includes exact baseline overrides"
    );
}
