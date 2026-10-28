//! `yoneda-ssh-gateway`: configuration from the environment (see `config`), JSON logs on
//! stdout, SIGTERM drains.
use yoneda_ssh_gateway::{config::Config, serve};

#[tokio::main]
async fn main() -> std::process::ExitCode {
    tracing_subscriber::fmt().json().with_target(false).init();
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(e) => {
            tracing::error!(error = %e, "ssh.config_invalid");
            return std::process::ExitCode::FAILURE;
        }
    };
    match serve(config).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!(error = %e, "ssh.failed");
            std::process::ExitCode::FAILURE
        }
    }
}
