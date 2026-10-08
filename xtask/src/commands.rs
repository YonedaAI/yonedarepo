use crate::{
    live,
    process::{Result, deploy_token, ensure_token, run},
};
pub async fn execute(args: Vec<String>) -> Result<()> {
    let command = args.first().map(String::as_str).unwrap_or("help");
    match command {
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
            run("pnpm", &["test:runtime"])?;
            run("pnpm", &["--dir", "web", "build"])?;
            Ok(())
        }
        "build" => {
            build_wasm()?;
            run("pnpm", &["--dir", "web", "build"])
        }
        "dev" => {
            ensure_token()?;
            build_wasm()?;
            run("pnpm", &["--dir", "web", "build"])?;
            run(
                "pnpm",
                &[
                    "exec",
                    "wrangler",
                    "d1",
                    "migrations",
                    "apply",
                    "yonedarepo-dev-index",
                    "--local",
                ],
            )?;
            crate::dev::serve().await
        }
        "deploy" => {
            ensure_token()?;
            build_wasm()?;
            run("pnpm", &["--dir", "web", "build"])?;
            deploy_token()?;
            run(
                "pnpm",
                &[
                    "exec",
                    "wrangler",
                    "d1",
                    "migrations",
                    "apply",
                    "yonedarepo-dev-index",
                    "--remote",
                ],
            )?;
            run("pnpm", &["exec", "wrangler", "deploy"])?;
            run(
                "pnpm",
                &[
                    "exec",
                    "wrangler",
                    "deploy",
                    "--config",
                    "sites/wrangler.jsonc",
                ],
            )
        }
        "seed-template" | "seed-demo" | "demo" | "verify-live" | "upgrade-policy" => {
            let url = args
                .windows(2)
                .find(|v| v[0] == "--url")
                .map(|v| v[1].as_str())
                .unwrap_or("http://127.0.0.1:8787");
            if command == "seed-template" {
                crate::bootstrap::seed_template(url).await
            } else if command == "seed-demo" {
                live::seed(url).await
            } else if command == "demo" {
                live::start(url).await
            } else if command == "upgrade-policy" {
                live::upgrade_policy(url).await
            } else {
                live::verify(url).await
            }
        }
        _ => {
            println!(
                "cargo xtask <doctor|setup|check|build|dev|deploy|seed-template|seed-demo|demo|verify-live|upgrade-policy> [--url URL]\nLocal check uses no paid inference. demo starts real agents. verify-live checks existing recorded evidence."
            );
            Ok(())
        }
    }
}
fn build_wasm() -> Result<()> {
    let status = std::process::Command::new("worker-build")
        .arg("--release")
        .current_dir("crates/yoneda-worker")
        .status()?;
    if !status.success() {
        return Err("Wasm build failed".into());
    }
    Ok(())
}
