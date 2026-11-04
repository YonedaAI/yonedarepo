//! `yoneda-local`: a clone's local YonedaRepo service (docs/local-repository-future.md).
//! `yoneda local <command>` runs it.
//!
//! - `init`: set up the clone's local repository and remote `local`.
//! - `serve`: run the service (one per clone) until interrupted.
//! - `status [--json]`: `main` and the log version, from the authority.
//! - `credential get`: Git's credential helper for the remote.
mod advertise;
mod authority;
mod backend;
mod compute;
mod credential;
mod http;
mod init;
mod layout;
mod lock;
mod merge;
mod moves;
mod pause;
mod project;
mod receive;
mod service;
mod store;
mod verify;

use layout::{Layout, local_error};
use serde_json::json;
use service::{PROJECTOR, Service};
use std::sync::Arc;
use yoneda_core::Result;

const USAGE: &str = "usage: yoneda local <init | serve | status [--json] | credential get>";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = std::env::current_dir()
        .map_err(|e| local_error(format!("No working directory: {e}")))
        .and_then(|cwd| run(&cwd, &args));
    match result {
        Ok(out) if out.is_empty() => {}
        Ok(out) => print!("{out}{}", if out.ends_with('\n') { "" } else { "\n" }),
        Err(e) => {
            eprintln!("yoneda local: {}", e.message);
            std::process::exit(1);
        }
    }
}

fn run(cwd: &std::path::Path, args: &[String]) -> Result<String> {
    match args.first().map(String::as_str) {
        Some("init") => init::init(cwd),
        Some("serve") => serve(cwd).map(|()| String::new()),
        Some("status") => status(cwd, args.iter().any(|a| a == "--json")),
        Some("credential") => credential::answer(cwd, args.get(1).map_or("", String::as_str)),
        _ => Err(local_error(USAGE)),
    }
}

fn serve(cwd: &std::path::Path) -> Result<()> {
    let layout = Layout::find(cwd)?;
    let _held = lock::take(&layout)?;
    let svc = Arc::new(Service::open(&layout)?);
    // A crash may have fallen between the authority's commit and a ref update.
    project::project(&svc)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| local_error(format!("Cannot start: {e}")))?;
    runtime.block_on(async move {
        let address = format!("127.0.0.1:{}", svc.config.port);
        let listener = tokio::net::TcpListener::bind(&address)
            .await
            .map_err(|e| local_error(format!("Cannot listen on {address}: {e}")))?;
        println!("listening on http://{address}");
        use std::io::Write;
        let _ = std::io::stdout().flush();
        axum::serve(listener, http::router(svc))
            .with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await
            .map_err(|e| local_error(format!("The service stopped: {e}")))
    })
}

fn status(cwd: &std::path::Path, as_json: bool) -> Result<String> {
    let layout = Layout::find(cwd)?;
    let svc = Service::open(&layout)?;
    let listed = svc
        .authority
        .call(&PROJECTOR, json!({ "op": "repo_refs" }))?;
    let main = listed["refs"]["refs/heads/main"].clone();
    let version = listed["version"].clone();
    if as_json {
        return Ok(
            json!({ "main": main, "version": version, "url": svc.config.url() }).to_string(),
        );
    }
    Ok(format!(
        "local main: {}\nlog version: {}\nremote local: {}",
        main.as_str().unwrap_or("(empty)"),
        version,
        svc.config.url()
    ))
}
