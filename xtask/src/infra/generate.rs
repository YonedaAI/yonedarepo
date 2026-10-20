//! Spec -> `cloudflare/wrangler.*.jsonc`. See `jsonc` for the comparison normalisation.
use super::jsonc;
use super::spec::{CONFIG_DIR, Env, Lock, SPEC_DIR, Spec};
use crate::process::Result;
use std::path::PathBuf;

/// Generates every Worker config of the env. With `check`, nothing is written. Returns
/// each path and whether it differs (or differed) from the generated value.
pub(crate) fn generate(
    env: &Env,
    spec: &Spec,
    lock: &Lock,
    check: bool,
) -> Result<Vec<(PathBuf, bool)>> {
    let source = match env {
        Env::Ephemeral(_) => format!("{SPEC_DIR}/dev.json ({})", env.name()),
        other => format!("{SPEC_DIR}/{}.json", other.name()),
    };
    spec.configs(lock)?
        .into_iter()
        .map(|(worker, config)| {
            let path = PathBuf::from(CONFIG_DIR).join(&worker.file);
            let changed = if check {
                !path.exists() || jsonc::read(&path)? != config
            } else {
                jsonc::write_if_changed(&path, &worker.notes, &config, &source)?
            };
            Ok((path, changed))
        })
        .collect()
}

pub(crate) fn command(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let check = args.iter().any(|a| a == "--check");
    let spec = Spec::load(&env)?;
    let results = generate(&env, &spec, &Lock::load(&env)?, check)?;
    let stale: Vec<String> = results
        .iter()
        .filter(|(_, changed)| *changed)
        .map(|(path, _)| path.display().to_string())
        .collect();
    for (path, changed) in &results {
        let state = match (changed, check) {
            (false, _) => "matches spec",
            (true, true) => "DIFFERS from spec",
            (true, false) => "regenerated",
        };
        println!("{}: {state}", path.display());
    }
    if check && !stale.is_empty() {
        return Err(format!(
            "{} config(s) differ from the spec: {}",
            stale.len(),
            stale.join(", ")
        )
        .into());
    }
    Ok(())
}
