//! Read the environment's container inventory through Wrangler.
use super::*;

/// Applications under the env's prefix or retired, with `max_instances` and
/// `configuration.image`.
pub(super) fn containers_via_wrangler(spec: &Spec) -> Result<BTreeMap<String, Value>> {
    let account = &spec.account_id;
    let list: Value = serde_json::from_slice(&super::super::wrangler::output(
        account,
        &["containers", "list", "--json", "--per-page", "100"],
    )?)?;
    let mut apps = BTreeMap::new();
    for app in list.as_array().into_iter().flatten() {
        let (Some(name), Some(id)) = (app["name"].as_str(), app["id"].as_str()) else {
            continue;
        };
        if name.starts_with(&format!("{}-", spec.prefix))
            || spec.retired.matches(Kind::Container, name)
        {
            let info =
                super::super::wrangler::output(account, &["containers", "info", id, "--json"])?;
            apps.insert(name.to_owned(), serde_json::from_slice(&info)?);
        }
    }
    Ok(apps)
}
