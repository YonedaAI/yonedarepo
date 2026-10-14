//! Real native SourceWorkspace ledger behind a loopback HTTP shape of the Worker source broker.
//! Local protocol fixture only; no provider, R2 or Cloudflare calls.
use super::http::{Response, Server};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use yoneda_app::{execute_source_workspace, native::NativeStore};
use yoneda_core::source_workspace::*;

pub const BASE: [(&str, &[u8]); 2] = [("a.txt", b"alpha"), ("b.txt", b"bravo")];

pub struct NativeReceiptServer {
    pub server: Server,
    pub workspace: String,
    pub view_digest: String,
}
impl NativeReceiptServer {
    pub fn new() -> Self {
        let base = SourceRevision {
            repository: "fixture/base".into(),
            commit: "a".repeat(40),
            tree: "b".repeat(40),
        };
        let view = SourceView {
            version: 1,
            base: base.clone(),
            files: BASE
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
            workspace_id: workspace_id("repo", "build", 1, &digest).unwrap(),
            repo_id: "repo".into(),
            run_id: "run".into(),
            job_id: "build".into(),
            epoch: 1,
            execution_id: "build".into(),
            role: SourceRole::Builder,
            access: SourceAccess::ReadWrite,
            view_digest: digest.clone(),
            baseline_overrides_digest: yoneda_core::fingerprint(&json!([])).unwrap(),
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
        let source = grant(&binding, ActorPurpose::Source);
        let supervisor = grant(&binding, ActorPurpose::Supervisor);
        let temporary = tempfile::tempdir().unwrap();
        // Stand-in for R2: verified upload bytes keyed by sha256.
        let mut objects: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        let mut initialized = false;
        let server = Server::respond(move |request| {
            let db = NativeStore::open(&temporary.path().join("source.sqlite")).unwrap();
            let call = |mut args: Value, actor: &ActorGrant| {
                args["now"] = json!(1000);
                args["_source_signing_key"] = json!("aa".repeat(32));
                args["_actor"] = json!(actor);
                execute_source_workspace(&db, args)
            };
            if !initialized {
                call(
                    json!({"op":"source_init","request_id":"init","binding":binding,"view":view,"baseline_overrides":[]}),
                    &supervisor,
                )
                .unwrap();
                initialized = true;
            }
            let (head, body) = request.split_once("\r\n\r\n").unwrap();
            let target = head
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap();
            let (route, query) = target.split_once('?').unwrap_or((target, ""));
            let op = route.rsplit('/').next().unwrap();
            let result = if op == "blob" {
                upload(query, body.as_bytes(), &mut objects, |args, actor| {
                    call(args, if actor { &supervisor } else { &source })
                })
            } else {
                let mut args: Value = serde_json::from_str(body).unwrap();
                args["op"] = json!(op);
                call(args, &source)
            };
            match result {
                Ok(value) if op == "source_read" => {
                    let begin = value["offset"].as_u64().unwrap() as usize;
                    let end = begin + value["length"].as_u64().unwrap() as usize;
                    let bytes = content(&value["content"], &objects);
                    Response::raw(value, &bytes[begin..end])
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
/// Mirrors cloudflare/worker/source-upload.ts: reserve, store, verify, then return the
/// verified authority value with the private storage key removed.
fn upload(
    query: &str,
    bytes: &[u8],
    objects: &mut BTreeMap<String, Vec<u8>>,
    call: impl Fn(Value, bool) -> yoneda_core::Result<Value>,
) -> yoneda_core::Result<Value> {
    let mut args = json!({"op":"source_upload_ticket"});
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap();
        let value = decode(value);
        args[key] = if [
            "size",
            "expected_workspace_version",
            "expected_file_version",
        ]
        .contains(&key)
        {
            json!(value.parse::<u64>().unwrap())
        } else {
            json!(value)
        };
    }
    let issued = call(args, false)?;
    let ticket = &issued["ticket"];
    assert_eq!(ticket["sha256"], yoneda_core::digest(bytes));
    objects.insert(ticket["sha256"].as_str().unwrap().into(), bytes.to_vec());
    let mut verified = call(
        json!({"op":"source_verify_upload","request_id":format!("verify:{}", ticket["id"].as_str().unwrap()),
            "ticket_id":ticket["id"],"sha256":ticket["sha256"],"size":ticket["size"]}),
        true,
    )?;
    verified["ticket"].as_object_mut().unwrap().remove("key");
    Ok(verified)
}
fn content(reference: &Value, objects: &BTreeMap<String, Vec<u8>>) -> Vec<u8> {
    if reference["kind"] == "git" {
        let path = reference["path"].as_str().unwrap();
        return BASE.iter().find(|(p, _)| *p == path).unwrap().1.to_vec();
    }
    objects[reference["sha256"].as_str().unwrap()].clone()
}
fn decode(value: &str) -> String {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            out.push(u8::from_str_radix(&value[index + 1..index + 3], 16).unwrap());
            index += 3;
        } else {
            out.push(if bytes[index] == b'+' {
                b' '
            } else {
                bytes[index]
            });
            index += 1;
        }
    }
    String::from_utf8(out).unwrap()
}
fn grant(binding: &SourceBinding, purpose: ActorPurpose) -> ActorGrant {
    let claims = ActorClaims {
        version: 1,
        workspace_id: binding.workspace_id.clone(),
        binding_digest: binding.digest().unwrap(),
        repo_id: binding.repo_id.clone(),
        run_id: binding.run_id.clone(),
        job_id: binding.job_id.clone(),
        epoch: binding.epoch,
        execution_id: binding.execution_id.clone(),
        view_digest: binding.view_digest.clone(),
        role: binding.role,
        access: binding.access,
        purpose,
        expires_at: 200_000,
    };
    // Fixture-only HMAC over the documented native grant domain; no real keys.
    let mut inner = Sha256::new();
    let mut outer = Sha256::new();
    let mut key = [0_u8; 64];
    key[..32].fill(0xaa);
    inner.update(key.map(|b| b ^ 0x36));
    inner.update(b"yoneda:source-grant:v1\0");
    inner.update(yoneda_core::fingerprint(&json!(claims)).unwrap().as_bytes());
    outer.update(key.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    ActorGrant {
        signature: outer
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        claims,
    }
}
