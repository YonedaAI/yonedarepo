//! Root capture HTTP adapter backed by actual native SQLite seals and native Git readback.
#[path = "source_capture_client_fixture.rs"]
mod client;
use crate::{
    source_capture_fixture::{Fixture, TOKEN},
    source_git_fixture::{git, oid},
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
        "commit" => json_response(commit(f, &args, state.fault.load(Ordering::SeqCst))),
        _ => Response::builder().status(404).body(Body::empty()).unwrap(),
    }
}
/// Plays the platform commit: apply the changes to the base tree, record a two-parent-aware
/// commit and move the assigned branch, reusing it when the same capture is retried.
fn commit(f: &Fixture, args: &Value, fault: u8) -> Value {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let index = f.destination.join("capture.index");
    let work = f.destination.with_extension("work");
    std::fs::create_dir_all(&work).unwrap();
    let indexed = |args: &[&str], bytes: &[u8]| {
        let mut child = std::process::Command::new("/usr/bin/git")
            .current_dir(&f.destination)
            .env("GIT_INDEX_FILE", &index)
            .env("GIT_WORK_TREE", &work)
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(&mut child.stdin.take().unwrap(), bytes).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        oid(output.stdout)
    };
    let _ = std::fs::remove_file(&index);
    indexed(&["read-tree", &f.binding.base.tree], b"");
    for change in args["changes"].as_array().unwrap() {
        let path = change["path"].as_str().unwrap();
        if change["delete"] == true {
            indexed(&["update-index", "--force-remove", "--", path], b"");
            continue;
        }
        let bytes = STANDARD
            .decode(change["content_b64"].as_str().unwrap())
            .unwrap();
        let blob = oid(git(
            &f.destination,
            &["hash-object", "-w", "--stdin"],
            &bytes,
        ));
        let mode = if change["type"] == "exec" {
            "100755"
        } else {
            "100644"
        };
        indexed(
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("{mode},{blob},{path}"),
            ],
            b"",
        );
    }
    let tree = indexed(&["write-tree"], b"");
    let mut command = vec!["commit-tree", tree.as_str(), "-m", "capture"];
    let parents: Vec<String> = args["parents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap().to_owned())
        .collect();
    for parent in &parents {
        command.extend(["-p", parent.as_str()]);
    }
    let made = oid(git(&f.destination, &command, b""));
    git(
        &f.destination,
        &["update-ref", "refs/heads/main", &made],
        b"",
    );
    let mut value = json!({"verified":true,"revision":{"repository":f.binding.base.repository,"commit":made},"tree":tree,"parents":parents});
    if fault == 3 {
        value["parents"] = json!(["f".repeat(40)]);
    }
    value
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
