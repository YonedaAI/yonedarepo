use crate::{
    layout::{DevelopmentPaths, FRONTEND, WORKER_CRATE},
    process::{Result, ensure_token, run},
};
pub async fn execute(args: Vec<String>) -> Result<()> {
    let command = args.first().map(String::as_str).unwrap_or("help");
    match command {
        "cloudflare-configure" => crate::cloudflare::configure(&args),
        "cloudflare-deploy" => crate::cloudflare_deploy::deploy(&args).await,
        "doctor" => {
            for (program, arguments) in [
                ("rustc", vec!["--version"]),
                ("cargo", vec!["--version"]),
                ("node", vec!["--version"]),
                ("pnpm", vec!["--version"]),
                ("worker-build", vec!["--version"]),
                ("docker", vec!["version", "--format", "{{.Server.Version}}"]),
                ("gitleaks", vec!["version"]),
            ] {
                run(program, &arguments)?;
            }
            println!(
                "Provider keys stay in Cloudflare Secrets Store. Live access is verified by an actual run."
            );
            Ok(())
        }
        "setup" => {
            run("pnpm", &["install", "--frozen-lockfile"])?;
            ensure_token()?;
            println!(
                "Local owner token is in .local/owner-token (ignored by Git). Run cargo xtask dev."
            );
            Ok(())
        }
        "layers" => crate::layers::check(),
        "health" => crate::health::execute(&args),
        // The complete local gate. On GitHub it is split in two (keep both in step with
        // this arm): "Check" (.github/workflows/ci.yml) runs the fast half on every PR and
        // push to main; "Full suite" (full.yml) runs the rest by hand before a prod ship.
        "check" => {
            crate::layers::check()?;
            crate::health::check_lines(None)?;
            crate::health::check_migrations(None)?;
            crate::health::check_secrets(None)?;
            run("cargo", &["fmt", "--all", "--check"])?;
            run(
                "cargo",
                &[
                    "clippy",
                    "--workspace",
                    "--all-targets",
                    "--",
                    "-D",
                    "warnings",
                ],
            )?;
            run("cargo", &["test", "--workspace"])?;
            // The SSH gateway and the pack builder are workspaces of their own (each image
            // builds from its directory alone).
            for own in [
                "backend/crates/yoneda-ssh-gateway/Cargo.toml",
                "backend/crates/yoneda-pack-builder/Cargo.toml",
            ] {
                run("cargo", &["fmt", "--check", "--manifest-path", own])?;
                let lint = ["clippy", "--manifest-path", own, "--all-targets"];
                run("cargo", &[&lint[..], &["--", "-D", "warnings"]].concat())?;
                run("cargo", &["test", "--manifest-path", own])?;
            }
            build_wasm()?;
            run("pnpm", &["check"])?;
            crate::health::run_suite("test")?;
            // The source platform must pass on its own, in its platform-only test Worker.
            crate::health::run_suite("test:platform")?;
            crate::health::run_suite("test:storage-full")?;
            crate::health::run_suite("test:superfan")?;
            crate::health::run_suite("test:managed")?;
            run("pnpm", &["test:runtime"])?;
            crate::health::run_suite("test:frontend")?;
            run("pnpm", &["--dir", FRONTEND, "build"])?;
            crate::health::check_size()
        }
        "build" => {
            build_wasm()?;
            run("pnpm", &["--dir", FRONTEND, "build"])
        }
        "dev" => {
            ensure_token()?;
            build_wasm()?;
            run("pnpm", &["--dir", FRONTEND, "build"])?;
            let target = if args.iter().any(|v| v == "--name") {
                Some(crate::cloudflare::deployment(&args)?)
            } else {
                None
            };
            let paths = DevelopmentPaths::new(target.as_deref());
            if let Some(dir) = &target {
                crate::local_config::named_vars(std::path::Path::new("."), dir)?;
            }
            // Absolute persistence paths keep the existing state when config directories move.
            let state = std::env::current_dir()?.join(&paths.state);
            let state_dir = state.to_str().ok_or("Invalid state path")?;
            crate::cloudflare::wrangler(
                &paths.platform,
                &[
                    "d1",
                    "migrations",
                    "apply",
                    "INDEX",
                    "--local",
                    "--persist-to",
                    state_dir,
                ],
            )?;
            crate::dev::serve(
                paths.platform.to_str().ok_or("Invalid platform path")?,
                state_dir,
            )
            .await
        }
        "deploy" => crate::deploy_env::deploy(&args).await,
        "rollback" => crate::deploy_rollback::rollback(&args).await,
        "status" => crate::deploy_live::status(&args).await,
        "live-check" => crate::deploy_live::live_check(&args).await,
        "live-tests" => crate::deploy_ship::mark(&args),
        "runtime-image" if args.get(1).map(String::as_str) == Some("record") => {
            crate::deploy_registry::record_command(&args).await
        }
        "infra" => crate::infra::execute(&args).await,
        "admin" => crate::admin::execute(&args).await,
        "downloads" => crate::downloads::execute(&args),
        "contracts" => crate::contracts::write(&std::env::current_dir()?),
        _ => {
            println!(
                "cargo xtask <cloudflare-configure|cloudflare-deploy|doctor|setup|check|build|dev|deploy|rollback|status|live-check|live-tests|runtime-image|infra|admin|downloads|contracts|layers|health> [--env dev|prod]\ndeploy|rollback|status --env dev|prod|ephemeral-<id> [--dry-run] [--confirm] [--allow-active]: spec-driven (infra/envs). deploy --env dev (no --prebuilt): the workstation deploy; token from ~/.config/yonedarepo/deploy-dev.env unless CLOUDFLARE_API_TOKEN is set; reuses the deployed runtime image when its inputs are unchanged, else builds it for linux/amd64 (busy containers stop it unless --allow-active). deploy --prebuilt <dir>: deploy a tested Wasm, frontend and runtime image build instead of building (no workflow uses it now). downloads stage|upload --env dev|prod: build and stage the CLI releases and the public Claude Code marketplace in target/downloads/<env>, then upload them to <prefix>-downloads (upload --dry-run prints the commands). admin backfill-accounts --env dev|prod: adds accounts made before the admin index to it (the deployed platform, as the owner). admin erase-backfill --env dev|prod --dry-run|--confirm [--after <cursor>] [--limit <n>] [--delay-ms <ms>] [--token-file <file>]: erases deleted repositories, one at a time (docs/runbook.md). admin audit-set-aside --env dev|prod --repo <id> --seq <n> --dry-run|--confirm --bytes <n>: sets one corrupt audit event aside; a healthy one is refused (docs/incidents.md). admin search-backfill --env dev|prod --owner <account> --dry-run|--confirm [--delay-ms <ms>]: queues a search summary for each of one owner's repositories (docs/runbook.md). admin imports --env dev|prod: lists what each repository needs now Artifacts has gone. admin reimport --env dev|prod --repo <id> [--url <url>] [--branch <branch>] [--confirm]: clones one again under the same id and name (docs/runbook.md). contracts: writes shared/contracts/*.ts from the Rust types. layers: checks crate dependencies against xtask/layers.toml. health [--doc]: code health, dated values in .local/health and what moved (docs/code-health.md). health lines|migrations|secrets [--base <commit>], health size: the gates alone. health lines --update, health migrations --record: tidy their lists. health tests <vitest-json>...: keep a run's results. live-check --env dev: whether /health already shows HEAD (deploy=true|false to $GITHUB_OUTPUT; no workflow uses it now). live-tests [--dry-run]: after a full kit passed at the pushed tip of dev, sets the live-tests commit status a ship needs. deploy --env prod --confirm --ship-head <sha>: the deploy from a merged ship PR, in GitHub Actions; reads the statuses of the PR head (docs/ship-pipeline.md) instead of the dev Workers and the evidence file. runtime-image record --env <env> --built-from <commit>: record the deployed image's inputs.\nLocal check uses no paid inference."
            );
            Ok(())
        }
    }
}
pub(crate) fn build_wasm() -> Result<()> {
    let status = std::process::Command::new("worker-build")
        .arg("--release")
        .current_dir(WORKER_CRATE)
        .status()?;
    if !status.success() {
        return Err("Wasm build failed".into());
    }
    Ok(())
}
