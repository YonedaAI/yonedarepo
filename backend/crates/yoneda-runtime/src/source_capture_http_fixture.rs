//! Root capture HTTP adapter backed by actual native SQLite seals and native Git readback.
#[path = "source_capture_client_fixture.rs"]
mod client;
use crate::{
    source_capture_fixture::{Fixture, TOKEN},
    source_git_http_tests::{git, oid},
};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, Response},
    routing::post,
};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU8, Ordering},
};

pub(crate) struct Root {
    pub fixture: Arc<Fixture>,
    pub origin: String,
    pub requests: Arc<Mutex<Vec<(String, Value)>>>,
    pub fault: Arc<AtomicU8>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Root {
    fn drop(&mut self) {
        self.task.abort();
    }
}
#[derive(Clone)]
struct Service {
    fixture: Arc<Fixture>,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    fault: Arc<AtomicU8>,
}
fn json_response(value: Value) -> Response<Body> {
    Response::builder()
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}
async fn handle(
    State(state): State<Service>,
    Path(op): Path<String>,
    headers: HeaderMap,
    Json(args): Json<Value>,
) -> Response<Body> {
    if headers.get("authorization").and_then(|h| h.to_str().ok())
        != Some(&format!("Bearer {TOKEN}"))
    {
        return Response::builder().status(403).body(Body::empty()).unwrap();
    }
    state
        .requests
        .lock()
        .unwrap()
        .push((op.clone(), args.clone()));
    let f = &state.fixture;
    match op.as_str() {
        "context" => json_response(f.context()),
        "manifest" => {
            let section = if args["kind"] == "changes" {
                "changes"
            } else {
                "baseline_overrides"
            };
            let page = f.manifest(section, &args["cursor"]);
            json_response(
                json!({"items":page["items"],"next_cursor":page["next_cursor"],"changeset_digest":page["changeset_digest"]}),
            )
        }
        "tree" => {
            assert!(args.get("input").is_none() || args["input"] == "input-1");
            let (root, revision) = if args.get("input").is_none() {
                (&f.destination, &f.binding.base)
            } else {
                (&f.input, &f.binding.inputs[1])
            };
            let path = args["path"].as_str().unwrap();
            let tree = if path.is_empty() {
                revision.tree.clone()
            } else {
                oid(git(
                    root,
                    &["rev-parse", &format!("{}:{path}", revision.commit)],
                    b"",
                ))
            };
            let raw = git(root, &["ls-tree", "-z", &tree], b"");
            let mut rows = raw
                .split(|b| *b == 0)
                .filter(|r| !r.is_empty())
                .map(|r| {
                    let text = std::str::from_utf8(r).unwrap();
                    let (meta, name) = text.split_once('\t').unwrap();
                    let parts = meta.split(' ').collect::<Vec<_>>();
                    json!({"name":name,"mode":parts[0],"oid":parts[2]})
                })
                .collect::<Vec<_>>();
            rows.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            rows.retain(|r| r["name"].as_str().unwrap() > args["cursor"].as_str().unwrap_or(""));
            let more = rows.len() > 200;
            rows.truncate(200);
            if state.fault.load(Ordering::SeqCst) == 2 {
                rows[0]["oid"] = json!("f".repeat(40));
            }
            let next = if more {
                rows.last().unwrap()["name"].clone()
            } else {
                Value::Null
            };
            json_response(json!({"tree_oid":tree,"items":rows,"next_cursor":next}))
        }
        "blob" => blob(f, &args, state.fault.load(Ordering::SeqCst)),
        "verify" => {
            let commit = args["commit"].as_str().unwrap();
            let raw = git(&f.destination, &["cat-file", "commit", commit], b"");
            let text = String::from_utf8(raw).unwrap();
            let tree = text.lines().find_map(|l| l.strip_prefix("tree ")).unwrap();
            let parents = text
                .lines()
                .filter_map(|l| l.strip_prefix("parent "))
                .collect::<Vec<_>>();
            assert_eq!(json!(parents), json!(f.binding.parents));
            assert_eq!(tree, args["tree"].as_str().unwrap());
            let mut value = json!({"verified":true,"revision":{"repository":"candidate-fork","commit":commit},"tree":tree,"parents":parents});
            if state.fault.load(Ordering::SeqCst) == 3 {
                value["parents"] = json!(["f".repeat(40)]);
            }
            json_response(value)
        }
        _ => Response::builder().status(404).body(Body::empty()).unwrap(),
    }
}
fn blob(f: &Fixture, args: &Value, fault: u8) -> Response<Body> {
    let path = args["path"].as_str().unwrap();
    let before = args["kind"] == "before";
    let (bytes, mode) = if !before && f.bytes.contains_key(path) {
        (f.bytes[path].clone(), "100644")
    } else {
        let (root, commit, origin) = if path == "retained/overlay.bin" {
            (&f.input, &f.binding.inputs[1].commit, path)
        } else {
            (
                &f.destination,
                &f.binding.base.commit,
                if path == "renamed" { "base" } else { path },
            )
        };
        let bytes = git(root, &["show", &format!("{commit}:{origin}")], b"");
        (
            bytes,
            if !before && path == "mode" {
                "100755"
            } else {
                "100644"
            },
        )
    };
    let sha = yoneda_agents_core::digest(&bytes);
    let size = bytes.len();
    let offset = args["offset"].as_u64().unwrap() as usize;
    let length = (args["limit"].as_u64().unwrap() as usize).min(size - offset);
    assert!(length <= 65536);
    let range = if length == 0 {
        format!("bytes */{size}")
    } else {
        format!("bytes {offset}-{}/{size}", offset + length - 1)
    };
    let mut chunk = bytes[offset..offset + length].to_vec();
    if fault == 1 && path == "wide/changed.bin" && offset > 0 {
        chunk[0] ^= 1;
    }
    Response::builder()
        .status(if offset == 0 && length == size {
            200
        } else {
            206
        })
        .header("content-type", "application/octet-stream")
        .header("content-range", range)
        .header("x-yoneda-source-size", size.to_string())
        .header("x-yoneda-source-mode", mode)
        .header("x-source-sha256", sha)
        .body(Body::from(chunk))
        .unwrap()
}
pub(crate) async fn root(fixture: Fixture) -> Root {
    let fixture = Arc::new(fixture);
    let requests = Arc::new(Mutex::new(Vec::new()));
    let fault = Arc::new(AtomicU8::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let state = Service {
        fixture: fixture.clone(),
        requests: requests.clone(),
        fault: fault.clone(),
    };
    let public = Router::new()
        .route("/v1/repo/{op}", post(client::handle))
        .with_state(fixture.clone());
    let app = Router::new()
        .route("/v1/capture/{op}", post(handle))
        .with_state(state)
        .merge(public);
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Root {
        fixture,
        origin: format!("http://{address}"),
        requests,
        fault,
        task,
    }
}
