//! Regional Workers share classes exported by the primary Worker. Existing bound regions
//! can be upgraded primary-first; a new region must first be deployed without back-bindings.
use crate::deploy_secret_preflight::Inventory;
use crate::infra::live::Client;
use crate::infra::spec::{Env, Spec};
use crate::process::Result;
use serde_json::Value;
use std::collections::BTreeSet;
use std::time::Duration;

fn targets(spec: &Spec) -> Vec<String> {
    spec.cells
        .iter()
        .filter(|cell| cell.bound)
        .map(|cell| format!("{}-platform-{}", spec.prefix, cell.code))
        .chain(
            spec.api_regions
                .iter()
                .map(|region| format!("{}-api-{}", spec.prefix, region.code)),
        )
        .collect()
}

/// Only the documented Worker-not-found response may start bootstrap. Unknown,
/// malformed, permission, timeout and transient errors stop before any mutation.
fn present(status: reqwest::StatusCode, body: &Value) -> Result<bool> {
    if status.is_success() && body["success"] == true && body["result"].is_object() {
        return Ok(true);
    }
    let missing = status == reqwest::StatusCode::NOT_FOUND
        && body["success"] == false
        && body["errors"]
            .as_array()
            .is_some_and(|errors| !errors.is_empty() && errors.iter().all(|e| e["code"] == 10007));
    if missing {
        return Ok(false);
    }
    Err(format!(
        "Cannot verify regional Worker settings: HTTP {status}; bootstrap was not authorized"
    )
    .into())
}

/// Name inventory and proven missing targets, before any rollout or migration.
pub(crate) async fn inventory(env: &Env, spec: &Spec) -> Result<Inventory> {
    let mut required = targets(spec);
    let mut inventory = Inventory::default();
    if required.is_empty() {
        return Ok(inventory);
    }
    let primary = format!("{}-platform", spec.prefix);
    required.insert(0, primary.clone());
    crate::deploy_credentials::load(&env.name(), &spec.account_id)?;
    let token = crate::deploy_credentials::current()
        .ok_or("Verifying bound regions needs a Cloudflare API token with Workers Scripts Read")?;
    let client = Client::new(token);
    for target in required {
        let path = format!(
            "/accounts/{}/workers/scripts/{target}/settings",
            spec.account_id
        );
        let (status, body) =
            tokio::time::timeout(Duration::from_secs(15), client.get_status(&path))
                .await
                .map_err(
                    |_| "Timed out checking regional credentials; deployment has not started",
                )??;
        match secret_names(status, &body)? {
            Some(names) => {
                inventory.secrets.insert(target, names);
            }
            None => {
                if target != primary {
                    inventory.missing.insert(target.clone());
                }
                inventory.secrets.insert(target, BTreeSet::new());
            }
        }
    }
    Ok(inventory)
}

/// Only names are retained; plaintext values and binding contents never reach a report.
fn secret_names(status: reqwest::StatusCode, body: &Value) -> Result<Option<BTreeSet<String>>> {
    if !present(status, body)? {
        return Ok(None);
    }
    let bindings = body["result"]["bindings"]
        .as_array()
        .ok_or("Malformed Worker binding inventory; deployment has not started")?;
    let mut names = BTreeSet::new();
    for binding in bindings {
        let kind = binding["type"]
            .as_str()
            .ok_or("Malformed Worker binding type; deployment has not started")?;
        if kind == "secret_text" {
            let name = binding["name"]
                .as_str()
                .filter(|name| !name.is_empty())
                .ok_or("Malformed secret-name inventory; deployment has not started")?;
            names.insert(name.to_owned());
        }
    }
    Ok(Some(names))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn worker_presence_fails_closed_except_explicit_script_absence() {
        use reqwest::StatusCode;
        assert!(
            present(
                StatusCode::OK,
                &json!({"success":true,"result":{"bindings":[]}})
            )
            .unwrap()
        );
        assert!(
            !present(
                StatusCode::NOT_FOUND,
                &json!({"success":false,"errors":[{"code":10007}]})
            )
            .unwrap()
        );
        for (status, body) in [
            (StatusCode::FORBIDDEN, json!({"errors":[{"code":10007}]})),
            (StatusCode::NOT_FOUND, json!({"errors":[{"code":10000}]})),
            (StatusCode::SERVICE_UNAVAILABLE, Value::Null),
            (StatusCode::OK, json!({"success":true,"result":null})),
        ] {
            assert!(present(status, &body).is_err());
        }
    }

    #[test]
    fn name_inventory_refuses_malformed_success_and_retains_no_values() {
        use reqwest::StatusCode;
        let names = secret_names(
            StatusCode::OK,
            &json!({"success":true,"result":{"bindings":[
                {"type":"secret_text","name":"OWNER_TOKEN","text":"NEVER_KEEP_THIS"},
                {"type":"plain_text","name":"FEATURE","text":"on"},
                {"type":"secrets_store_secret","name":"MODEL_KEY"}
            ]}}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(names, BTreeSet::from(["OWNER_TOKEN".to_owned()]));
        assert!(
            secret_names(
                StatusCode::NOT_FOUND,
                &json!({"success":false,"errors":[{"code":10007}]})
            )
            .unwrap()
            .is_none()
        );
        for bindings in [
            Value::Null,
            json!({}),
            json!([{"name":"OWNER_TOKEN"}]),
            json!([{"type":"secret_text"}]),
        ] {
            assert!(
                secret_names(
                    StatusCode::OK,
                    &json!({"success":true,"result":{"bindings":bindings}})
                )
                .is_err()
            );
        }
    }

    #[test]
    fn only_bound_regions_require_existing_targets() {
        let text = include_str!("../../infra/envs/dev.json");
        let mut value: Value = serde_json::from_str(text).unwrap();
        value["api_regions"] = json!([]);
        value["cells"][0]["bound"] = json!(false);
        let unbound = Spec::parse(&value.to_string()).unwrap();
        assert!(targets(&unbound).is_empty());
        value["cells"][0]["bound"] = json!(true);
        let bound = Spec::parse(&value.to_string()).unwrap();
        assert_eq!(targets(&bound), ["yonedarepo-dev-platform-weur"]);
    }
}

#[cfg(test)]
mod api_target_tests {
    use super::*;
    #[test]
    fn every_api_alias_is_checked_before_any_remote_mutation() {
        let spec = Spec::parse(include_str!("../../infra/envs/dev.json")).unwrap();
        let names = targets(&spec);
        for code in ["enam", "weur", "apac", "oc", "sam", "afr"] {
            assert!(names.contains(&format!("yonedarepo-dev-api-{code}")));
        }
        assert!(names.contains(&"yonedarepo-dev-platform-weur".into()));
        assert_eq!(names.len(), 7);
    }
}
