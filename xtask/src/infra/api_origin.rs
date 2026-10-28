//! The platform API's public origin for one env: where the browser app points people for
//! stock Git, the `yoneda` CLI and MCP. The front Worker serves only the app and `/api/*`;
//! `/git/*` is answered by the platform Worker alone, so the app is built with this origin
//! (`VITE_YONEDA_API_ORIGIN`) instead of falling back to its own page origin.
use super::inventory;
use super::spec::Spec;
use super::template::expand;
use crate::process::Result;

/// The env variable the frontend build reads (frontend/src/features/source-platform/connect.ts).
pub(crate) const FRONTEND_VAR: &str = "VITE_YONEDA_API_ORIGIN";

/// `https://<host>` of the platform Worker's Custom Domain; without one (an ephemeral stack
/// drops routes), its workers.dev URL. Fails when the spec has no reachable platform Worker.
pub(crate) fn api_origin(spec: &Spec) -> Result<String> {
    let worker = spec
        .workers
        .iter()
        .find(|w| w.role == "platform")
        .ok_or_else(|| format!("Spec {} has no platform Worker", spec.env))?;
    let mut config = worker.config.clone();
    expand(&mut config, &spec.substitutions())?;
    if let Some(route) = inventory::routes(&config)
        .into_iter()
        .find(|r| r.custom_domain)
    {
        return Ok(format!("https://{}", route.pattern));
    }
    match (config["workers_dev"].as_bool(), config["name"].as_str()) {
        (Some(true), Some(name)) => Ok(format!(
            "https://{name}.{}.workers.dev",
            spec.workers_subdomain
        )),
        _ => Err(format!(
            "The {} platform Worker has neither a Custom Domain nor workers.dev",
            spec.env
        )
        .into()),
    }
}
