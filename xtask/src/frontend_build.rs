//! Environment-specific frontend build switches, passed alongside the public API origin.
use crate::process::Result;
use serde_json::Value;

fn switches(vars: Option<&Value>) -> [(&'static str, &str); 3] {
    let get = |key| {
        vars.and_then(|v| v.get(key))
            .and_then(Value::as_str)
            .unwrap_or("off")
    };
    [
        ("VITE_STATIC_ASSET_CACHE", get("STATIC_ASSET_CACHE")),
        (
            "VITE_OVERVIEW_MARKDOWN_PRELOAD",
            get("OVERVIEW_MARKDOWN_PRELOAD"),
        ),
        ("VITE_EARLY_READS", get("EARLY_READS")),
    ]
}

/// Builds the frontend without pnpm (worktrees symlink node_modules), pointing its Git, CLI
/// and MCP lines at the env's platform API origin.
pub(crate) fn run(spec: &crate::infra::spec::Spec) -> Result<()> {
    let api_origin = crate::infra::api_origin::api_origin(spec)?;
    let vars = spec
        .workers
        .iter()
        .find(|worker| worker.role == "agents")
        .and_then(|worker| worker.config.get("vars"));
    let switches = switches(vars);
    for (program, args) in [
        ("node_modules/.bin/tsc", vec!["-b"]),
        ("node_modules/.bin/vite", vec!["build"]),
    ] {
        let status = std::process::Command::new(program)
            .args(&args)
            .current_dir(crate::layout::FRONTEND)
            .env(crate::infra::api_origin::FRONTEND_VAR, &api_origin)
            .envs(switches)
            .status()
            .map_err(|error| format!("Cannot start frontend {program}: {error}"))?;
        if !status.success() {
            return Err(format!("Frontend {program} failed ({status})").into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn absent_build_switches_are_off() {
        assert_eq!(
            switches(None),
            [
                ("VITE_STATIC_ASSET_CACHE", "off"),
                ("VITE_OVERVIEW_MARKDOWN_PRELOAD", "off"),
                ("VITE_EARLY_READS", "off")
            ]
        );
    }
    #[test]
    fn parser_preload_does_not_follow_asset_caching() {
        let vars = json!({"STATIC_ASSET_CACHE":"on", "OVERVIEW_MARKDOWN_PRELOAD":"off"});
        assert_eq!(
            switches(Some(&vars)),
            [
                ("VITE_STATIC_ASSET_CACHE", "on"),
                ("VITE_OVERVIEW_MARKDOWN_PRELOAD", "off"),
                ("VITE_EARLY_READS", "off")
            ]
        );
        let vars = json!({"OVERVIEW_MARKDOWN_PRELOAD":"on"});
        assert_eq!(
            switches(Some(&vars)),
            [
                ("VITE_STATIC_ASSET_CACHE", "off"),
                ("VITE_OVERVIEW_MARKDOWN_PRELOAD", "on"),
                ("VITE_EARLY_READS", "off")
            ]
        );
    }
    #[test]
    fn early_reads_are_an_independent_declared_build_switch() {
        let vars = json!({"EARLY_READS":"on"});
        assert_eq!(
            switches(Some(&vars)).last(),
            Some(&("VITE_EARLY_READS", "on"))
        );
    }
}
