//! Empty directories are local metadata; every regular file remains server-authoritative.
use crate::{
    source_client::{SourceNode, failure, validate_path},
    source_workspace::SourceWorkspace,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};
use yoneda_core::Result;

pub struct LocalDirectories {
    source: Arc<SourceWorkspace>,
    paths: Mutex<BTreeSet<String>>,
}
impl LocalDirectories {
    pub fn new(source: Arc<SourceWorkspace>) -> Self {
        Self {
            source,
            paths: Mutex::new(BTreeSet::new()),
        }
    }
    pub fn stat(&self, path: &str) -> Result<SourceNode> {
        match self.source.stat(path) {
            Err(error) if error.code == "SOURCE_NOT_FOUND" => {
                let root = self.source.stat("")?;
                if self
                    .paths
                    .lock()
                    .map_err(|_| failure("SOURCE_LOCK", "Directory metadata lock failed"))?
                    .contains(path)
                {
                    Ok(SourceNode {
                        path: path.into(),
                        version: root.version,
                        mode: 0o040755,
                        size: 0,
                    })
                } else {
                    Err(error)
                }
            }
            result => result,
        }
    }
    pub fn list(&self, path: &str) -> Result<Vec<SourceNode>> {
        if !self.stat(path)?.directory() {
            return Err(failure("SOURCE_NOT_DIRECTORY", "Not a directory"));
        }
        let mut entries: BTreeMap<String, SourceNode> = match self.source.list(path) {
            Ok(items) => items
                .into_iter()
                .map(|node| (node.path.clone(), node))
                .collect(),
            Err(error) if error.code == "SOURCE_NOT_FOUND" => BTreeMap::new(),
            Err(error) => return Err(error),
        };
        let root = self.source.stat("")?;
        for child in self
            .paths
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Directory metadata lock failed"))?
            .iter()
        {
            if parent(child) == path && !entries.contains_key(child) {
                entries.insert(
                    child.clone(),
                    SourceNode {
                        path: child.clone(),
                        version: root.version,
                        mode: 0o040755,
                        size: 0,
                    },
                );
            }
        }
        Ok(entries.into_values().collect())
    }
    pub fn mkdir(&self, path: &str) -> Result<SourceNode> {
        self.writable()?;
        validate_path(path, false)?;
        if !self.stat(parent(path))?.directory() {
            return Err(failure("SOURCE_NOT_DIRECTORY", "Parent is not a directory"));
        }
        match self.stat(path) {
            Ok(_) => return Err(failure("ALREADY_EXISTS", "Directory path already exists")),
            Err(error) if error.code == "SOURCE_NOT_FOUND" => {}
            Err(error) => return Err(error),
        }
        let mut paths = self
            .paths
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Directory metadata lock failed"))?;
        if paths.len() >= 10_000 {
            return Err(failure("SOURCE_LIMIT", "Directory metadata exceeds limit"));
        }
        if !paths.insert(path.into()) {
            return Err(failure("ALREADY_EXISTS", "Directory path already exists"));
        }
        drop(paths);
        self.stat(path)
    }
    pub fn rmdir(&self, path: &str) -> Result<()> {
        self.writable()?;
        validate_path(path, false)?;
        if !self.stat(path)?.directory() {
            return Err(failure("SOURCE_NOT_DIRECTORY", "Not a directory"));
        }
        if !self.list(path)?.is_empty() {
            return Err(failure("SOURCE_NOT_EMPTY", "Directory is not empty"));
        }
        if !self
            .paths
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Directory metadata lock failed"))?
            .remove(path)
        {
            return Err(failure(
                "SOURCE_UNSUPPORTED",
                "Only local empty directories may be removed",
            ));
        }
        Ok(())
    }
    fn writable(&self) -> Result<()> {
        self.source.stat("")?;
        if self.source.read_only() {
            return Err(failure("SOURCE_READ_ONLY", "Source mount is read-only"));
        }
        Ok(())
    }
}
fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}
