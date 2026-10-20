//! A landing refused with CONFLICT: the three sides of each conflicting file are written
//! to `.yoneda/conflicts/<path>.{base,ours,theirs}` (ours = this checkout, theirs = the
//! branch's latest version, base = the synced base) and the command exits with code 2.
use crate::api::Failure;
use crate::checkout::Checkout;
use crate::error::{Context, Error, Result};
use crate::git::Git;
use crate::state::DIR;
use std::path::{Path, PathBuf};

/// One file's three sides (`None`: the file is absent on that side).
#[derive(Debug, Default)]
pub struct Sides {
    pub base: Option<Vec<u8>>,
    pub ours: Option<Vec<u8>>,
    pub theirs: Option<Vec<u8>>,
}

impl Sides {
    /// Both sides changed the file since the base, differently.
    pub fn conflicting(&self) -> bool {
        self.ours != self.base && self.theirs != self.base && self.ours != self.theirs
    }
}

/// Writes the sides of `path` under `dir`; returns the files written.
pub fn write_sides(dir: &Path, path: &str, sides: &Sides) -> Result<Vec<PathBuf>> {
    let mut written = Vec::new();
    for (suffix, content) in [
        ("base", &sides.base),
        ("ours", &sides.ours),
        ("theirs", &sides.theirs),
    ] {
        let Some(content) = content else { continue };
        let file = dir.join(format!("{path}.{suffix}"));
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).context(format!("creating {}", parent.display()))?;
        }
        std::fs::write(&file, content).context(format!("writing {}", file.display()))?;
        written.push(file);
    }
    Ok(written)
}

/// The file at `commit`, or `None` when it does not exist there.
fn file_at(git: &Git, commit: &str, path: &str) -> Result<Option<Vec<u8>>> {
    let spec = format!("{commit}:{path}");
    if !git.succeeds(&["cat-file", "-e", &spec]) {
        return Ok(None);
    }
    git.output(&["cat-file", "blob", &spec], None, &[])
        .map(Some)
}

/// Paths the platform named, else every locally changed path (an answer without
/// details is narrowed to the paths that really differ on all three sides).
fn candidates(co: &Checkout, failure: &Failure) -> Result<(Vec<String>, bool)> {
    let named: Vec<String> = failure.details["conflicts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["path"].as_str().map(str::to_owned))
        .collect();
    if !named.is_empty() {
        return Ok((named, true));
    }
    let out = co.git.output(
        &[
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            &co.state.local_base,
            "HEAD",
        ],
        None,
        &[],
    )?;
    let changed = out
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .collect();
    Ok((changed, false))
}

/// Writes the conflict files and returns the error to exit with.
pub async fn report(co: &Checkout, failure: &Failure) -> Result<Error> {
    let dir = co.root.join(DIR).join("conflicts");
    if dir.exists() {
        std::fs::remove_dir_all(&dir).context(format!("clearing {}", dir.display()))?;
    }
    let (paths, named) = candidates(co, failure)?;
    let mut listed = Vec::new();
    for path in paths {
        let sides = Sides {
            base: file_at(&co.git, &co.state.local_base, &path)?,
            ours: file_at(&co.git, "HEAD", &path)?,
            theirs: co.api.file(&co.state.branch, &path).await?,
        };
        if !named && !sides.conflicting() {
            continue;
        }
        write_sides(&dir, &path, &sides)?;
        listed.push(path);
    }
    let shown = dir
        .strip_prefix(&co.root)
        .unwrap_or(&dir)
        .display()
        .to_string();
    Ok(Error::conflict(format!(
        "landing refused: {}\n  conflicting: {}\n  sides written to {shown}/<path>.{{base,ours,theirs}}\n  next: `yoneda pull` (resolve the rebase in Git), then `yoneda sync --land`",
        failure.message,
        if listed.is_empty() {
            "(none identified locally)".to_owned()
        } else {
            listed.join(", ")
        }
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_each_present_side_next_to_a_nested_unicode_path() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let sides = Sides {
            base: Some(b"a\n".to_vec()),
            ours: Some(b"ours\n".to_vec()),
            theirs: None,
        };
        let written = write_sides(dir.path(), "src/ünï/lib.rs", &sides)?;
        assert_eq!(written.len(), 2);
        let ours = std::fs::read(dir.path().join("src/ünï/lib.rs.ours")).context("read")?;
        assert_eq!(ours, b"ours\n");
        assert!(!dir.path().join("src/ünï/lib.rs.theirs").exists());
        Ok(())
    }

    #[test]
    fn a_file_conflicts_only_when_both_sides_changed_it_differently() {
        let side = |s: &str| Some(s.as_bytes().to_vec());
        let sides = |b, o, t| Sides {
            base: side(b),
            ours: side(o),
            theirs: side(t),
        };
        assert!(sides("a", "b", "c").conflicting());
        assert!(!sides("a", "b", "a").conflicting());
        assert!(!sides("a", "a", "c").conflicting());
        assert!(!sides("a", "b", "b").conflicting());
        assert!(
            Sides {
                base: side("a"),
                ours: None,
                theirs: side("c")
            }
            .conflicting()
        );
    }
}
