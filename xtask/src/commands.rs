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
        // The complete local gate. On GitHub it is split in two (keep both in step with
        // this arm): "Check" (.github/workflows/ci.yml) runs the fast half on every PR and
        // push to main; "Full suite" (full.yml) runs the rest by hand before a prod ship.
        "check" => {
            crate::layers::check()?;
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
            // The SSH gateway is its own workspace (its image builds from its directory alone).
            let gateway = "backend/crates/yoneda-ssh-gateway/Cargo.toml";
            run("cargo", &["fmt", "--check", "--manifest-path", gateway])?;
            let lint = ["clippy", "--manifest-path", gateway, "--all-targets"];
            run("cargo", &[&lint[..], &["--", "-D", "warnings"]].concat())?;
            run("cargo", &["test", "--manifest-path", gateway])?;
            build_wasm()?;
            run("pnpm", &["check"])?;
            run("pnpm", &["test"])?;
            // The source platform must pass on its own, in its platform-only test Worker.
            run("pnpm", &["test:platform"])?;
            run("pnpm", &["test:superfan"])?;
            run("pnpm", &["test:managed"])?;
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
                state_dir,
            )
            .await
        }
        "deploy" => crate::deploy_env::deploy(&args).await,
        "rollback" => crate::deploy_live::rollback(&args).await,
        "status" => crate::deploy_live::status(&args).await,
        "live-check" => crate::deploy_live::live_check(&args).await,
        "runtime-image" if args.get(1).map(String::as_str) == Some("record") => {
            crate::deploy_registry::record_command(&args).await
        }
        "infra" => crate::infra::execute(&args).await,
        "contracts" => crate::contracts::write(&std::env::current_dir()?),
        _ => {
            println!(
                "cargo xtask <cloudflare-configure|cloudflare-deploy|doctor|setup|check|build|dev|deploy|rollback|status|live-check|runtime-image|infra|contracts|layers> [--env dev|prod]\ndeploy|rollback|status --env dev|prod|ephemeral-<id> [--dry-run] [--confirm] [--allow-active]: spec-driven (infra/envs). deploy --env dev (no --prebuilt): the workstation deploy; token from ~/.config/yonedarepo/deploy-dev.env unless CLOUDFLARE_API_TOKEN is set; reuses the deployed runtime image when its inputs are unchanged, else builds it for linux/amd64 (busy containers stop it unless --allow-active). deploy --prebuilt <dir>: deploy a tested Wasm, frontend and runtime image build instead of building (no workflow uses it now). contracts: writes shared/contracts/*.ts from the Rust types. layers: checks crate dependencies against xtask/layers.toml. live-check --env dev: whether /health already shows HEAD (deploy=true|false to $GITHUB_OUTPUT; no workflow uses it now). runtime-image record --env <env> --built-from <commit>: record the deployed image's inputs.\nLocal check uses no paid inference."
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
