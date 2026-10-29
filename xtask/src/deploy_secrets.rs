//! The Secrets step of a spec-driven deploy (split from deploy_env to keep it small).
use crate::infra::inventory::Deployable;
use crate::infra::spec::Spec;
use crate::infra::wrangler;
use crate::process::Result;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Uploads only the declared secrets the Worker lacks; existing values are never rotated.
/// An optional secret the Worker lacks is uploaded only when the secrets file has it.
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
    let lacking = |names: &[String]| names.iter().any(|s| !present.contains(s));
    if !lacking(&worker.secrets) && !lacking(&worker.optional_secrets) {
        return Ok(());
    }
    let values = crate::infra::secrets::read(&spec.secrets_path())?;
    let upload = uploads(worker, &present, &values).map_err(|name| {
        format!(
            "{name} is missing on {} and in {}",
            worker.name, spec.secrets_file
        )
    })?;
    if upload.is_empty() {
        return Ok(());
    }
    wrangler::run_with_stdin(
        &spec.account_id,
        &["secret", "bulk", "--config", &worker.config_path],
        &serde_json::to_vec(&upload)?,
    )
}

/// The secrets to upload: every required one the Worker lacks (`Err(name)` when the file
/// lacks it too), and the optional ones the Worker lacks and the file has.
fn uploads(
    worker: &Deployable,
    present: &BTreeSet<String>,
    values: &BTreeMap<String, String>,
) -> std::result::Result<Map<String, Value>, String> {
    let mut upload = Map::new();
    for name in worker.secrets.iter().filter(|s| !present.contains(*s)) {
        let value = values.get(name).ok_or_else(|| name.clone())?;
        upload.insert(name.clone(), Value::String(value.clone()));
    }
    for name in worker
        .optional_secrets
        .iter()
        .filter(|s| !present.contains(*s))
    {
        if let Some(value) = values.get(name).filter(|v| !v.is_empty()) {
            upload.insert(name.clone(), Value::String(value.clone()));
        }
    }
    Ok(upload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worker() -> Deployable {
        Deployable {
            name: "front".into(),
            role: "agents".into(),
            config_path: "cloudflare/x.jsonc".into(),
            config: Value::Null,
            secrets: vec!["OWNER_TOKEN".into()],
            optional_secrets: vec![
                "GITHUB_OAUTH_CLIENT_ID".into(),
                "GOOGLE_OAUTH_CLIENT_ID".into(),
            ],
            health: None,
            has_containers: false,
            always_on: BTreeMap::new(),
        }
    }
    fn set(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }
    fn file(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn optional_secrets_upload_when_the_file_has_them_and_never_fail_the_deploy() {
        // Nothing in the file for the providers: only the required secret goes up.
        let up = uploads(&worker(), &set(&[]), &file(&[("OWNER_TOKEN", "t")])).unwrap();
        assert_eq!(up.keys().collect::<Vec<_>>(), ["OWNER_TOKEN"]);
        // The file has one (and an empty one): that one goes up; present ones never rotate.
        let values = file(&[
            ("GITHUB_OAUTH_CLIENT_ID", "id"),
            ("GOOGLE_OAUTH_CLIENT_ID", ""),
        ]);
        let up = uploads(&worker(), &set(&["OWNER_TOKEN"]), &values).unwrap();
        assert_eq!(up.keys().collect::<Vec<_>>(), ["GITHUB_OAUTH_CLIENT_ID"]);
        let all = set(&["OWNER_TOKEN", "GITHUB_OAUTH_CLIENT_ID"]);
        assert!(uploads(&worker(), &all, &values).unwrap().is_empty());
        // A required secret missing everywhere still fails.
        assert_eq!(
            uploads(&worker(), &set(&[]), &values).unwrap_err(),
            "OWNER_TOKEN"
        );
    }
}
