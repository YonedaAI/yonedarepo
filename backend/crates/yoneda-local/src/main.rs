//! `yoneda-local`: a clone's local YonedaRepo service (docs/local-repository-future.md).
//! `yoneda local <command>` runs it.
//!
//! - `init`: set up the clone's local repository and remote `local`.
//! - `serve`: run the service (one per clone) until interrupted.
//! - `status [--json]`: local the integration branch and its log version, and where cloud sync stands.
//! - `sync [--json]`: run a sync round now (in the running service, else here).
//! - `token create <name> | list | revoke <name>`: an agent's own token (`token:<name>`).
//! - `log [--json]`: the newest landings and who made each.
//! - `check add <name> (--on-host | --image <image>) -- <command> | list | remove <name>`:
//!   checks run on what would land on the integration branch (its merge, when there is one).
//! - `credential get`: Git's credential helper for the remote.
mod advertise;
mod authority;
mod backend;
mod check_cmd;
mod check_process;
mod checks;
mod cloud;
mod compute;
mod configure;
mod credential;
mod dashboard;
mod http;
mod init;
mod land;
mod layout;
mod lock;
mod merge;
mod moves;
mod outbox;
mod pause;
mod project;
mod reader;
mod receive;
mod report;
mod service;
mod store;
mod sync;
mod sync_http;
mod timing;
mod tokens;
mod verify;

use layout::{Layout, local_error};
use service::Service;
use std::sync::Arc;
use yoneda_core::Result;

const USAGE: &str = "usage: yoneda local <init [--branch <name>] [--no-cloud] | configure [--branch <name>] [--no-cloud | --cloud] | serve | ui | status [--json] | sync [--json] | \
                     token <create <name> | list | revoke <name>> | log [--json] | \
                     check <add | list | remove> | credential get>";

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
        Some("init") => init::init(cwd, &args[1..]),
        Some("configure") => configure::run(cwd, &args[1..]),
        Some("ui") => Ok(Layout::find(cwd)?.config()?.origin()),
        Some("serve") => serve(cwd).map(|()| String::new()),
        Some("status") => report::status(cwd, args.iter().any(|a| a == "--json")),
        Some("sync") => report::sync_now(cwd, args.iter().any(|a| a == "--json")),
        Some("token") => tokens::run(cwd, &args[1..]),
        Some("log") => tokens::log(cwd, args.iter().any(|a| a == "--json")),
        Some("check") => check_cmd::run(cwd, &args[1..]),
        Some("credential") => credential::answer(
            cwd,
            args.get(1).map_or("", String::as_str),
            args.get(2).map_or("", String::as_str),
        ),
        _ => Err(local_error(USAGE)),
    }
}

fn serve(cwd: &std::path::Path) -> Result<()> {
    let layout = Layout::find(cwd)?;
    let _held = lock::take(&layout)?;
    let svc = Arc::new(Service::open(&layout)?);
    svc.store.configure()?;
    svc.store
        .git(&["symbolic-ref", "HEAD", &svc.config.refname()], None)?;
    // A crash may have fallen between a staged landing and its objects reaching the store,
    // or between the authority's commit and a ref update.
    outbox::drain(&svc)?;
    project::project(&svc)?;
    let kicks = sync::start(svc.clone())?;
    *svc.sync.lock().unwrap_or_else(|e| e.into_inner()) = Some(kicks);
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
