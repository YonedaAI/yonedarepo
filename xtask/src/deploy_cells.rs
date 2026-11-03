//! Regional Workers share classes exported by the primary Worker. Existing bound regions
//! can be upgraded primary-first; a new region must first be deployed without back-bindings.
use crate::infra::live::Client;
use crate::infra::spec::{Env, Spec};
use crate::process::Result;
use std::time::Duration;
use std::collections::BTreeSet;
use serde_json::Value;

fn targets(spec: &Spec) -> Vec<String> {
    spec.cells
        .iter()
        .filter(|cell| cell.bound)
        .map(|cell| format!("{}-platform-{}", spec.prefix, cell.code))
        .collect()
}

/// Only the documented Worker-not-found response may start bootstrap. Unknown,
/// malformed, permission, timeout and transient errors stop before any mutation.
fn present(status: reqwest::StatusCode, body: &Value) -> Result<bool> {
    if status.is_success() && body["success"] == true && body["result"].is_object() {return Ok(true);}
    let missing = status == reqwest::StatusCode::NOT_FOUND
        && body["errors"].as_array().is_some_and(|errors| !errors.is_empty() && errors.iter().all(|e|e["code"]==10007));
    if missing {return Ok(false);}
    Err(format!("Cannot verify regional Worker settings: HTTP {status}; bootstrap was not authorized").into())
}

/// Before any migration/deploy, identify only genuinely absent bound targets.
/// Front-only and offline dry runs skip this read in deploy_env.
pub(crate) async fn missing(env: &Env, spec: &Spec) -> Result<BTreeSet<String>> {
    let required = targets(spec);
    let mut missing = BTreeSet::new();
    if required.is_empty() {return Ok(missing);}
    crate::deploy_credentials::load(&env.name(), &spec.account_id)?;
    let token=crate::deploy_credentials::current().ok_or("Verifying bound regions needs a Cloudflare API token with Workers Scripts Read")?;
    let client=Client::new(token);
    for target in required {
        let path=format!("/accounts/{}/workers/scripts/{target}/settings",spec.account_id);
        let (status,body)=tokio::time::timeout(Duration::from_secs(15),client.get_status(&path)).await
            .map_err(|_|format!("Timed out verifying region {target}; deployment has not started"))??;
        if !present(status,&body)? {missing.insert(target);}
    }
    Ok(missing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn worker_presence_fails_closed_except_explicit_script_absence() {
        use reqwest::StatusCode;
        assert!(present(StatusCode::OK,&json!({"success":true,"result":{"bindings":[]}})).unwrap());
        assert!(!present(StatusCode::NOT_FOUND,&json!({"success":false,"errors":[{"code":10007}]})).unwrap());
        for (status,body) in [(StatusCode::FORBIDDEN,json!({"errors":[{"code":10007}]})),(StatusCode::NOT_FOUND,json!({"errors":[{"code":10000}]})),(StatusCode::SERVICE_UNAVAILABLE,Value::Null),(StatusCode::OK,json!({"success":true,"result":null}))] {
            assert!(present(status,&body).is_err());
        }
    }

    #[test]
    fn only_bound_regions_require_existing_targets() {
        let text = include_str!("../../infra/envs/dev.json");
        let mut value: Value = serde_json::from_str(text).unwrap();
        value["cells"][0]["bound"] = json!(false);
        let unbound = Spec::parse(&value.to_string()).unwrap();
        assert!(targets(&unbound).is_empty());
        value["cells"][0]["bound"] = json!(true);
        let bound = Spec::parse(&value.to_string()).unwrap();
        assert_eq!(targets(&bound), ["yonedarepo-dev-platform-weur"]);
    }
}
