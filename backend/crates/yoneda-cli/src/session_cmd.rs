//! Declared reads and session records from the command line: `yoneda reads` (this coding
//! session's reads), `yoneda push` (stock `git push` declaring them with `-o
//! yoneda.reads=…`, then clearing them) and `yoneda session` (a commit's session records).
//! A `yoneda::` remote's helper declares the recorded reads itself, so `yoneda push` to one
//! is a plain `git push`.
use crate::command::{ReadsCommand, SessionCommand, Target};
use crate::error::{Context, Error, Result};
use crate::git::Git;
use crate::remote::url;
use crate::session_files::{SessionFiles, current_session, push_options};
use crate::target;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

/// The Git repository containing a directory.
pub struct Here {
    pub git: Git,
    pub git_dir: PathBuf,
    pub top: PathBuf,
}

pub fn here(cwd: &Path) -> Result<Here> {
    let probe = Git::new(cwd);
    let git_dir = PathBuf::from(probe.run(&["rev-parse", "--absolute-git-dir"])?);
    let top = PathBuf::from(probe.run(&["rev-parse", "--show-toplevel"])?);
    Ok(Here {
        git: Git::with_git_dir(cwd, &git_dir),
        git_dir,
        top,
    })
}

impl Here {
    /// The URLs of this repository's remotes that are the platform's (`yoneda::` or
    /// smart HTTP).
    pub fn platform_urls(&self) -> Vec<String> {
        self.git
            .run(&["config", "--get-regexp", r"^remote\..*\.url$"])
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.split_once(' ').map(|(_, url)| url.to_owned()))
            .filter(|url| url::is_platform(url))
            .collect()
    }
}

/// The existing prefix of `path`, resolved through symlinks (so `/tmp` and `/private/tmp`
/// agree), with the rest appended as given.
fn canonical(path: &Path) -> PathBuf {
    if let Ok(found) = std::fs::canonicalize(path) {
        return found;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => canonical(parent).join(name),
        _ => path.to_owned(),
    }
}

/// `path` (absolute, or relative to `cwd`) as a read entry relative to the work tree `top`:
/// a directory ends in `/`. `None` outside the work tree, at its root, or inside `.git`.
pub fn relative(top: &Path, cwd: &Path, path: &str) -> Option<String> {
    let given = Path::new(path);
    let absolute = if given.is_absolute() {
        given.to_owned()
    } else {
        cwd.join(given)
    };
    let inside = canonical(&absolute)
        .strip_prefix(canonical(top))
        .ok()?
        .to_owned();
    let mut parts = Vec::new();
    for part in inside.components() {
        match part {
            Component::Normal(name) => parts.push(name.to_str()?.to_owned()),
            _ => return None,
        }
    }
    if parts.is_empty() || parts[0] == ".git" {
        return None;
    }
    let mut entry = parts.join("/");
    if absolute.is_dir() {
        entry.push('/');
    }
    Some(entry)
}

pub fn reads(command: ReadsCommand) -> Result<()> {
    let cwd = std::env::current_dir().context("current directory")?;
    let at = here(&cwd)?;
    let files = SessionFiles::new(&at.git_dir);
    match command {
        ReadsCommand::Add { paths } => {
            let mut entries = Vec::new();
            for path in &paths {
                entries.push(relative(&at.top, &cwd, path).ok_or_else(|| {
                    Error::usage(format!("{path} is not inside this repository's work tree"))
                })?);
            }
            let added = files.add_reads(&entries)?;
            println!(
                "{added} new read(s) declared; {} in all",
                files.reads()?.len()
            );
        }
        ReadsCommand::List => {
            for read in files.reads()? {
                println!("{read}");
            }
        }
        ReadsCommand::Clear => {
            files.clear_reads()?;
            println!("Declared reads cleared");
        }
    }
    Ok(())
}

/// `git push` options that take a value as the next argument.
const VALUED: [&str; 5] = ["-o", "--push-option", "--repo", "--receive-pack", "--exec"];

/// The remote (or URL) `git push args` pushes to: its first positional argument, else the
/// current branch's push remote, else `origin`.
fn push_remote(git: &Git, args: &[String]) -> String {
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        if VALUED.contains(&arg.as_str()) {
            rest.next();
        } else if !arg.starts_with('-') {
            return arg.clone();
        }
    }
    let remotes = git.run(&["remote"]).unwrap_or_default();
    git.run(&[
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{push}",
    ])
    .ok()
    .and_then(|tracking| {
        remotes
            .lines()
            .filter(|r| tracking.starts_with(&format!("{r}/")))
            .max_by_key(|r| r.len())
            .map(str::to_owned)
    })
    .unwrap_or_else(|| "origin".into())
}

/// The remote-tracking refs of `remote` and their commits.
fn tracking(git: &Git, remote: &str) -> BTreeMap<String, String> {
    git.run(&[
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        &format!("refs/remotes/{remote}/"),
    ])
    .unwrap_or_default()
    .lines()
    .filter_map(|l| l.split_once(' '))
    .map(|(r, c)| (r.to_owned(), c.to_owned()))
    .collect()
}

