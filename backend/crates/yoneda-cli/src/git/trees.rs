//! Building trees from changes without an index. Only the trees on changed paths are read:
//! in a lazy clone an index's `git write-tree` checks every blob of the whole tree (and
//! `read-tree` needs every tree), so a push of one edited file would fetch, or fail on,
//! each file it never touched.
use super::Git;
use crate::error::{Error, Result};
use std::cell::RefCell;
use std::collections::HashMap;
use yoneda_core::git_object::{
    Commit, ObjectId, ObjectKind, PathChange, TreeEntry, TreeSource, decode_tree, rewrite_tree,
};

/// Trees built from one repository's trees; the ones it makes stay in memory (nothing is
/// written), so a later change can build on them.
pub struct Trees<'a> {
    git: &'a Git,
    made: RefCell<HashMap<ObjectId, Vec<TreeEntry>>>,
}

impl<'a> Trees<'a> {
    pub fn new(git: &'a Git) -> Self {
        Self {
            git,
            made: RefCell::new(HashMap::new()),
        }
    }

    /// The tree of `treeish` (a commit, or a tree held or made here) with `changes`
    /// applied. Deletes go first, so a file can become a directory and back in one call.
    pub fn with(&self, treeish: &str, changes: &[PathChange]) -> Result<String> {
        let mut root = self.root(treeish)?;
        let (deletes, writes): (Vec<PathChange>, Vec<PathChange>) =
            changes.iter().cloned().partition(|c| c.target.is_none());
        for group in [deletes, writes] {
            if group.is_empty() {
                continue;
            }
            let rewrite = rewrite_tree(Some(root), &group, self)
                .map_err(|e| Error::new(format!("building a tree on {treeish}: {}", e.message)))?;
            let mut made = self.made.borrow_mut();
            for (id, bytes) in rewrite.trees {
                let entries = decode_tree(&bytes)
                    .map_err(|e| Error::new(format!("built tree {}: {}", id.hex(), e.message)))?;
                made.insert(id, entries);
            }
            root = rewrite.root;
        }
        Ok(root.hex())
    }

    /// The tree a commit or tree id names, reading the commit object only.
    fn root(&self, treeish: &str) -> Result<ObjectId> {
        let id = ObjectId::parse(treeish)
            .map_err(|e| Error::new(format!("{treeish}: {}", e.message)))?;
        if self.made.borrow().contains_key(&id) {
            return Ok(id);
        }
        let mut read = self.git.read_objects(&[treeish.to_owned()])?;
        match read.remove(treeish) {
            Some((ObjectKind::Tree, _)) => Ok(id),
            Some((ObjectKind::Commit, data)) => Commit::decode(&data)
                .and_then(|c| c.tree())
                .map_err(|e| Error::new(format!("reading commit {treeish}: {}", e.message))),
            _ => Err(Error::new(format!("{treeish} is not a commit or a tree"))),
        }
    }
}

