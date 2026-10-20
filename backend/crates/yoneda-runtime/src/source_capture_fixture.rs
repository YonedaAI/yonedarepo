//! Native SQLite source authority plus real local Git objects; no provider or workerd claims.
use crate::source_git_fixture::{Server, git, oid};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use yoneda_agents_core::source_workspace::*;
use yoneda_app::{execute_source_workspace, native::NativeStore};

pub(crate) const TOKEN: &str = "local-capture-test-only";
const KEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(crate) struct Fixture {
    pub db: std::path::PathBuf,
    pub binding: SourceBinding,
    pub seal: Value,
    pub destination: std::path::PathBuf,
    pub input: std::path::PathBuf,
    pub bytes: BTreeMap<String, Vec<u8>>,
}
fn sign(claims: Value, domain: &str) -> Value {
    let mut inner = Sha256::new();
    let mut outer = Sha256::new();
    let mut ipad = [0x36; 64];
    let mut opad = [0x5c; 64];
    for index in 0..32 {
        ipad[index] ^= 0xaa;
        opad[index] ^= 0xaa;
    }
    inner.update(ipad);
    inner.update(domain.as_bytes());
    inner.update(yoneda_agents_core::fingerprint(&claims).unwrap().as_bytes());
    outer.update(opad);
    outer.update(inner.finalize());
    json!({"claims":claims,"signature":yoneda_agents_core::hex(&outer.finalize())})
}
impl Fixture {
    pub fn call(&self, command: Value) -> yoneda_agents_core::Result<Value> {
        self.call_as(command, "supervisor")
    }
    pub fn call_as(&self, mut command: Value, purpose: &str) -> yoneda_agents_core::Result<Value> {
        let b = &self.binding;
        command["now"] = json!(1000);
        command["_source_signing_key"] = json!(KEY);
        command["_actor"] = sign(
            json!({"version":1,"workspace_id":b.workspace_id,"binding_digest":b.digest().unwrap(),"repo_id":b.repo_id,"run_id":b.run_id,"job_id":b.job_id,"epoch":b.epoch,"execution_id":b.execution_id,"view_digest":b.view_digest,"role":b.role,"access":b.access,"purpose":purpose,"expires_at":200000}),
            "yoneda:source-grant:v1\0",
        );
        execute_source_workspace(&NativeStore::open(&self.db)?, command)
    }
    pub fn manifest(&self, section: &str, cursor: &Value) -> Value {
        let b = &self.binding;
        let s = &self.seal;
        let grant = sign(
            json!({"version":1,"workspace_id":b.workspace_id,"binding_digest":b.digest().unwrap(),"seal_id":s["seal_id"],"checkpoint_id":s["checkpoint_id"],"changeset_digest":s["changeset_digest"],"capture_job_id":"capture","capture_epoch":1,"expires_at":200000,"purpose":"read_manifest"}),
            "yoneda:source-capture:v1\0",
        );
        execute_source_workspace(&NativeStore::open(&self.db).unwrap(),json!({"op":"source_manifest","now":1000,"_source_signing_key":KEY,"_capture_grant":grant,"checkpoint_id":s["checkpoint_id"],"section":section,"after":cursor,"limit":1})).unwrap()
    }
    pub fn context(&self) -> Value {
        let b = &self.binding;
        let s = &self.seal;
        json!({"version":1,"binding":b,"seal":{"workspace_id":b.workspace_id,"seal_id":s["seal_id"],"checkpoint_id":s["checkpoint_id"],"changeset_digest":s["changeset_digest"],"workspace_version":s["workspace_version"]},"view_digest":b.view_digest,"base":b.base,"parents":b.parents,"baseline_overrides_digest":b.baseline_overrides_digest,"manifest_header":s["changeset_header"],"manifest_cursor":null})
    }
}
fn revision(root: &std::path::Path, repository: &str, commit: String) -> SourceRevision {
    SourceRevision {
        repository: repository.into(),
        tree: oid(git(
            root,
            &["rev-parse", &format!("{commit}^{{tree}}")],
            b"",
        )),
        commit,
    }
}
pub(crate) fn file(root: &std::path::Path, revision: &SourceRevision, path: &str) -> SourceFile {
    let blob = oid(git(
        root,
        &["rev-parse", &format!("{}:{path}", revision.commit)],
        b"",
    ));
    let bytes = git(root, &["cat-file", "blob", &blob], b"");
    SourceFile {
        path: path.into(),
        mode: FileMode::Regular,
        size: bytes.len() as u64,
        content: ContentRef::Git {
            repository: revision.repository.clone(),
            commit: revision.commit.clone(),
            path: path.into(),
            blob,
        },
    }
}
pub(crate) fn fixture(server: &Server) -> Fixture {
    let destination = server.root.path().join("fork.git");
    let work = server.root.path().join("reference");
    git(
        server.root.path(),
        &[
            "clone",
            destination.to_str().unwrap(),
            work.to_str().unwrap(),
        ],
        b"",
    );
    git(&work, &["checkout", "main"], b"");
    std::fs::write(work.join("delete"), b"gone\n").unwrap();
    std::fs::write(work.join("mode"), b"executable\n").unwrap();
    std::fs::create_dir(work.join("wide")).unwrap();
    for index in 0..450 {
        std::fs::write(work.join(format!("wide/untouched-{index:04}")), b"unread\n").unwrap();
    }
    git(&work, &["add", "."], b"");
    git(
        &work,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@invalid",
            "commit",
            "-m",
            "base",
        ],
        b"",
    );
    git(&work, &["push", "origin", "main"], b"");
    let base = revision(
        &destination,
        "canonical",
        oid(git(&destination, &["rev-parse", "main"], b"")),
    );
    let input = server.root.path().join("specialist.git");
    git(
        server.root.path(),
        &["init", "--bare", input.to_str().unwrap()],
        b"",
    );
    std::fs::create_dir(work.join("retained")).unwrap();
    std::fs::write(work.join("retained/overlay.bin"), b"specialist\0\xff").unwrap();
    git(&work, &["add", "retained"], b"");
    git(
        &work,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@invalid",
            "commit",
            "-m",
            "specialist",
        ],
        b"",
    );
    git(&work, &["push", input.to_str().unwrap(), "HEAD:main"], b"");
    let specialist = revision(
        &input,
        "specialist",
        oid(git(&input, &["rev-parse", "main"], b"")),
    );
    let mut paths = vec!["base".to_string(), "delete".into(), "mode".into()];
    paths.extend((0..450).map(|index| format!("wide/untouched-{index:04}")));
    let view = SourceView {
        version: 1,
        base: base.clone(),
        files: paths.iter().map(|p| file(&destination, &base, p)).collect(),
    };
    let overrides = vec![BaselineOverride {
        path: "retained/overlay.bin".into(),
        file: Some(file(&input, &specialist, "retained/overlay.bin")),
    }];
    let mut binding = crate::source_capture_tests::fixture().0;
    binding.base = base.clone();
    binding.parents = vec![base.commit.clone()];
    binding.inputs = vec![base, specialist];
    binding.view_digest = view_digest(&view, &overrides).unwrap();
    binding.workspace_id = workspace_id(
        &binding.repo_id,
        &binding.job_id,
        binding.epoch,
        &binding.view_digest,
    )
    .unwrap();
    binding.baseline_overrides_digest = yoneda_agents_core::fingerprint(&json!(overrides)).unwrap();
    let mut f = Fixture {
        db: server.root.path().join("source.db"),
        binding,
        seal: Value::Null,
        destination,
        input,
        bytes: BTreeMap::new(),
    };
    f.call(json!({"op":"source_init","request_id":"init","binding":f.binding,"view":view,"baseline_overrides":overrides})).unwrap();
    f.call(json!({"op":"source_delete","request_id":"delete","path":"delete","expected_workspace_version":0,"expected_file_version":0})).unwrap();
    f.call(json!({"op":"source_chmod","request_id":"mode","path":"mode","mode":"100755","expected_workspace_version":1,"expected_file_version":0})).unwrap();
    f.call(json!({"op":"source_rename","request_id":"rename","overwrite":false,"from":"base","to":"renamed","expected_workspace_version":2,"expected_from_version":0,"expected_to_version":0})).unwrap();
    let bytes = (0..140000).map(|n| (n % 251) as u8).collect::<Vec<_>>();
    let hash = yoneda_agents_core::digest(&bytes);
    let ticket=f.call(json!({"op":"source_upload_ticket","request_id":"upload","path":"wide/changed.bin","sha256":hash,"size":bytes.len(),"mode":"100644","expected_workspace_version":3,"expected_file_version":0})).unwrap();
    f.call(json!({"op":"source_verify_upload","request_id":"verify","ticket_id":ticket["ticket"]["id"],"sha256":hash,"size":bytes.len()})).unwrap();
    f.call(json!({"op":"source_create","request_id":"create","path":"wide/changed.bin","ticket_id":ticket["ticket"]["id"],"expected_workspace_version":3,"expected_file_version":0})).unwrap();
    f.bytes.insert("wide/changed.bin".into(), bytes);
    let checkpoint=f.call(json!({"op":"source_checkpoint","request_id":"checkpoint","expected_workspace_version":4})).unwrap();
    f.seal=f.call(json!({"op":"source_seal","request_id":"seal","expected_workspace_version":4,"checkpoint_id":checkpoint["checkpoint_id"],"expected_checkpoint_digest":checkpoint["changeset_digest"]})).unwrap();
    f
}
