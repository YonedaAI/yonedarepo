//! Regional Workers share classes exported by the primary Worker. Existing bound regions
//! can be upgraded primary-first; a new region must first be deployed without back-bindings.
use crate::infra::live::Client;
use crate::infra::spec::{Env, Spec};
use crate::process::Result;
use std::time::Duration;

fn targets(spec: &Spec) -> Vec<String> {
    spec.cells
        .iter()
        .filter(|cell| cell.bound)
        .map(|cell| format!("{}-platform-{}", spec.prefix, cell.code))
        .collect()
}

/// Before any migration/deploy, refuse an unverified circular service-binding bootstrap.
/// Unbound stacks and frontend-only/dry runs need no additional remote reads.
pub(crate) async fn verify(env: &Env, spec: &Spec) -> Result<()> {
    let required = targets(spec);
    if required.is_empty() {
        return Ok(());
    }
    crate::deploy_credentials::load(&env.name(), &spec.account_id)?;
    let token = crate::deploy_credentials::current()
        .ok_or("Verifying bound regions needs a Cloudflare API token with Workers Scripts Read")?;
    let client = Client::new(token);
    for target in required {
        let path = format!(
            "/accounts/{}/workers/scripts/{target}/settings",
            spec.account_id
        );
        tokio::time::timeout(Duration::from_secs(15), client.get(&path))
            .await
            .map_err(|_| format!("Timed out verifying bound region {target}; deployment has not started"))?
            .map_err(|error| {
                format!(
                    "Cannot verify existing bound region {target}: {error}. New regional Workers must first be deployed with cells[].bound=false; enable the binding after that deploy succeeds."
                )
            })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

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