impl TreeSource for Trees<'_> {
    fn tree(&self, id: &ObjectId) -> yoneda_core::Result<Vec<TreeEntry>> {
        if let Some(entries) = self.made.borrow().get(id) {
            return Ok(entries.clone());
        }
        let hex = id.hex();
        let unreadable =
            |why: String| yoneda_core::Error::new("TREE_UNREADABLE", format!("tree {hex}: {why}"));
        // An absent tree on a changed path (a file moved out of a directory this clone
        // never checked out) is fetched: the commit truly needs it.
        let mut read = self
            .git
            .read_objects(std::slice::from_ref(&hex))
            .map_err(|e| unreadable(e.message))?;
        match read.remove(&hex) {
            Some((ObjectKind::Tree, data)) => decode_tree(&data),
            _ => Err(unreadable("not a tree".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Repo;
    use yoneda_core::git_object::FileMode;

    /// A `--filter=tree:0` clone of a repository (commits only; trees and blobs come on
    /// demand from the original), read as the remote helper reads it (no lazy fetch but
    /// for contents).
    fn lazy_clone(origin: &Repo) -> Result<(tempfile::TempDir, Git)> {
        origin
            .git
            .run(&["config", "uploadpack.allowFilter", "true"])?;
        origin
            .git
            .run(&["config", "uploadpack.allowAnySHA1InWant", "true"])?;
        let dir = tempfile::tempdir().map_err(|e| Error::new(e.to_string()))?;
        let url = format!("file://{}", origin.root().display());
        let path = dir.path().join("lazy");
        let place = path.to_string_lossy().into_owned();
        Git::new(dir.path()).run(&[
            "clone",
            "-q",
            "--no-checkout",
            "--filter=tree:0",
            &url,
            &place,
        ])?;
        Ok((dir, Git::new(path).in_helper(0)))
    }

    #[test]
    fn builds_a_tree_reading_only_the_changed_paths() -> Result<()> {
        let origin = Repo::new()?;
        origin.write("a/f.txt", b"f\n")?;
        origin.write("a/gone.txt", b"gone\n")?;
        origin.write("b/far.txt", b"far\n")?;
        origin.write("c", b"a file that becomes a directory\n")?;
        let base = origin.commit("base")?;
        std::fs::remove_file(origin.path("a/gone.txt")).map_err(|e| Error::new(e.to_string()))?;
        std::fs::remove_file(origin.path("c")).map_err(|e| Error::new(e.to_string()))?;
        origin.write("a/f.txt", b"f edited\n")?;
        origin.write("c/inside.txt", b"inside\n")?;
        let commit = origin.commit("work")?;
        let blob = |path: &str| -> Result<ObjectId> {
            let id = origin
                .git
                .run(&["rev-parse", &format!("{commit}:{path}")])?;
            ObjectId::parse(&id).map_err(|e| Error::new(e.message))
        };
        let changes = [
            PathChange {
                path: "c/inside.txt".into(),
                target: Some((FileMode::Blob, blob("c/inside.txt")?)),
            },
            PathChange {
                path: "a/f.txt".into(),
                target: Some((FileMode::Blob, blob("a/f.txt")?)),
            },
            PathChange {
                path: "a/gone.txt".into(),
                target: None,
            },
            PathChange {
                path: "c".into(),
                target: None,
            },
        ];
        let (_dir, git) = lazy_clone(&origin)?;
        let far = origin
            .git
            .run(&["rev-parse", &format!("{base}:b/far.txt")])?;
        let built = Trees::new(&git).with(&base, &changes);
        // A file the change does not touch is never read. (Git's own lazy fetch of the
        // root tree brings every tree below it from a plain Git server; the helper's
        // sparse scope is tested against the platform.)
        assert_eq!(git.missing(std::slice::from_ref(&far))?, [far]);
        assert_eq!(built?, origin.git.tree_of(&commit)?);
        Ok(())
    }

    #[test]
    fn builds_on_its_own_trees() -> Result<()> {
        let repo = Repo::new()?;
        repo.write("x/one.txt", b"1\n")?;
        let base = repo.commit("base")?;
        repo.write("x/two.txt", b"2\n")?;
        repo.write("y/three.txt", b"3\n")?;
        let commit = repo.commit("two parts")?;
        let blob = |path: &str| -> Result<ObjectId> {
            let id = repo.git.run(&["rev-parse", &format!("{commit}:{path}")])?;
            ObjectId::parse(&id).map_err(|e| Error::new(e.message))
        };
        let trees = Trees::new(&repo.git);
        let first = trees.with(
            &base,
            &[PathChange {
                path: "x/two.txt".into(),
                target: Some((FileMode::Blob, blob("x/two.txt")?)),
            }],
        )?;
        // The first part's tree was never written; the second builds on it from memory.
        assert!(!repo.git.missing(std::slice::from_ref(&first))?.is_empty());
        let second = trees.with(
            &first,
            &[PathChange {
                path: "y/three.txt".into(),
                target: Some((FileMode::Blob, blob("y/three.txt")?)),
            }],
        )?;
        assert_eq!(second, repo.git.tree_of(&commit)?);
        Ok(())
    }
}
