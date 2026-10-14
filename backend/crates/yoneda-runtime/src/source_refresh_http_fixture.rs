//! Exact root refresh HTTP over real native Git objects; fixture adapter, not workerd/Artifacts.
use crate::{
    source_git_http_tests::{Server, git, oid, server},
    source_refresh_tests::tree,
};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, Response},
    routing::post,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
};
pub(crate) const TOKEN: &str = "local-refresh-test-only";
pub(crate) struct Fixture {
    pub git: Server,
    pub base: String,
    pub head: String,
    pub candidate: String,
    pub work: PathBuf,
    pub origin: String,
    pub calls: Arc<Mutex<Vec<(String, Value)>>>,
    pub fault: Arc<AtomicU8>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
#[derive(Clone)]
struct Service {
    root: PathBuf,
    context: Value,
    paths: Vec<String>,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    fault: Arc<AtomicU8>,
}
fn response(value: Value) -> Response<Body> {
    Response::builder()
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}
async fn handle(
    State(s): State<Service>,
    Path(op): Path<String>,
    headers: HeaderMap,
    Json(args): Json<Value>,
) -> Response<Body> {
    assert_eq!(
        headers.get("authorization").unwrap().to_str().unwrap(),
        format!("Bearer {TOKEN}")
    );
    s.calls.lock().unwrap().push((op.clone(), args.clone()));
    let input = args["input"].as_str().unwrap_or("head");
    let repo = if input == "candidate" {
        s.root.join("candidate.git")
    } else {
        s.root.join("fork.git")
    };
    let commit = s.context[input]["commit"].as_str().unwrap().to_owned();
    match op.as_str() {
        "context" => response(s.context.clone()),
        "paths" => {
            let reference = &s.context["declaredPathsRef"];
            assert_eq!(args["expectedDigest"], reference["digest"]);
            let rest = s
                .paths
                .iter()
                .filter(|p| p.as_str() > args["after"].as_str().unwrap_or(""))
                .collect::<Vec<_>>();
            let more = rest.len() > 1;
            let items = rest.into_iter().take(1).collect::<Vec<_>>();
            let mut page = json!({"version":1,"items":items,"next_cursor":if more{items.last().copied()}else{None},"has_more":more,"total":reference["count"],"digest":reference["digest"],"paths_ref":reference});
            if s.fault.load(Ordering::SeqCst) == 1 {
                page["digest"] = json!("f".repeat(64));
            }
            response(page)
        }
        "tree" => {
            let path = args["path"].as_str().unwrap();
            let tree = if path.is_empty() {
                s.context[input]["tree"].as_str().unwrap().into()
            } else {
                oid(git(&repo, &["rev-parse", &format!("{commit}:{path}")], b""))
            };
            let raw = git(&repo, &["ls-tree", "-z", &tree], b"");
            let mut items = raw
                .split(|b| *b == 0)
                .filter(|r| !r.is_empty())
                .map(|r| {
                    let text = std::str::from_utf8(r).unwrap();
                    let (m, name) = text.split_once('\t').unwrap();
                    let p = m.split(' ').collect::<Vec<_>>();
                    json!({"name":name,"mode":p[0],"oid":p[2]})
                })
                .collect::<Vec<_>>();
            items.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            items.retain(|r| r["name"].as_str().unwrap() > args["cursor"].as_str().unwrap_or(""));
            let more = items.len() > 200;
            items.truncate(200);
            let next = if more {
                items.last().unwrap()["name"].clone()
            } else {
                Value::Null
            };
            response(json!({"tree_oid":tree,"items":items,"next_cursor":next}))
        }
        "blob" => {
            let path = args["path"].as_str().unwrap();
            assert!(s.paths.iter().any(|p| p == path));
            let bytes = git(&repo, &["show", &format!("{commit}:{path}")], b"");
            let files = tree(&repo, &commit);
            let mode = if files[path].mode == 0o100755 {
                "100755"
            } else {
                "100644"
            };
            let offset = args["offset"].as_u64().unwrap() as usize;
            let size = bytes.len();
            let n = (args["limit"].as_u64().unwrap() as usize).min(size - offset);
            let range = if n == 0 {
                format!("bytes */{size}")
            } else {
                format!("bytes {offset}-{}/{size}", offset + n - 1)
            };
            Response::builder()
                .header("content-type", "application/octet-stream")
                .header("content-range", range)
                .header("x-yoneda-source-size", size.to_string())
                .header("x-yoneda-source-mode", mode)
                .body(Body::from(bytes[offset..offset + n].to_vec()))
                .unwrap()
        }
        "verify_input" | "verify" => {
            let dest = s.root.join("fork.git");
            let revision = if op == "verify_input" {
                s.context["candidate"]["commit"].as_str().unwrap()
            } else {
                args["commit"].as_str().unwrap()
            };
            let raw =
                String::from_utf8(git(&dest, &["cat-file", "commit", revision], b"")).unwrap();
            let tree = raw.lines().find_map(|l| l.strip_prefix("tree ")).unwrap();
            let parents = raw
                .lines()
                .filter_map(|l| l.strip_prefix("parent "))
                .collect::<Vec<_>>();
            let reference = if op == "verify_input" {
                format!(
                    "refs/yoneda/source-input/{}",
                    yoneda_core::digest(b"refresh-job")
                )
            } else {
                "refs/heads/main".into()
            };
            assert_eq!(oid(git(&dest, &["rev-parse", &reference], b"")), revision);
            let mut result = json!({"verified":true,"revision":{"repository":"candidate-fork","commit":revision},"tree":tree,"parents":parents});
            if s.fault.load(Ordering::SeqCst) == 2 && op == "verify_input" {
                result["tree"] = json!("f".repeat(40));
            }
            response(result)
        }
        _ => panic!("unexpected root fixture op"),
    }
}
fn commit(work: &std::path::Path, message: &str) -> String {
    git(work, &["add", "."], b"");
    git(
        work,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@invalid",
            "commit",
            "-m",
            message,
        ],
        b"",
    );
    oid(git(work, &["rev-parse", "HEAD"], b""))
}
pub(crate) async fn fixture(conflict: bool) -> Fixture {
    let (server, _, _) = server().await;
    let root = server.root.path();
    let work = root.join("work");
    let dest = root.join("fork.git");
    git(
        root,
        &["clone", dest.to_str().unwrap(), work.to_str().unwrap()],
        b"",
    );
    git(&work, &["checkout", "main"], b"");
    std::fs::write(
        work.join("text"),
        b"one\ntwo\nthree\nfour\nfive\nsix\nseven\n",
    )
    .unwrap();
    std::fs::write(work.join("binary"), b"base\0").unwrap();
    std::fs::create_dir(work.join("shape")).unwrap();
    std::fs::write(work.join("shape/file"), b"base shape\n").unwrap();
    std::fs::create_dir(work.join("wide")).unwrap();
    for i in 0..450 {
        std::fs::write(work.join(format!("wide/unread-{i:04}")), b"unread source\n").unwrap();
    }
    let base = commit(&work, "base");
    std::fs::write(work.join("head-only"), b"head kept\n").unwrap();
    std::fs::write(
        work.join("text"),
        b"HEAD\ntwo\nthree\nfour\nfive\nsix\nseven\n",
    )
    .unwrap();
    if conflict {
        std::fs::write(work.join("binary"), b"head\0").unwrap();
        std::fs::write(work.join("shape/file"), b"head shape\n").unwrap();
    }
    let head = commit(&work, "head");
    git(&work, &["push", "origin", "HEAD:refs/heads/main"], b"");
    git(&work, &["checkout", "--detach", &base], b"");
    std::fs::write(work.join("candidate-only"), b"candidate kept\n").unwrap();
    std::fs::write(
        work.join("text"),
        b"one\ntwo\nthree\nfour\nfive\nsix\nCANDIDATE\n",
    )
    .unwrap();
    if conflict {
        std::fs::write(work.join("binary"), b"candidate\0").unwrap();
        std::fs::remove_dir_all(work.join("shape")).unwrap();
        std::fs::write(work.join("shape"), b"candidate shape\n").unwrap();
    }
    let candidate = commit(&work, "candidate");
    let source = root.join("candidate.git");
    git(root, &["init", "--bare", source.to_str().unwrap()], b"");
    git(
        &work,
        &["push", source.to_str().unwrap(), "HEAD:refs/heads/main"],
        b"",
    );
    let paths = if conflict {
        vec!["binary", "candidate-only", "shape", "shape/file", "text"]
    } else {
        vec!["candidate-only", "text"]
    }
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    let digest = yoneda_core::fingerprint(&json!(paths)).unwrap();
    let revision = |repository: &str, commit: &str, repo: &std::path::Path| json!({"repository":repository,"commit":commit,"tree":oid(git(repo,&["rev-parse",&format!("{commit}^{{tree}}")],b""))});
    let context = json!({"version":1,"base":revision("canonical",&base,&dest),"head":revision("canonical",&head,&dest),"candidate":revision("candidate-source",&candidate,&source),"candidateParents":[base],"declaredPathsRef":{"version":1,"id":format!("paths:{digest}"),"digest":digest,"count":paths.len()},"targetVersion":7,"source_capture_ref":{"branch":"main","expected_head":head}});
    let calls = Arc::new(Mutex::new(Vec::new()));
    let fault = Arc::new(AtomicU8::new(0));
    let state = Service {
        root: root.into(),
        context,
        paths,
        calls: calls.clone(),
        fault: fault.clone(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/refresh/{op}", post(handle))
        .with_state(state);
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Fixture {
        git: server,
        base,
        head,
        candidate,
        work,
        origin: format!("http://{address}"),
        calls,
        fault,
        task,
    }
}
impl Fixture {
    pub fn job(&self) -> Value {
        json!({"kind":"capture","id":"refresh-job","epoch":1,"fork":"candidate-fork","payload":{"capture_subtype":"refresh_candidate","workspace_transport":"api-source-v1","expected_base":self.base,"expected_head":self.head,"candidate":{"revision":{"commit":self.candidate}}}})
    }
}
