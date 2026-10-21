//! The Secrets step of a spec-driven deploy (split from deploy_env to keep it small).
use crate::infra::inventory::Deployable;
use crate::infra::spec::Spec;
use crate::infra::wrangler;
use crate::process::Result;
use serde_json::Value;
use std::collections::BTreeSet;

/// Uploads only the declared secrets the Worker lacks; existing values are never rotated.
pub(crate) fn ensure(spec: &Spec, worker: &Deployable) -> Result<()> {
    let listing = wrangler::output(
        &spec.account_id,
        &[
            "secret",
            "list",
            "--format",
            "json",
            "--config",
            &worker.config_path,
        ],
    )?;
    let present: BTreeSet<String> = serde_json::from_slice::<Value>(&listing)?
        .as_array()
        .ok_or("Unexpected secret inventory; refusing changes")?
        .iter()
        .filter_map(|s| s["name"].as_str().map(str::to_owned))
        .collect();
    let missing: Vec<&String> = worker
        .secrets
        .iter()
        .filter(|s| !present.contains(*s))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let values = crate::infra::secrets::read(&spec.secrets_path())?;
    let mut upload = serde_json::Map::new();
    for name in missing {
        let value = values.get(name).ok_or_else(|| {
            format!(
                "{name} is missing on {} and in {}",
                worker.name, spec.secrets_file
            )
        })?;
        upload.insert(name.clone(), Value::String(value.clone()));
    }
    wrangler::run_with_stdin(
        &spec.account_id,
        &["secret", "bulk", "--config", &worker.config_path],
        &serde_json::to_vec(&upload)?,
    )
}
