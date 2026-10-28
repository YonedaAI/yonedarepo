//! Infrastructure as code: `cargo xtask infra gen|plan|up|down|smoke --env <env>`.
//! Specs live in `infra/envs/`; generated wrangler configs in `cloudflare/`.
pub(crate) mod api_origin;
pub(crate) mod apply;
pub(crate) mod consumers;
pub(crate) mod drift;
pub(crate) mod env;
pub(crate) mod generate;
pub(crate) mod hosts;
pub(crate) mod inventory;
pub(crate) mod jsonc;
pub(crate) mod live;
pub(crate) mod plan;
pub(crate) mod prune;
pub(crate) mod retired;
pub(crate) mod secrets;
pub(crate) mod smoke;
pub(crate) mod spec;
pub(crate) mod teardown;
pub(crate) mod template;
pub(crate) mod wrangler;

use crate::process::Result;

pub(crate) async fn execute(args: &[String]) -> Result<()> {
    match args.get(1).map(String::as_str) {
        Some("gen") => generate::command(args),
        Some("plan") => plan::command(args).await,
        Some("up") => apply::up(args).await,
        Some("down") => teardown::down(args).await,
        Some("prune") => prune::command(args).await,
        Some("smoke") => smoke::run(args).await,
        _ => {
            println!(
                "cargo xtask infra <gen|plan|up|down|prune|smoke> --env dev|prod|ephemeral-<id>\n  gen [--check]          write cloudflare/wrangler.*.jsonc from infra/envs/<env>.json\n  plan [--strict]        live vs declared: create / unchanged / drift / extra / orphan (read-only)\n  up [--dry-run]         create missing D1/R2/queues, record ids, generate, move hosts, deploy\n  down --confirm [--purge]  delete Workers (+ data with --purge); never prod\n  prune --confirm|--dry-run [--allow-active]  delete the plan's orphan rows (the spec's retired names)\n  smoke                  frontend, /health revisions, owner API\nLive reads need CLOUDFLARE_API_TOKEN or --token-file <file> (read-only token is enough for plan)."
            );
            Ok(())
        }
    }
}

#[cfg(test)]
#[path = "infra/api_origin_tests.rs"]
mod api_origin_tests;
#[cfg(test)]
#[path = "infra/cutover_tests.rs"]
mod cutover_tests;
#[cfg(test)]
#[path = "infra/tests.rs"]
mod tests;
