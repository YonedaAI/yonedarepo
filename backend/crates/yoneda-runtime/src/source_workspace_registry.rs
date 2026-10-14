//! Root supervisor registry. Authentication and the active attempt precede kernel invalidation.
use crate::source_client::{failure, validate_path};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};
use yoneda_core::Result;

pub type InvalidationTarget = Arc<dyn Fn(&[String]) -> Result<()> + Send + Sync>;
struct Active {
    generation: u64,
    job_id: String,
    epoch: u64,
    targets: BTreeMap<String, InvalidationTarget>,
}
fn registry() -> &'static Mutex<Option<Active>> {
    static REGISTRY: OnceLock<Mutex<Option<Active>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(None))
}
pub struct SourceRegistration(u64);
pub fn register(
    job: &Value,
    targets: BTreeMap<String, InvalidationTarget>,
) -> Result<SourceRegistration> {
    let job_id = job["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .ok_or_else(|| failure("SOURCE_SCOPE", "Source attempt identity missing"))?
        .to_string();
    let epoch = job["epoch"]
        .as_u64()
        .filter(|epoch| *epoch > 0 && *epoch <= 9_007_199_254_740_991)
        .ok_or_else(|| failure("SOURCE_SCOPE", "Source epoch missing"))?;
    if (targets.is_empty()
        && !crate::source_workspace_job::mounts(job).is_ok_and(|mounts| mounts.is_empty()))
        || targets.len() > 3
        || targets
            .keys()
            .any(|alias| !["repo", "candidate-0", "candidate-1"].contains(&alias.as_str()))
    {
        return Err(failure("SOURCE_SCOPE", "Invalid source registry mounts"));
    }
    let mut current = registry()
        .lock()
        .map_err(|_| failure("SOURCE_LOCK", "Source registry lock failed"))?;
    if current.is_some() {
        return Err(failure(
            "SOURCE_SCOPE",
            "A source session is already active",
        ));
    }
    static GENERATION: AtomicU64 = AtomicU64::new(1);
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed);
    *current = Some(Active {
        generation,
        job_id,
        epoch,
        targets,
    });
    Ok(SourceRegistration(generation))
}
impl Drop for SourceRegistration {
    fn drop(&mut self) {
        if let Ok(mut current) = registry().lock()
            && current
                .as_ref()
                .is_some_and(|active| active.generation == self.0)
        {
            *current = None;
        }
    }
}
pub fn active() -> bool {
    registry().lock().is_ok_and(|current| current.is_some())
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceInvalidation {
    pub alias: String,
    pub paths: Vec<String>,
    pub job_id: String,
    pub epoch: u64,
}
pub fn invalidate(input: SourceInvalidation) -> Result<Value> {
    if input.paths.is_empty() || input.paths.len() > 256 {
        return Err(failure("SOURCE_SCOPE", "Invalid source invalidation paths"));
    }
    for path in &input.paths {
        validate_path(path, false)?;
    }
    let target = {
        let current = registry()
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Source registry lock failed"))?;
        let current = current
            .as_ref()
            .ok_or_else(|| failure("SOURCE_SCOPE", "Source session is not active"))?;
        if current.job_id != input.job_id || current.epoch != input.epoch {
            return Err(failure("SOURCE_SCOPE", "Source attempt has changed"));
        }
        current
            .targets
            .get(&input.alias)
            .cloned()
            .ok_or_else(|| failure("SOURCE_SCOPE", "Source mount is not active"))?
    };
    // No registry, mutation or cache lock is held while the kernel notifier completes.
    // Worker skips this callback ONLY for authenticated root FUSE requests; otherwise
    // an active FUSE write could wait on its own HTTP acknowledgement indefinitely.
    target(&input.paths)?;
    Ok(json!({"invalidated":true,"alias":input.alias,"job_id":input.job_id,"epoch":input.epoch}))
}
pub(crate) fn route(secret: String) -> axum::Router {
    use axum::{
        Json, Router,
        http::{HeaderMap, StatusCode},
        routing::post,
    };
    Router::new().route("/source/invalidate",post(move|headers:HeaderMap,Json(input):Json<SourceInvalidation>|{
        let secret=secret.clone();async move {
            if secret.is_empty()||headers.get("authorization").and_then(|value|value.to_str().ok())!=Some(format!("Bearer {secret}").as_str()) {
                return (StatusCode::FORBIDDEN,Json(json!({"error":{"code":"FORBIDDEN","message":"Root supervisor required"}})));
            }
            match tokio::task::spawn_blocking(move||invalidate(input)).await {
                Ok(Ok(value))=>(StatusCode::OK,Json(value)),
                _=>(StatusCode::CONFLICT,Json(json!({"error":{"code":"SOURCE_SCOPE","message":"Source invalidation was not acknowledged"}}))),
            }
        }
    })).layer(axum::extract::DefaultBodyLimit::max(16*1024))
}
