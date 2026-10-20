//! Real native SourceWorkspace ledger served over loopback HTTP; no provider or Cloudflare calls.
use super::http::{Response, Server};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use yoneda_agents_core::source_workspace::*;
use yoneda_app::{SqlStore, execute_source_workspace, native::NativeStore};

pub struct NativeSourceServer {
    pub server: Server,
    pub workspace: String,
    pub view_digest: String,
}
impl NativeSourceServer {
    pub fn new() -> Self {
        let base = SourceRevision {
            repository: "fixture/base".into(),
            commit: "a".repeat(40),
            tree: "b".repeat(40),
        };
        let bytes = BTreeMap::from([
            ("public-sibling/hidden.txt", b"outside export".to_vec()),
            ("public/index.html", b"<html>frozen source</html>".to_vec()),
            ("public/nested/data.bin", vec![0xff, 0, 0x80]),
        ]);
        let view = SourceView {
            version: 1,
            base: base.clone(),
            files: bytes
                .iter()
                .map(|(path, bytes)| SourceFile {
                    path: (*path).into(),
                    mode: FileMode::Regular,
                    size: bytes.len() as u64,
                    content: ContentRef::Git {
                        repository: base.repository.clone(),
                        commit: base.commit.clone(),
                        path: (*path).into(),
                        blob: "c".repeat(40),
                    },
                })
                .collect(),
        };
        let digest = view_digest(&view, &[]).unwrap();
        let binding = SourceBinding {
            version: 1,
            transport: TRANSPORT.into(),
            workspace_id: workspace_id("repo", "evaluate", 3, &digest).unwrap(),
            repo_id: "repo".into(),
            run_id: "run".into(),
            job_id: "evaluate".into(),
            epoch: 3,
            execution_id: "evaluate".into(),
            role: SourceRole::Builder,
            access: SourceAccess::ReadWrite,
            view_digest: digest.clone(),
            baseline_overrides_digest: yoneda_agents_core::fingerprint(&json!([])).unwrap(),
            base: base.clone(),
            parents: vec![base.commit.clone()],
            policy_digest: "d".repeat(64),
            intent_digest: "e".repeat(64),
            write_paths: vec!["**".into()],
            protected_paths: vec![],
            scratch_paths: vec![],
            inputs: vec![base],
            repo_base_version: 0,
            working_branch_id: None,
            working_branch_version: None,
        };
        let workspace = binding.workspace_id.clone();
        let claims = ActorClaims {
            version: 1,
            workspace_id: workspace.clone(),
            binding_digest: binding.digest().unwrap(),
            repo_id: binding.repo_id.clone(),
            run_id: binding.run_id.clone(),
            job_id: binding.job_id.clone(),
            epoch: binding.epoch,
            execution_id: binding.execution_id.clone(),
            view_digest: digest.clone(),
            role: binding.role,
            access: binding.access,
            purpose: ActorPurpose::Supervisor,
            expires_at: 200_000,
        };
        let grant = ActorGrant {
            signature: sign(&claims),
            claims: claims.clone(),
        };
        let read_claims = ActorClaims {
            access: SourceAccess::ReadOnly,
            ..claims
        };
        let read_grant = ActorGrant {
            signature: sign(&read_claims),
            claims: read_claims,
        };
        let temporary = tempfile::tempdir().unwrap();
        let mut initialized = false;
        let server = Server::respond(move |request| {
            let db = NativeStore::open(&temporary.path().join("source.sqlite")).unwrap();
            let call = |mut args: Value| {
                args["now"] = json!(1000);
                args["_source_signing_key"] = json!("aa".repeat(32));
                if args.get("_actor").is_none() {
                    args["_actor"] = json!(grant);
                }
                execute_source_workspace(&db, args)
            };
            if !initialized {
                call(json!({"op":"source_init","request_id":"init","binding":binding,"view":view,"baseline_overrides":[]})).unwrap();
                // Real committed native mutation makes remote directory version nonzero.
                call(json!({"op":"source_chmod","request_id":"remote-mode","path":"public/index.html","mode":"100755","expected_workspace_version":0,"expected_file_version":0})).unwrap();
                initialized = true;
            }
            let route = request
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap();
            let op = route.rsplit('/').next().unwrap();
            let mut args: Value =
                serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
            // Root evaluation may read the frozen ledger but must never send its COW writes.
            assert!(["source_status", "source_stat", "source_list", "source_read"].contains(&op));
            args["op"] = json!(op);
            args["_actor"] = json!(read_grant);
            let result = call(args.clone());
            let rows = db
                .query("SELECT payload FROM sw_state WHERE id='workspace'", &[])
                .unwrap();
            let state: Value = serde_json::from_str(rows[0]["payload"].as_str().unwrap()).unwrap();
            assert_eq!(
                state["workspace_version"], 1,
                "Evaluation must not mutate frozen ledger"
            );
            match result {
                Ok(value) if op == "source_read" => {
                    let path = args["path"].as_str().unwrap();
                    let begin = value["offset"].as_u64().unwrap() as usize;
                    let end = begin + value["length"].as_u64().unwrap() as usize;
                    Response::raw(value, &bytes[path][begin..end])
                }
                Ok(value) => Response::json(value),
                Err(error) => {
                    let mut response = Response::json(json!({"error":{"code":error.code}}));
                    response.status = 409;
                    response
                }
            }
        });
        Self {
            server,
            workspace,
            view_digest: digest,
        }
    }
}
fn sign(claims: &ActorClaims) -> String {
    // Fixture-only HMAC, same documented domain as the native grant verifier; no real keys.
    let mut inner = Sha256::new();
    let mut outer = Sha256::new();
    let mut key = [0_u8; 64];
    key[..32].fill(0xaa);
    inner.update(key.map(|b| b ^ 0x36));
    inner.update(b"yoneda:source-grant:v1\0");
    inner.update(
        yoneda_agents_core::fingerprint(&json!(claims))
            .unwrap()
            .as_bytes(),
    );
    outer.update(key.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
