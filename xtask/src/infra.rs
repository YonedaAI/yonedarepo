//! Infrastructure as code: `cargo xtask infra gen|plan|up|down|smoke --env <env>`.
//! Specs live in `infra/envs/`; generated wrangler configs in `cloudflare/`.
pub(crate) mod generate;
pub(crate) mod inventory;
pub(crate) mod jsonc;
pub(crate) mod secrets;
pub(crate) mod spec;
pub(crate) mod wrangler;

use crate::process::Result;

pub(crate) async fn execute(args: &[String]) -> Result<()> {
    match args.get(1).map(String::as_str) {
        Some("gen") => generate::command(args),
        _ => {
            println!(
                "cargo xtask infra gen --env dev|prod|ephemeral-<id> [--check]\n  gen: write cloudflare/wrangler.*.jsonc from infra/envs/<env>.json (--check: compare only)"
            );
            Ok(())
        }
    }
}

#[cfg(test)]
#[path = "infra/tests.rs"]
mod tests;
