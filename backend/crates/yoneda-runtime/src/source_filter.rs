//! Parse ignore rules without opening an agent-controlled Git repository or following links.
use crate::{err, secure_fs::read_regular};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::path::{Path, PathBuf};
use yoneda_core::{Result, Workspace};

pub(crate) struct SourceFilter {
    root: PathBuf,
    tracked: Vec<String>,
    rules: Vec<(PathBuf, Gitignore)>,
    rule_bytes: usize,
}
impl SourceFilter {
    pub(crate) fn new(root: &Path, baseline: &Workspace) -> Result<Self> {
        let mut defaults = GitignoreBuilder::new(root);
        for line in ["**/target/", "**/node_modules/"] {
            defaults.add_line(None, line).map_err(err)?;
        }
        Ok(Self {
            root: root.into(),
            tracked: baseline.keys().cloned().collect(),
            rules: vec![(root.into(), defaults.build().map_err(err)?)],
            rule_bytes: 0,
        })
    }
    pub(crate) fn allow(&mut self, entry: &walkdir::DirEntry) -> Result<bool> {
        let relative = entry.path().strip_prefix(&self.root).map_err(err)?;
        let path = relative
            .to_str()
            .ok_or_else(|| err("Non-UTF8 source path"))?;
        if path
            .split('/')
            .any(|part| part.eq_ignore_ascii_case(".git"))
        {
            return Ok(false);
        }
        let tracked = self
            .tracked
            .iter()
            .any(|name| name == path || name.starts_with(&format!("{path}/")));
        let mut ignored = false;
        for (root, rules) in &self.rules {
            if entry.path().starts_with(root) && entry.path() != root {
                let matched =
                    rules.matched_path_or_any_parents(entry.path(), entry.file_type().is_dir());
                if matched.is_ignore() {
                    ignored = true;
                }
                if matched.is_whitelist() {
                    ignored = false;
                }
            }
        }
        if ignored && !tracked {
            return Ok(false);
        }
        if entry.file_type().is_dir() {
            let ignore_path = if path.is_empty() {
                ".gitignore".into()
            } else {
                format!("{path}/.gitignore")
            };
            match std::fs::symlink_metadata(self.root.join(&ignore_path)) {
                Ok(_) => {
                    let file = read_regular(&self.root, &ignore_path)?;
                    let bytes = file.bytes()?;
                    self.rule_bytes = self.rule_bytes.saturating_add(bytes.len());
                    if self.rule_bytes > 128 * 1024 {
                        return Err(err("Ignore rules exceed 128 KiB"));
                    }
                    let text = std::str::from_utf8(&bytes).map_err(err)?;
                    let mut builder = GitignoreBuilder::new(entry.path());
                    for line in text.lines() {
                        builder.add_line(None, line).map_err(err)?;
                    }
                    self.rules
                        .push((entry.path().into(), builder.build().map_err(err)?));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(err(error)),
            }
        }
        Ok(true)
    }
}
