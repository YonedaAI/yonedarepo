#![allow(dead_code)]
#[path = "../src/source_client.rs"]
mod source_client;
#[path = "../src/source_workspace_job.rs"]
mod source_workspace_job;
#[path = "../src/source_workspace_registry.rs"]
mod source_workspace_registry;
use serde_json::json;
use source_workspace_registry::{InvalidationTarget, SourceInvalidation};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
#[tokio::test]
async fn root_auth_attempt_alias_and_closed_fields_precede_invalidation_ack() {
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    let target: InvalidationTarget = Arc::new(move |paths| {
        assert_eq!(paths, &["app.js".to_string()]);
        observed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    });
    let registration = source_workspace_registry::register(
        &json!({"id":"job","epoch":2}),
        BTreeMap::from([("repo".into(), target)]),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/source/invalidate",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(
        axum::serve(
            listener,
            source_workspace_registry::route("root-fixture".into()),
        )
        .into_future(),
    );
    use std::future::IntoFuture;
    let body = json!({"alias":"repo","paths":["app.js"],"job_id":"job","epoch":2});
    let client = reqwest::Client::new();
    assert_eq!(
        client.post(&url).json(&body).send().await.unwrap().status(),
        403
    );
    assert_eq!(count.load(Ordering::SeqCst), 0);
    let mut wrong = body.clone();
    wrong["epoch"] = json!(1);
    assert_eq!(
        client
            .post(&url)
            .bearer_auth("root-fixture")
            .json(&wrong)
            .send()
            .await
            .unwrap()
            .status(),
        409
    );
    wrong = body.clone();
    wrong["alias"] = json!("candidate-1");
    assert_eq!(
        client
            .post(&url)
            .bearer_auth("root-fixture")
            .json(&wrong)
            .send()
            .await
            .unwrap()
            .status(),
        409
    );
    wrong = body.clone();
    wrong["workspace_id"] = json!("caller-selected");
    assert_eq!(
        client
            .post(&url)
            .bearer_auth("root-fixture")
            .json(&wrong)
            .send()
            .await
            .unwrap()
            .status(),
        422
    );
    assert_eq!(count.load(Ordering::SeqCst), 0);
    let result = client
        .post(&url)
        .bearer_auth("root-fixture")
        .json(&body)
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({"invalidated":true,"alias":"repo","job_id":"job","epoch":2})
    );
    assert_eq!(count.load(Ordering::SeqCst), 1);
    drop(registration);
    assert!(
        source_workspace_registry::invalidate(SourceInvalidation {
            alias: "repo".into(),
            paths: vec!["app.js".into()],
            job_id: "job".into(),
            epoch: 2
        })
        .is_err()
    );
    server.abort();
}
