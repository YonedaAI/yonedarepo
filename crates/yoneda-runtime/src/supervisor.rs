use crate::{broker::broker, err, jobs::execute_job};
use serde_json::{Value, json};
use std::time::Duration;
use yoneda_core::Result;
pub(crate) fn health() -> Value {
    json!({"protocol":2,"environment":yoneda_core::Policy::default().environment,"environments":[yoneda_core::Policy::default().environment,yoneda_core::build::ENVIRONMENT],"suites":["retry-contract-v1","retry-contract-v2","commands-v1"]})
}
pub async fn serve() -> Result<()> {
    #[cfg(target_os = "linux")]
    if unsafe { libc::geteuid() } != 0 {
        return Err(err("Container supervisor must own the isolated agent UID"));
    }
    use axum::{
        Json, Router,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::{get, post},
    };
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let started = Arc::new(AtomicBool::new(false));
    let app=Router::new().route("/health",get(||async {Json(health())})).route("/job",post(move |headers:HeaderMap,Json(job):Json<Value>| {
        let started=started.clone();async move {
            let secret=std::env::var("SUPERVISOR_TOKEN").unwrap_or_default();
            if secret.is_empty() || headers.get("authorization").and_then(|v|v.to_str().ok())!=Some(format!("Bearer {secret}").as_str()) {return (StatusCode::FORBIDDEN,Json(json!({"error":"forbidden"}))).into_response();}
            if !started.swap(true,Ordering::SeqCst) {
                tokio::spawn(async move {
                    let heartbeat=tokio::spawn(async {
                        loop {tokio::time::sleep(Duration::from_secs(20)).await;
                            if broker("/heartbeat",json!({}),true).await.is_err() {std::process::exit(2);}
                        }
                    });
                    let result=tokio::time::timeout(Duration::from_secs(if job["kind"]=="evaluate" {110}else{570}),execute_job(&job)).await;
                    let report=match result {Ok(Ok(value))=>broker("/complete",value,true).await,Ok(Err(error))=>broker("/failed",json!({"error":error.to_string(),"retryable":job["kind"]!="agent"}),true).await,Err(_)=>broker("/failed",json!({"error":"Execution deadline exceeded","retryable":false}),true).await};
                    heartbeat.abort();if let Err(e)=report {eprintln!("Callback failed: {e}");}
                });
            }
            (StatusCode::ACCEPTED,Json(json!({"status":"started"}))).into_response()
        }
    })).layer(axum::extract::DefaultBodyLimit::max(1024*1024));
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080")
        .await
        .map_err(err)?;
    axum::serve(listener, app).await.map_err(err)
}
