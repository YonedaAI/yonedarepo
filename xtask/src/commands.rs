use crate::{
    layout::{DevelopmentPaths, FRONTEND, PLATFORM_CONFIG, SITES_CONFIG, WORKER_CRATE},
    live,
    process::{Result, deploy_token, ensure_token, run},
};
pub async fn execute(args: Vec<String>) -> Result<()> {
    let command = args.first().map(String::as_str).unwrap_or("help");
    match command {
        "context-study" => crate::context_study::execute(&args).await,
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
        "check" => {
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
            build_wasm()?;
            run("pnpm", &["check"])?;
            run("pnpm", &["test"])?;
            run("pnpm", &["test:apps"])?;
            // The source platform must pass on its own, with the agent layer switched off.
            run("pnpm", &["test:platform"])?;
            run("pnpm", &["test:superfan"])?;
            run("pnpm", &["test:eval"])?;
            run("pnpm", &["test:runtime"])?;
            run("pnpm", &["test:frontend"])?;
            run("pnpm", &["--dir", FRONTEND, "build"])?;
            Ok(())
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
                paths.sites.to_str().ok_or("Invalid sites path")?,
                state_dir,
            )
            .await
        }
        // With --env: the spec-driven deploy. Without: the old-layout production deploy,
        // kept until the N8 cutover.
        "deploy" => match crate::deploy_env::mode(&args)? {
            crate::deploy_env::Mode::Spec => crate::deploy_env::deploy(&args).await,
            crate::deploy_env::Mode::Legacy => {
                crate::deploy_env::legacy_preflight(&args).await?;
                legacy_deploy()
            }
        },
        "rollback" => crate::deploy_live::rollback(&args).await,
        "status" => crate::deploy_live::status(&args).await,
        "infra" => crate::infra::execute(&args).await,
        "seed-template" | "demo" | "verify-live" | "upgrade-policy" => {
            let url = args
                .windows(2)
                .find(|v| v[0] == "--url")
                .map(|v| v[1].as_str())
                .unwrap_or("http://127.0.0.1:8787");
            // The retry fixture is an ordinary console project; name it with --repo.
            let repo = args
                .windows(2)
                .find(|v| v[0] == "--repo")
                .map(|v| v[1].as_str())
                .unwrap_or("retry-client");
            if command == "seed-template" {
                crate::bootstrap::seed_template(url).await
            } else if command == "demo" {
                live::start(url, repo).await
            } else if command == "upgrade-policy" {
                live::upgrade_policy(url, repo).await
            } else {
                live::verify(url, repo).await
            }
        }
        _ => {
            println!(
                "cargo xtask <cloudflare-configure|cloudflare-deploy|context-study|doctor|setup|check|build|dev|deploy|rollback|status|infra|seed-template|demo|verify-live|upgrade-policy> [--url URL] [--repo ID]\ndeploy|rollback|status --env dev|prod|ephemeral-<id> [--dry-run] [--confirm] [--allow-active]: spec-driven (infra/envs). deploy --prebuilt <dir>: deploy CI's tested Wasm, frontend and runtime image instead of building. deploy --env prod-legacy --confirm: the old single-Worker production deploy.\nLocal check uses no paid inference. demo starts real agents. verify-live checks existing recorded evidence."
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

/// The old single-Worker production deploy (cloudflare/wrangler.jsonc + sites). Note that
/// cloudflare/wrangler.jsonc is not what production runs today (see infra/envs/prod.json),
/// so this path is reachable only as `deploy --env prod-legacy --confirm` behind the prod
/// guards, until the N8 cutover removes it.
fn legacy_deploy() -> Result<()> {
    ensure_token()?;
    build_wasm()?;
    run("pnpm", &["--dir", FRONTEND, "build"])?;
    deploy_token()?;
    crate::cloudflare::wrangler(
        std::path::Path::new(PLATFORM_CONFIG),
        &[
            "d1",
            "migrations",
            "apply",
            "yonedarepo-dev-index",
            "--remote",
        ],
    )?;
    crate::cloudflare::wrangler(std::path::Path::new(PLATFORM_CONFIG), &["deploy"])?;
    crate::cloudflare::wrangler(std::path::Path::new(SITES_CONFIG), &["deploy"])
}
