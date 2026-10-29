//! Lazy clones: a `yoneda::` clone is a Git partial clone by default. Clone and fetch bring
//! commits and trees; Git fetches each blob through the helper the first time it needs
//! one (checkout, diff, blame, cat-file, a build reading files), with `fetch <id> <id>`.
//!
//! Git's own partial-clone configuration decides: `remote.<name>.partialclonefilter` (set
//! by `git clone --filter=…`, or by the helper below) makes the remote lazy, and
//! `yoneda.scope` (repeatable; `yoneda clone --sparse`) narrows the trees to Git's cone
//! sparse-checkout. A fresh repository's first listing (`git clone yoneda::…`) adopts it,
//! unless `yoneda.lazy` is false (`git clone -c yoneda.lazy=false`, `yoneda clone --full`).
//! Git reads the configuration again before it checks out, so the clone's own checkout
//! already fetches lazily.
use super::Session;
use super::fetch::Fetcher;
use crate::error::{Error, Result};
use crate::git::Git;
use crate::snapshot::{self, Filter, normalize_scope};

/// The filter Git uses for this helper's remote fetches.
pub const FILTER_SPEC: &str = "blob:none";

/// The yoneda configuration of one repository and remote.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Config {
    /// `remote.<name>.partialclonefilter` is set: Git treats the remote as its promisor.
    pub partial: bool,
    /// `yoneda.lazy` (unset: true).
    pub lazy: bool,
    pub scope: Vec<String>,
}

impl Config {
    /// Reads the configuration through one `git config` (`remote`: the remote's name).
    pub fn read(git: &Git, remote: Option<&str>) -> Result<Self> {
        let listed = git
            .output(
                &[
                    "config",
                    "-z",
                    "--get-regexp",
                    r"^(yoneda\.(lazy|scope)|remote\..*\.partialclonefilter)$",
                ],
                None,
                &[],
            )
            // Exit status 1: none of them is set.
            .unwrap_or_default();
        Self::parse(&String::from_utf8_lossy(&listed), remote)
    }

    /// `git config -z --get-regexp` output: `key\nvalue\0` records.
    fn parse(listed: &str, remote: Option<&str>) -> Result<Self> {
        let filter_key = remote.map(|r| format!("remote.{r}.partialclonefilter"));
        let mut config = Self {
            lazy: true,
            ..Self::default()
        };
        let mut scope = Vec::new();
        for record in listed.split('\0').filter(|r| !r.is_empty()) {
            let (key, value) = record.split_once('\n').unwrap_or((record, ""));
            match key.to_ascii_lowercase().as_str() {
                "yoneda.lazy" => config.lazy = !matches!(value, "false" | "no" | "off" | "0"),
                "yoneda.scope" => scope.push(value.to_owned()),
                key if filter_key
                    .as_deref()
                    .is_some_and(|f| f.eq_ignore_ascii_case(key)) =>
                {
                    config.partial = !value.is_empty();
                }
                _ => {}
            }
        }
        config.scope = normalize_scope(&scope)?;
        Ok(config)
    }

    /// What this helper fetches: lazily when Git treats the remote as its promisor.
    pub fn filter(&self) -> Filter {
        if self.partial {
            Filter::Lazy {
                scope: self.scope.clone(),
            }
        } else {
            Filter::Full
        }
    }
}

/// Git asked for `filter` (`git clone --filter`, or a fetch from its promisor remote): any
/// spec is served lazily (blobs on demand; Git takes the trees it did not ask for).
pub fn requested(session: &mut Session) {
    if !session.filter.lazy() {
        session.filter = Filter::Lazy {
            scope: session.config.scope.clone(),
        };
    }
}

/// Git 2.44 is the first to honor `GIT_NO_LAZY_FETCH`, which keeps the helper's own
/// lookups from fetching what they ask about.
const LAZY_GIT: (u32, u32) = (2, 44);

/// Whether `git version` output names a Git that lazy clones rely on.
fn lazy_git(version: &str) -> bool {
    let mut numbers = version
        .trim()
        .trim_start_matches("git version ")
        .split(['.', ' '])
        .map(|n| n.parse::<u32>().unwrap_or(0));
    let major = numbers.next().unwrap_or(0);
    let minor = numbers.next().unwrap_or(0);
    (major, minor) >= LAZY_GIT
}

/// Before a fresh repository's first listing (`git clone yoneda::…`): makes it a lazy clone,
/// unless `yoneda.lazy` is false, the remote has no name to configure, or Git is older
/// than 2.44 (that clone stays full).
pub fn adopt(session: &mut Session) -> Result<()> {
    if session.filter.lazy() || !session.config.lazy {
        return Ok(());
    }
    let Some(remote) = session.remote.clone() else {
        return Ok(());
    };
    if !session.git.run(&["for-each-ref", "--count=1"])?.is_empty()
        || !lazy_git(&session.git.run(&["version"])?)
    {
        return Ok(());
    }
    session
        .git
        .run(&["config", &format!("remote.{remote}.promisor"), "true"])?;
    session.git.run(&[
        "config",
        &format!("remote.{remote}.partialclonefilter"),
        FILTER_SPEC,
    ])?;
    session.config.partial = true;
    session.filter = session.config.filter();
    Ok(())
}

/// Brings the objects Git asked for by id that are still absent: blobs and trees alone, a
/// commit with its history.
pub async fn fetch_wanted(session: &mut Session, ids: &[String]) -> Result<()> {
    let ids = session.git.missing(ids)?;
    let filter = if session.filter.lazy() {
        session.filter.clone()
    } else {
        // Git asks by id only from its promisor remote.
        session.config.filter()
    };
    let rest = snapshot::fetch_by_id(&session.api, &session.git, &ids, &filter).await?;
    for id in rest {
        Fetcher::new(&session.api, &session.git, &mut session.map, &filter)
            .local(&id, None)
            .await
            .map_err(|e| Error::new(format!("{id}: {}", e.message)))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_remote_s_partial_clone_and_the_yoneda_settings() -> Result<()> {
        let listed = "remote.origin.partialclonefilter\nblob:none\0yoneda.scope\nsrc/app/\0\
                      yoneda.scope\ndocs\0remote.other.partialclonefilter\nblob:none\0";
        let config = Config::parse(listed, Some("origin"))?;
        assert!(config.partial && config.lazy);
        assert_eq!(config.scope, ["src/app", "docs"]);
        assert_eq!(
            config.filter(),
            Filter::Lazy {
                scope: vec!["src/app".into(), "docs".into()]
            }
        );
        let full = Config::parse("yoneda.lazy\nfalse\0", Some("origin"))?;
        assert!(!full.partial && !full.lazy);
        assert_eq!(full.filter(), Filter::Full);
        assert!(!Config::parse(listed, Some("upstream"))?.partial);
        assert!(!Config::parse(listed, None)?.partial);
        assert!(Config::parse("yoneda.scope\n../x\0", None).is_err());
        Ok(())
    }

    #[test]
    fn lazy_clones_need_git_2_44() {
        for (version, lazy) in [
            ("git version 2.54.0 (Apple Git-157)", true),
            ("git version 2.44.0\n", true),
            ("git version 3.0.1", true),
            ("git version 2.39.5", false),
            ("git version 2.43.0.windows.1", false),
            ("not git", false),
        ] {
            assert_eq!(lazy_git(version), lazy, "{version}");
        }
    }
}
