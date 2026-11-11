//! Choose a clone's integration branch while the service is stopped. Branches and their
//! history are retained; configuration never rewrites an existing authority ref.
use crate::authority::Cred;
use crate::layout::{Layout, local_error};
use crate::service::{PROJECTOR, Service};
use crate::store::run_in;
use crate::sync::state::{State, Sync};
use serde_json::json;
use std::path::Path;
use yoneda_core::Result;

#[derive(Default)]
pub struct Options {
    pub branch: Option<String>,
    pub cloud: Option<bool>,
}

impl Options {
    pub fn parse(cwd: &Path, args: &[String]) -> Result<Self> {
        let mut options = Self::default();
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--branch" if options.branch.is_none() => {
                    let branch = args
                        .next()
                        .ok_or_else(|| local_error("--branch needs a name"))?;
                    if branch.starts_with('-') || branch.starts_with("refs/") || branch == "HEAD" {
                        return Err(local_error("Use a short branch name, e.g. dev"));
                    }
                    run_in(
                        cwd,
                        &["check-ref-format", &format!("refs/heads/{branch}")],
                        None,
                    )?;
                    options.branch = Some(branch.to_owned());
                }
                "--no-cloud" if options.cloud.is_none() => options.cloud = Some(false),
                "--cloud" if options.cloud.is_none() => options.cloud = Some(true),
                _ => return Err(local_error(format!("Unknown or repeated option: {arg}"))),
            }
        }
        Ok(options)
    }
}

pub fn run(cwd: &Path, args: &[String]) -> Result<String> {
    let options = Options::parse(cwd, args)?;
    let layout = Layout::find(cwd)?;
    // Configuration and a live landing/sync round must never interleave.
    let _held = crate::lock::hold(&layout)?;
    let svc = Service::open(&layout)?;
    let mut config = svc.config.clone();
    if let Some(branch) = options.branch {
        let refs = svc
            .authority
            .call(&PROJECTOR, json!({ "op": "repo_refs" }))?;
        let refname = format!("refs/heads/{branch}");
        if !refs["refs"][&refname].is_string() {
            // Import the explicitly named clone branch, never fall back to the release
            // branch or the caller's task HEAD. Existing refs are never overwritten.
            let revision = format!("{refname}^{{commit}}");
            let id = run_in(cwd, &["rev-parse", "--verify", &revision], None)?;
            let id = String::from_utf8_lossy(&id).trim().to_owned();
            if svc
                .authority
                .call(
                    &PROJECTOR,
                    json!({ "op": "repo_commit", "commit": id, "brief": true }),
                )
                .is_ok()
            {
                svc.authority.call(
                    &Cred::Owner,
                    json!({ "op": "repo_branch_batch",
                    "updates": [{ "ref": refname, "commit": id, "expected": null }] }),
                )?;
            } else {
                crate::init::import_branch(&svc, cwd, &branch, &Cred::Owner)?;
            }
        }
        config.branch = branch;
    }
    if let Some(enabled) = options.cloud {
        config.sync_enabled = enabled;
    }
    layout.write_config(&config)?;
    let mut sync = Sync::load(&layout);
    if config.branch != svc.config.branch {
        sync.cloud_main = None;
        sync.synced_version = 0;
    }
    sync.state = if config.sync_enabled {
        State::Pending
    } else {
        State::Disabled
    };
    sync.detail = (!config.sync_enabled).then(|| "cloud sync is disabled for this clone".into());
    sync.save(&layout)?;
    svc.store
        .git(&["symbolic-ref", "HEAD", &config.refname()], None)?;
    crate::project::project(&svc)?;
    crate::init::exclude_worktrees(cwd)?;
    // This hint lets agents discover the branch without parsing a local state file.
    run_in(cwd, &["config", "yoneda.localBranch", &config.branch], None)?;
    Ok(format!(
        "Local landing branch: {}\nCloud sync: {}\nStart `yoneda local serve` to accept landings.",
        config.branch,
        if config.sync_enabled {
            "enabled"
        } else {
            "disabled"
        }
    ))
}
