//! The `yoneda` command: parse, dispatch, report.
use crate::args::{self, Command, SyncMode};
use crate::checkout::Checkout;
use crate::error::{Error, Result};
use crate::{
    account, agent_hook, attempt, brief, change_cmd, clone, login, pull, reads, release_cmd,
    repo_ops, session_cmd, setup, status, sync, target,
};

async fn sync_checkout(mode: SyncMode) -> Result<()> {
    let mut co = Checkout::open()?;
    match mode {
        SyncMode::Attempt { id, mcp_url } => attempt::sync(&mut co, &id, mcp_url.as_deref()).await,
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

/// `status`: an offline checkout's full status, else the Git clone's summary line.
async fn show_status(brief_only: bool) -> Result<()> {
    if let Ok(co) = Checkout::open() {
        if brief_only {
            let s = &co.state;
            println!(
                "yoneda {} at {} | {} version {} (offline checkout)",
                s.repo, s.origin, s.branch, s.base_version
            );
            return Ok(());
        }
        return status::status(&co).await;
    }
    let clone = target::current_clone().ok_or_else(|| Error::new("not inside a Git repository"))?;
    println!("{}", brief::line(&clone)?);
    Ok(())
}

async fn run(command: Command) -> Result<()> {
    match command {
        Command::Help => {
            println!("{}", args::USAGE);
            Ok(())
        }
        Command::Login {
            origin,
            with_token,
            browser,
        } => {
            login::login(
                &target::account_origin(origin.as_deref())?,
                with_token,
                browser,
            )
            .await
        }
        Command::Logout { origin } => {
            let origin = origin
                .map(|o| crate::credentials::normalize_origin(&o))
                .transpose()?;
            login::logout(origin.as_deref())
        }
        Command::Repo { origin, command } => account::run(origin.as_deref(), command).await,
        Command::Org { origin, command } => crate::org_cmd::run(origin.as_deref(), command).await,
        Command::SshKey { origin, command } => {
            crate::ssh_key_cmd::run(origin.as_deref(), command).await
        }
        Command::Setup { agent, origin } => {
            setup::run(agent, &target::account_origin(origin.as_deref())?)
        }
        Command::Land { target, branch } => {
            repo_ops::land(&target::resolve(&target)?, branch.as_deref()).await
        }
        Command::Rebase {
            target,
            branch,
            onto,
        } => repo_ops::rebase(&target::resolve(&target)?, &branch, onto.as_deref()).await,
        Command::Review {
            target,
            approve,
            commit,
            reason,
        } => {
            repo_ops::review(
                &target::resolve(&target)?,
                approve,
                &commit,
                reason.as_deref(),
            )
            .await
        }
        Command::Policy { target, set } => {
            repo_ops::policy(&target::resolve(&target)?, set.as_deref()).await
        }
        Command::Token { target, command } => {
            repo_ops::token(&target::resolve(&target)?, command).await
        }
        Command::Read { target, command } => reads::read(&target::resolve(&target)?, command).await,
        Command::Check { target, command } => {
            repo_ops::check(&target::resolve(&target)?, command).await
        }
        Command::Conflicts => repo_ops::conflicts(),
        Command::Clone { repo, dir, origin } => {
            clone::clone(&repo, dir.as_deref(), origin.as_deref()).await
        }
        Command::Status { brief } => show_status(brief).await,
        Command::Pull => pull::pull(&mut Checkout::open()?).await,
        Command::Sync(mode) => sync_checkout(mode).await,
        Command::Reads(command) => session_cmd::reads(command),
        Command::Push(args) => session_cmd::push(args),
        Command::Session { target, command } => session_cmd::session(&target, command).await,
        Command::Change { target, command } => {
            change_cmd::run(&target::resolve(&target)?, command).await
        }
        Command::Release { target, command } => {
            release_cmd::run(&target::resolve(&target)?, command).await
        }
        Command::Hook(event) => agent_hook::run(event).await,
    }
}

/// The `yoneda` entry point.
pub fn main() {
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
