//! `yoneda repo remote add <remote> [--override] <owner>/<name>`: points a project that already
//! has its history at a repository, as `git remote add` would, once the platform has said the
//! repository is there. A remote that points elsewhere stays unless `--override` says otherwise.
use crate::error::{Error, Result};
use crate::git::Git;
use crate::remote::url::{Spec, id_key};
use crate::remote::{remember_id, resolved};
use crate::{human, output};

pub async fn add(origin: &str, remote: &str, repo: &str, replace: bool) -> Result<()> {
    let cwd = std::env::current_dir().map_err(|e| Error::new(format!("current directory: {e}")))?;
    let git = Git::toplevel(&cwd)
        .map(Git::new)
        .map_err(|_| Error::usage("run this inside a Git repository (git init)"))?;
    let spec = Spec::parse(repo).ok_or_else(|| {
        Error::usage(format!(
            "{repo:?} is not a repository: use <owner>/<name> or a repository id"
        ))
    })?;
    let id = match &spec {
        Spec::Id(_) => None,
        Spec::Named { handle, name } => {
            let found = resolved(origin, handle, name).await?.repo;
            Some((id_key(origin, handle, name), found))
        }
    };
    let url = spec.git_url(origin);
    let current = git.run(&["remote", "get-url", remote]).ok();
    match current.as_deref() {
        None => drop(git.run(&["remote", "add", remote, &url])?),
        Some(same) if same == url => {}
        Some(_) if replace => drop(git.run(&["remote", "set-url", remote, &url])?),
        Some(other) => {
            return Err(Error::usage(format!(
                "{remote} already points at {other}: add --override to replace it"
            )));
        }
    }
    if let Some((key, found)) = id {
        remember_id(&git, &key, &found);
    }
    human!("{remote} now points at {url}");
    human!("next: git push -u {remote} main");
    output::emit(&output::RepoRemote {
        remote: remote.to_owned(),
        url: url.clone(),
        replaced: current.filter(|c| *c != url),
    });
    Ok(())
}
