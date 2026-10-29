//! `yoneda sparse [--add] <dir>...`: a clone checked out only under these directories (with
//! `--add`, under these as well as the ones it has), and the files at its top (Git's cone-mode sparse checkout with a sparse index, so Git never
//! reads the trees outside them). In a lazy `yoneda::` clone the scope is kept as
//! `yoneda.scope`: the helper's fetches bring only the trees leading to and inside it, and
//! this command first brings the ones a wider scope now needs at the branch tips, so the
//! checkout fetches only the files' contents (one request batch).
use crate::error::{Error, Result};
use crate::git::Git;
use crate::human;
use crate::output::{self, SparseScope};
use crate::remote::{self, url};
use crate::snapshot::{self, Filter};

pub async fn sparse(dirs: &[String], add: bool) -> Result<()> {
    let cwd = std::env::current_dir().map_err(|e| Error::new(format!("current directory: {e}")))?;
    let top = Git::toplevel(&cwd)?;
    let git = Git::new(&top);
    let mut all = Vec::new();
    if add
        && git
            .run(&["config", "--bool", "core.sparseCheckout"])
            .is_ok_and(|on| on == "true")
    {
        all.extend(
            git.run(&["sparse-checkout", "list"])?
                .lines()
                .map(str::to_owned),
        );
    }
    all.extend(dirs.iter().cloned());
    let dirs = snapshot::normalize_scope(&all)?;
    let (name, remote) = yoneda_remote(&git)?;
    let lazy = git
        .run(&["config", &format!("remote.{name}.partialclonefilter")])
        .is_ok_and(|f| !f.is_empty());
    // Exit status 5: no scope set yet.
    let _ = git.run(&["config", "--unset-all", "yoneda.scope"]);
    for dir in &dirs {
        git.run(&["config", "--add", "yoneda.scope", dir])?;
    }
    if lazy {
        let git_dir = git.run(&["rev-parse", "--absolute-git-dir"])?;
        let held = Git::with_git_dir(&top, &git_dir);
        let tips = format!("refs/remotes/{name}/");
        let mut roots: Vec<String> = git
            .run(&["for-each-ref", "--format=%(tree)", &tips])?
            .lines()
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
            .collect();
        roots.extend(
            git.run(&["rev-parse", "--verify", "-q", "HEAD^{tree}"])
                .ok(),
        );
        let filter = Filter::Lazy {
            scope: dirs.clone(),
        };
        snapshot::fetch_trees(&remote::api_for(&remote)?, &held, &roots, &filter).await?;
    }
    check_out(&git, &dirs)?;
    human!(
        "Checked out {} (and the files at the top); `git sparse-checkout disable` restores the rest",
        dirs.join(", ")
    );
    output::emit(&SparseScope { scope: dirs });
    Ok(())
}

/// Git's cone-mode sparse checkout of `dirs`, with the sparse index, at the current branch.
pub fn check_out(git: &Git, dirs: &[String]) -> Result<()> {
    let mut args = vec!["sparse-checkout", "set", "--cone", "--sparse-index"];
    args.extend(dirs.iter().map(String::as_str));
    git.run(&args)?;
    // After `git clone --no-checkout` the branch is not checked out yet.
    if let Ok(branch) = git.run(&["symbolic-ref", "-q", "--short", "HEAD"])
        && git.succeeds(&["rev-parse", "--verify", "-q", "HEAD"])
    {
        git.run(&["checkout", "-q", &branch])?;
    }
    Ok(())
}

/// The clone's `yoneda::` remote (`origin` first): its name and URL.
fn yoneda_remote(git: &Git) -> Result<(String, url::RemoteUrl)> {
    let mut names: Vec<String> = git.run(&["remote"])?.lines().map(str::to_owned).collect();
    names.sort_by_key(|n| n != "origin");
    for name in names {
        let configured = git.run(&["remote", "get-url", &name])?;
        if configured.starts_with("yoneda:")
            && let Ok(parsed) = url::parse(&configured)
        {
            return Ok((name, parsed));
        }
    }
    Err(Error::usage(
        "this clone has no yoneda:: remote; clone with `yoneda clone <repo-id> --sparse <dir,...>`",
    ))
}
