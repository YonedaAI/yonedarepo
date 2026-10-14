use super::*;
use crate::native::NativeStore;
pub(super) const KEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(super) fn db() -> NativeStore {
    NativeStore::memory().unwrap()
}
pub(super) fn view() -> SourceView {
    SourceView {
        version: 1,
        base: SourceRevision {
            repository: "test/base".into(),
            commit: "a".repeat(40),
            tree: "b".repeat(40),
        },
        files: vec![file("README.md", b"readme"), file("src/main.rs", b"main")],
    }
}
pub(super) fn file(path: &str, bytes: &[u8]) -> SourceFile {
    SourceFile {
        path: path.into(),
        mode: FileMode::Regular,
        size: bytes.len() as u64,
        content: ContentRef::Git {
            repository: "test/base".into(),
            commit: "a".repeat(40),
            path: path.into(),
            blob: "c".repeat(40),
        },
    }
}
pub(super) fn binding() -> SourceBinding {
    let view = view();
    let digest = view_digest(&view, &[]).unwrap();
    SourceBinding {
        version: 1,
        transport: TRANSPORT.into(),
        workspace_id: workspace_id("repo", "job:run:agent-1", 1, &digest).unwrap(),
        repo_id: "repo".into(),
        run_id: "run".into(),
        job_id: "job:run:agent-1".into(),
        epoch: 1,
        execution_id: "run:agent-1".into(),
        role: SourceRole::Builder,
        access: SourceAccess::ReadWrite,
        view_digest: digest,
        baseline_overrides_digest: yoneda_core::fingerprint(&json!([])).unwrap(),
        base: view.base.clone(),
        parents: vec![view.base.commit.clone()],
        policy_digest: "d".repeat(64),
        intent_digest: "e".repeat(64),
        write_paths: vec!["**".into()],
        protected_paths: vec!["schema.json".into()],
        scratch_paths: vec![],
        inputs: vec![view.base],
        repo_base_version: 0,
        working_branch_id: None,
        working_branch_version: None,
    }
}
pub(super) fn actor(binding: &SourceBinding, now: i64, purpose: ActorPurpose) -> Value {
    json!(sign_actor(binding, now + 200000, purpose, KEY).unwrap())
}
pub(super) fn init_input() -> Value {
    json!({"op":"source_init","request_id":"init","binding":binding(),"view":view(),"baseline_overrides":[]})
}
pub(super) fn call(db: &NativeStore, mut c: Value) -> Result<Value> {
    let now = c["now"].as_i64().unwrap_or(1000);
    c["now"] = json!(now);
    if c.get("_source_signing_key").is_none() {
        c["_source_signing_key"] = json!(KEY);
    }
    if c.get("_actor").is_none() && c.get("_gc_grant").is_none() {
        c["_actor"] = actor(&binding(), now, ActorPurpose::Supervisor);
    }
    execute_source_workspace(db, c)
}
pub(super) fn init(db: &NativeStore) -> Value {
    call(db, init_input()).unwrap()
}
pub(super) fn ticket(
    db: &NativeStore,
    path: &str,
    bytes: &[u8],
    version: i64,
    file_version: i64,
) -> Value {
    let hash = yoneda_core::digest(bytes);
    let receipt=call(db,json!({"op":"source_upload_ticket","request_id":format!("ticket-{path}-{version}"),"path":path,"sha256":hash,"size":bytes.len(),"mode":"100644","expected_workspace_version":version,"expected_file_version":file_version})).unwrap();
    call(db,json!({"op":"source_verify_upload","request_id":format!("verify-{path}-{version}"),"ticket_id":receipt["ticket"]["id"],"sha256":hash,"size":bytes.len()})).unwrap()
}