pub fn push(args: Vec<String>) -> Result<()> {
    let cwd = std::env::current_dir().context("current directory")?;
    let at = here(&cwd)?;
    let files = SessionFiles::new(&at.git_dir);
    let reads = files.reads()?;
    let remote = push_remote(&at.git, &args);
    let remote_url = at
        .git
        .run(&["remote", "get-url", "--push", &remote])
        .unwrap_or_else(|_| remote.clone());
    // The helper declares the recorded reads itself and clears them after the push.
    let helper = remote_url.starts_with("yoneda:");
    if !helper && !reads.is_empty() && !url::is_platform(&remote_url) {
        return Err(Error::usage(format!(
            "{remote} is not a YonedaRepo remote, and declared reads go only to the platform: use git push"
        )));
    }
    let options = if helper {
        Vec::new()
    } else {
        push_options(&reads).map_err(Error::new)?
    };
    let before = tracking(&at.git, &remote);
    let mut command = std::process::Command::new("git");
    command.arg("push");
    for option in &options {
        command.args(["-o", option]);
    }
    let status = command
        .args(&args)
        .current_dir(&cwd)
        .status()
        .context("running git push")?;
    if !status.success() {
        return Err(Error {
            message: "git push failed; the declared reads are kept for the next push".into(),
            exit_code: status.code().unwrap_or(1),
        });
    }
    if helper {
        return Ok(());
    }
    let tips: Vec<String> = tracking(&at.git, &remote)
        .into_iter()
        .filter(|(r, c)| before.get(r) != Some(c))
        .map(|(_, c)| c)
        .collect();
    let olds: Vec<String> = before.into_values().collect();
    let commits = pushed_commits(&at.git, &tips, &olds);
    files.note_pushed(&commits, &reads, current_session().as_deref())?;
    if !reads.is_empty() {
        files.clear_reads()?;
        eprintln!("yoneda: the push declared {} read(s); cleared", reads.len());
    }
    Ok(())
}

/// The commits a push sent: its new tips and what they reach that `known` (the remote's
/// refs before it) did not, newest first, at most 100.
pub fn pushed_commits(git: &Git, tips: &[String], known: &[String]) -> Vec<String> {
    if tips.is_empty() {
        return Vec::new();
    }
    let mut args = vec!["rev-list", "--max-count=100"];
    args.extend(tips.iter().map(String::as_str));
    let excluded: Vec<String> = known.iter().map(|c| format!("^{c}")).collect();
    args.extend(excluded.iter().map(String::as_str));
    let mut commits: Vec<String> = git
        .run(&args)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect();
    for tip in tips {
        if !commits.contains(tip) {
            commits.push(tip.clone());
        }
    }
    commits
}

/// The commit `given` names, default HEAD.
fn commit_of(given: Option<String>) -> Result<String> {
    let cwd = std::env::current_dir().context("current directory")?;
    let spec = given.unwrap_or_else(|| "HEAD".into());
    if spec.len() == 40 && spec.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(spec);
    }
    Git::new(&cwd).commit_of(&spec)
}

pub async fn session(target: &Target, command: SessionCommand) -> Result<()> {
    let resolved = target::resolve(target)?;
    match command {
        SessionCommand::Record {
            commit,
            cli,
            summary,
            model,
            transcript_ref,
            session_id,
        } => {
            let commit = commit_of(commit)?;
            let body = json!({ "cli": cli, "summary": summary, "model": model,
                               "transcript_ref": transcript_ref,
                               "session_id": session_id.or_else(current_session) });
            let posted = resolved
                .api
                .post(&format!("/commits/{commit}/sessions"), &body)
                .await?;
            println!("Recorded session {} for {commit}", posted["session"]);
        }
        SessionCommand::List { commit } => {
            let commit = commit_of(commit)?;
            let listed = resolved
                .api
                .get(&format!("/commits/{commit}/sessions"))
                .await?;
            let sessions = listed["sessions"].as_array().cloned().unwrap_or_default();
            if sessions.is_empty() {
                println!("No session recorded for {commit}");
            }
            for s in sessions {
                let text = |k: &str| s[k].as_str().unwrap_or_default().to_owned();
                println!(
                    "{} {} by {}",
                    text("cli"),
                    text("model"),
                    text("recorded_by")
                );
                println!("  {}", text("summary").replace('\n', "\n  "));
            }
        }
    }
    Ok(())
}

/// The body a session record posts (shared with the agent hooks).
pub fn record_body(
    cli: &str,
    model: Option<&str>,
    summary: &str,
    prompt_digest: Option<&str>,
    transcript_ref: Option<&str>,
    read_set_digest: Option<&str>,
    session_id: Option<&str>,
) -> Value {
    json!({ "cli": cli, "model": model, "summary": summary, "prompt_digest": prompt_digest,
            "transcript_ref": transcript_ref, "read_set_digest": read_set_digest,
            "session_id": session_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_become_work_tree_relative_entries() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let top = dir.path().join("repo");
        std::fs::create_dir_all(top.join("src/deep")).context("mkdir")?;
        std::fs::create_dir_all(top.join(".git")).context("mkdir")?;
        std::fs::write(top.join("src/a.rs"), "").context("write")?;
        let sub = top.join("src");
        assert_eq!(relative(&top, &sub, "a.rs").as_deref(), Some("src/a.rs"));
        assert_eq!(
            relative(
                &top,
                &sub,
                top.join("src/a.rs").to_str().unwrap_or_default()
            )
            .as_deref(),
            Some("src/a.rs")
        );
        assert_eq!(
            relative(&top, &top, "src/deep").as_deref(),
            Some("src/deep/")
        );
        assert_eq!(relative(&top, &top, "new.txt").as_deref(), Some("new.txt"));
        assert_eq!(relative(&top, &sub, "../../outside"), None);
        assert_eq!(relative(&top, &top, ".git/config"), None);
        assert_eq!(relative(&top, &top, "."), None);
        Ok(())
    }

    #[test]
    fn finds_the_remote_a_push_goes_to() {
        let git = Git::new(std::env::temp_dir());
        let args = |list: &[&str]| list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            push_remote(&git, &args(&["-o", "x", "--force", "up", "main"])),
            "up"
        );
        assert_eq!(push_remote(&git, &args(&["--force"])), "origin");
    }
}
