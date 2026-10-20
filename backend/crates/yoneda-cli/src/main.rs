//! `yoneda`: an offline client for the YonedaRepo source platform. Clone, commit with
//! plain Git while offline, then sync: the pending commits become platform commits pinned
//! to the clone's base version, and landing applies the platform's path-level checks.
mod api;
mod args;
mod attempt;
mod changes;
mod checkout;
mod chunk;
mod clone;
mod conflict;
mod credentials;
mod error;
mod git;
mod plan;
mod pull;
mod reconcile;
mod snapshot;
mod state;
mod status;
mod sync;
#[cfg(test)]
mod testkit;

use args::{Command, SyncMode};
use checkout::Checkout;
use error::{Error, Result};

fn login(origin: &str) -> Result<()> {
    let origin = credentials::normalize_origin(origin)?;
    let mut line = String::new();
    std::io::stdin()
        .read_line(&mut line)
        .map_err(|e| Error::new(format!("reading the token from stdin: {e}")))?;
    let token = credentials::Token::new(&line)?;
    let path = credentials::default_path()?;
    credentials::store(&path, &origin, &token)?;
    println!(
        "Stored a token for {origin} in {} (mode 0600)",
        path.display()
    );
    Ok(())
}

async fn run(command: Command) -> Result<()> {
    match command {
        Command::Help => {
            println!("{}", args::USAGE);
            Ok(())
        }
        Command::Login { origin } => login(&origin),
        Command::Clone { repo, dir, origin } => {
            clone::clone(&repo, dir.as_deref(), origin.as_deref()).await
        }
        Command::Status => status::status(&Checkout::open()?).await,
        Command::Pull => pull::pull(&mut Checkout::open()?).await,
        Command::Sync(mode) => {
            let mut co = Checkout::open()?;
            match mode {
                SyncMode::Attempt { id, mcp_url } => {
                    attempt::sync(&mut co, &id, mcp_url.as_deref()).await
                }
                SyncMode::Push | SyncMode::Land => {
                    let made = sync::push(&mut co).await?;
                    println!(
                        "Pushed {made} platform commit(s) to {}",
                        co.state.offline_branch
                    );
                    if mode == SyncMode::Land {
                        sync::land(&mut co).await?;
                    }
                    Ok(())
                }
            }
        }
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let outcome = args::parse(&argv).and_then(|command| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| Error::new(format!("starting the runtime: {e}")))?
            .block_on(run(command))
    });
    if let Err(error) = outcome {
        eprintln!("yoneda: {error}");
        std::process::exit(error.exit_code);
    }
}
