//! Keep platform and untrusted static output on separate local origins.
use crate::process::Result;
use tokio::process::Command;
pub async fn serve() -> Result<()> {
    let state = std::env::current_dir()?.join(".wrangler/state");
    let state = state.to_str().ok_or("Non-UTF8 state path")?;
    let mut sites = Command::new("pnpm")
        .args([
            "exec",
            "wrangler",
            "dev",
            "-c",
            "sites/wrangler.jsonc",
            "--port",
            "8788",
            "--inspector-port",
            "9230",
            "--persist-to",
            state,
        ])
        .kill_on_drop(true)
        .spawn()?;
    let mut platform = Command::new("pnpm")
        .args([
            "exec",
            "wrangler",
            "dev",
            "-c",
            "wrangler.jsonc",
            "--port",
            "8787",
            "--persist-to",
            state,
            "--var",
            "SITE_ORIGIN:http://localhost:8788",
        ])
        .kill_on_drop(true)
        .spawn()?;
    tokio::select! {
        status=platform.wait()=>{if !status?.success(){return Err("Platform development server exited with an error".into());}},
        status=sites.wait()=>{if !status?.success(){return Err("Sites development server exited with an error".into());}},
        signal=tokio::signal::ctrl_c()=>{signal?;}
    }
    Ok(())
}
