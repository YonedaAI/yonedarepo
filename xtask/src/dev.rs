//! Serve the combined Worker (front and platform) locally.
use crate::process::Result;
use tokio::process::Command;
pub async fn serve(platform_config: &str, state_dir: &str) -> Result<()> {
    let state = std::env::current_dir()?.join(state_dir);
    let state = state.to_str().ok_or("Non-UTF8 state path")?;
    let mut platform = Command::new("pnpm")
        .args([
            "exec",
            "wrangler",
            "dev",
            "-c",
            platform_config,
            "--port",
            "8787",
            "--persist-to",
            state,
        ])
        .kill_on_drop(true)
        .spawn()?;
    tokio::select! {
        status=platform.wait()=>{if !status?.success(){return Err("Platform development server exited with an error".into());}},
        signal=tokio::signal::ctrl_c()=>{signal?;}
    }
    Ok(())
}
