use super::*;
use axum::{Json, Router, extract::Path, routing::post};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

type Calls = Arc<Mutex<BTreeMap<String, usize>>>;

/// A frozen read-only view at workspace version 3, counting each source operation.
async fn server() -> (String, Calls) {
    let calls: Calls = Arc::default();
    let counter = calls.clone();
    let app = Router::new().route(
        "/v1/repo/{op}",
        post(move |Path(op): Path<String>| {
            let counter = counter.clone();
            async move {
                *counter.lock().unwrap().entry(op.clone()).or_default() += 1;
                Json(match op.as_str() {
                    "source_status" => json!({"version":1,"capabilities":{"source_api":1},
                        "transport":"api-source-v1","workspace_id":"ws","view_digest":"view",
                        "authority":"staged_source","checked":false,"published":false,
                        "access":"read_only","status":"open","workspace_version":3}),
                    _ => json!({"workspace_id":"ws","workspace_version":3,"next_cursor":null,
                        "items":[{"path":"a.txt","kind":"file","exists":true,"mode":"100644",
                        "size":1,"file_version":1}]}),
                })
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (origin, calls)
}

/// Setup used to send one source_status per FUSE getattr/readdir (~1 s each from a far colo),
/// which outlived the attempt lease. Reads now reuse a recent status.
#[tokio::test]
async fn root_stats_and_listings_do_not_refetch_status_per_operation() {
    let (origin, calls) = server().await;
    let nodes = tokio::task::spawn_blocking(move || {
        let client = ApiSourceClient::test_at(&origin, "repo", "ws", "view", true).unwrap();
        for _ in 0..10 {
            assert_eq!(client.stat("").unwrap().version, 3);
        }
        (0..3)
            .map(|_| client.list("").unwrap().len())
            .sum::<usize>()
    })
    .await
    .unwrap();
    assert_eq!(nodes, 3);
    let calls = calls.lock().unwrap();
    assert_eq!(calls["source_list"], 3);
    assert!(
        calls["source_status"] <= 2,
        "status calls: {}",
        calls["source_status"]
    );
}
