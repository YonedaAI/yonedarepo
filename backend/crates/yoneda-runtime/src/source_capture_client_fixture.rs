//! Ordinary SourceClient HTTP projected directly from native staged SQLite authority.
use crate::{source_capture_fixture::Fixture, source_git_http_tests::git};
use axum::{
    Json,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, Response},
};
use serde_json::{Value, json};
use std::sync::Arc;
pub(super) async fn handle(
    State(f): State<Arc<Fixture>>,
    Path(op): Path<String>,
    headers: HeaderMap,
    Json(mut args): Json<Value>,
) -> Response<Body> {
    assert!(
        !headers.contains_key("authorization") && !headers.contains_key("cookie"),
        "ordinary source client holds no bearer"
    );
    args["op"] = json!(op);
    let value = match f.call_as(args, "source") {
        Ok(v) => v,
        Err(e) => {
            return Response::builder()
                .status(409)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"error":{"code":e.code,"message":e.message}}).to_string(),
                ))
                .unwrap();
        }
    };
    if op != "source_read" {
        return Response::builder()
            .header("content-type", "application/json")
            .body(Body::from(value.to_string()))
            .unwrap();
    }
    let content = &value["content"];
    let bytes = if content["kind"] == "r2" {
        f.bytes[value["file"]["path"].as_str().unwrap()].clone()
    } else {
        let root = if content["repository"] == f.binding.base.repository {
            &f.destination
        } else {
            &f.input
        };
        git(
            root,
            &["cat-file", "blob", content["blob"].as_str().unwrap()],
            b"",
        )
    };
    let offset = value["offset"].as_u64().unwrap() as usize;
    let length = value["length"].as_u64().unwrap() as usize;
    let encoded = value
        .to_string()
        .bytes()
        .map(|b| format!("%{b:02X}"))
        .collect::<String>();
    Response::builder()
        .header("content-type", "application/octet-stream")
        .header("x-yoneda-source", encoded)
        .body(Body::from(bytes[offset..offset + length].to_vec()))
        .unwrap()
}
