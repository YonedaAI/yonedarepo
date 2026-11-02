mod admin;
mod audit_set_aside;
mod cloudflare;
mod cloudflare_deploy;
mod commands;
mod contracts;
mod deploy_credentials;
mod deploy_env;
mod deploy_evidence;
mod deploy_exec;
mod deploy_guard;
mod deploy_image;
mod deploy_inputs;
mod deploy_ledger;
mod deploy_live;
mod deploy_prebuilt;
mod deploy_registry;
mod deploy_rollback;
mod deploy_secrets;
mod deploy_ship;
mod dev;
mod downloads;
mod erase_backfill;
mod health;
mod infra;
mod internal_accounts;
mod layers;
mod layout;
mod local_config;
mod newsletter_export;
mod process;
mod reimport;
mod revenue_rebuild;
mod search_backfill;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
        .to_path_buf();
    std::env::set_current_dir(root).expect("workspace exists");
    if let Err(error) = commands::execute(std::env::args().skip(1).collect()).await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
