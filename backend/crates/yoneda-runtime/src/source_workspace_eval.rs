//! Evaluation-only ephemeral copy-on-write. Never sends source mutations or produces a seal.
#[path = "source_workspace_eval_mutations.rs"]
mod mutations;
use crate::source_client::{
    SOURCE_FILE_MAX, SOURCE_READ_MAX, SourceBackend, SourceChange, SourceNode, SourceSlice, failure,
};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Seek, SeekFrom},
    sync::{Arc, Mutex},
};
use yoneda_agents_core::Result;
#[derive(Clone)]
struct Entry {
    node: SourceNode,
    file: Option<Arc<tempfile::TempPath>>,
    origin: Option<(String, u64)>,
}
struct State {
    entries: BTreeMap<String, Option<Entry>>,
    version: u64,
}
pub struct EvaluationSource {
    base: Arc<dyn SourceBackend>,
    scratch: tempfile::TempDir,
    state: Mutex<State>,
}
impl EvaluationSource {
    pub fn new(base: Arc<dyn SourceBackend>) -> Result<Arc<Self>> {
        let scratch = tempfile::Builder::new()
            .prefix("yoneda-evaluation-cow-")
            .tempdir()
            .map_err(|e| crate::source_client::io_failure("Evaluation scratch unavailable", &e))?;
        Ok(Arc::new(Self {
            base,
            scratch,
            state: Mutex::new(State {
                entries: BTreeMap::new(),
                version: 0,
            }),
        }))
    }
    fn stat_locked(&self, state: &State, path: &str) -> Result<SourceNode> {
        if let Some(entry) = state.entries.get(path) {
            return entry
                .as_ref()
                .map(|entry| entry.node.clone())
                .ok_or_else(|| failure("SOURCE_NOT_FOUND", "Evaluation path deleted"));
        }
        match self.base.stat(path) {
            Err(error)
                if error.code == "SOURCE_NOT_FOUND"
                    && state.entries.iter().any(|(name, entry)| {
                        name.starts_with(&format!("{path}/")) && entry.is_some()
                    }) =>
            {
                Ok(SourceNode {
                    path: path.into(),
                    version: state.version,
                    mode: 0o040755,
                    size: 0,
                })
            }
            Ok(mut node) if node.directory() => {
                node.version = state.version;
                Ok(node)
            }
            result => result,
        }
    }
    fn bytes_locked(&self, state: &State, node: &SourceNode, length: u64) -> Result<Vec<u8>> {
        if node.directory() {
            return Err(failure("SOURCE_IS_DIRECTORY", "Not an evaluation file"));
        }
        if length > SOURCE_FILE_MAX {
            return Err(failure("SOURCE_LIMIT", "Evaluation file exceeds limit"));
        }
        let mut bytes = Vec::new();
        while (bytes.len() as u64) < length {
            let limit = (length - bytes.len() as u64).min(SOURCE_READ_MAX as u64) as usize;
            let chunk = self.read_locked(state, node, bytes.len() as u64, limit)?;
            if chunk.bytes.len() != limit {
                return Err(failure("SOURCE_FENCED", "Evaluation range changed"));
            }
            bytes.extend_from_slice(&chunk.bytes);
        }
        Ok(bytes)
    }
    fn read_locked(
        &self,
        state: &State,
        node: &SourceNode,
        offset: u64,
        length: usize,
    ) -> Result<SourceSlice> {
        let entry = state
            .entries
            .get(&node.path)
            .and_then(|value| value.as_ref());
        if let Some(path) = entry.and_then(|entry| entry.file.as_ref()) {
            let mut file = fs::File::open(path.as_ref()).map_err(|e| {
                crate::source_client::io_failure("Evaluation scratch read failed", &e)
            })?;
            file.seek(SeekFrom::Start(offset)).map_err(|e| {
                crate::source_client::io_failure("Evaluation scratch seek failed", &e)
            })?;
            let length = length.min(node.size.saturating_sub(offset) as usize);
            let mut bytes = vec![0; length];
            file.read_exact(&mut bytes).map_err(|e| {
                crate::source_client::io_failure("Evaluation scratch range failed", &e)
            })?;
            return Ok(SourceSlice {
                version: node.version,
                offset,
                bytes,
            });
        }
        let (path, version) = entry
            .and_then(|entry| entry.origin.as_ref())
            .map_or((node.path.as_str(), node.version), |(path, version)| {
                (path.as_str(), *version)
            });
        let mut slice = self.base.read(path, version, offset, length)?;
        if slice.version != version || slice.offset != offset || slice.bytes.len() > length {
            return Err(failure("SOURCE_FENCED", "Evaluation base range changed"));
        }
        slice.version = node.version;
        Ok(slice)
    }
    fn metadata(
        &self,
        state: &mut State,
        before: &SourceNode,
        path: &str,
        mode: u32,
    ) -> Result<SourceNode> {
        let mut entry = state
            .entries
            .get(&before.path)
            .and_then(|value| value.as_ref())
            .cloned()
            .unwrap_or(Entry {
                node: before.clone(),
                file: None,
                origin: Some((before.path.clone(), before.version)),
            });
        entry.node.path = path.into();
        entry.node.mode = mode;
        entry.node.version = state.version;
        let node = entry.node.clone();
        state.entries.insert(path.into(), Some(entry));
        Ok(node)
    }
    fn save(&self, state: &mut State, path: &str, mode: u32, bytes: &[u8]) -> Result<SourceNode> {
        let total: u64 = state
            .entries
            .iter()
            .filter(|(name, _)| name.as_str() != path)
            .filter_map(|(_, entry)| entry.as_ref().map(|entry| entry.node.size))
            .sum();
        if bytes.len() as u64 > SOURCE_FILE_MAX
            || total + bytes.len() as u64 > 100 * 1024 * 1024
            || state.entries.len() >= 10_000
        {
            return Err(failure("SOURCE_LIMIT", "Evaluation scratch exceeds limit"));
        }
        use std::io::Write;
        let mut temp = tempfile::NamedTempFile::new_in(self.scratch.path())
            .map_err(|e| crate::source_client::io_failure("Evaluation scratch unavailable", &e))?;
        temp.write_all(bytes)
            .and_then(|_| temp.as_file().sync_all())
            .map_err(|e| {
                crate::source_client::io_failure("Evaluation scratch commit failed", &e)
            })?;
        // Shared only during metadata moves; the final reference removes obsolete bytes.
        let path_on_disk = Arc::new(temp.into_temp_path());
        let node = SourceNode {
            path: path.into(),
            version: state.version,
            mode,
            size: bytes.len() as u64,
        };
        state.entries.insert(
            path.into(),
            Some(Entry {
                node: node.clone(),
                file: Some(path_on_disk),
                origin: None,
            }),
        );
        Ok(node)
    }
}
impl SourceBackend for EvaluationSource {
    fn stat(&self, path: &str) -> Result<SourceNode> {
        self.stat_locked(
            &*self
                .state
                .lock()
                .map_err(|_| failure("SOURCE_LOCK", "Evaluation lock failed"))?,
            path,
        )
    }
    fn list(&self, path: &str) -> Result<Vec<SourceNode>> {
        let state = self
            .state
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Evaluation lock failed"))?;
        let mut entries: BTreeMap<String, SourceNode> = match self.base.list(path) {
            Ok(nodes) => nodes
                .into_iter()
                .map(|node| (node.path.clone(), node))
                .collect(),
            Err(error) if error.code == "SOURCE_NOT_FOUND" => BTreeMap::new(),
            Err(error) => return Err(error),
        };
        let prefix = if path.is_empty() {
            String::new()
        } else {
            format!("{path}/")
        };
        for (name, entry) in &state.entries {
            if !name.starts_with(&prefix) {
                continue;
            }
            if let Some((directory, _)) = name[prefix.len()..].split_once('/') {
                if entry.is_some() {
                    let child = format!("{prefix}{directory}");
                    entries.entry(child.clone()).or_insert(SourceNode {
                        path: child,
                        version: state.version,
                        mode: 0o040755,
                        size: 0,
                    });
                }
            } else if let Some(entry) = entry {
                entries.insert(name.clone(), entry.node.clone());
            } else {
                entries.remove(name);
            }
        }
        Ok(entries.into_values().collect())
    }
    fn read(&self, path: &str, version: u64, offset: u64, length: usize) -> Result<SourceSlice> {
        let state = self
            .state
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Evaluation lock failed"))?;
        let node = self.stat_locked(&state, path)?;
        if node.version != version {
            return Err(failure("FILE_VERSION_CONFLICT", "Evaluation file changed"));
        }
        if length > SOURCE_READ_MAX {
            return Err(failure("SOURCE_LIMIT", "Evaluation read exceeds limit"));
        }
        self.read_locked(&state, &node, offset, length)
    }

    fn apply(&self, id: &str, change: &SourceChange) -> Result<Option<SourceNode>> {
        mutations::apply(self, id, change)
    }
}

#[cfg(test)]
mod resource_tests {
    use super::*;
    #[test]
    fn overwritten_deleted_and_replaced_cow_files_release_physical_scratch() {
        struct Empty;
        impl SourceBackend for Empty {
            fn stat(&self, _: &str) -> Result<SourceNode> {
                Err(failure("SOURCE_NOT_FOUND", "Empty baseline"))
            }
            fn list(&self, _: &str) -> Result<Vec<SourceNode>> {
                Ok(vec![])
            }
            fn read(&self, _: &str, _: u64, _: u64, _: usize) -> Result<SourceSlice> {
                Err(failure("SOURCE_NOT_FOUND", "Empty baseline"))
            }
            fn apply(&self, _: &str, _: &SourceChange) -> Result<Option<SourceNode>> {
                panic!("Evaluation must never mutate source authority")
            }
        }
        let cow = EvaluationSource::new(Arc::new(Empty)).unwrap();
        let count = || fs::read_dir(cow.scratch.path()).unwrap().count();
        let mut version = cow
            .apply(
                "create",
                &SourceChange::Create {
                    path: "out".into(),
                    mode: 0o100644,
                },
            )
            .unwrap()
            .unwrap()
            .version;
        for _ in 0..8 {
            version = cow
                .apply(
                    "write",
                    &SourceChange::Write {
                        path: "out".into(),
                        expected: version,
                        offset: 0,
                        bytes: vec![0; 65536],
                    },
                )
                .unwrap()
                .unwrap()
                .version;
            assert_eq!(
                count(),
                1,
                "Old physical files must not accumulate per save"
            );
        }
        cow.apply(
            "delete",
            &SourceChange::Delete {
                path: "out".into(),
                expected: version,
            },
        )
        .unwrap();
        assert_eq!(count(), 0);
        let left = cow
            .apply(
                "left",
                &SourceChange::Create {
                    path: "left".into(),
                    mode: 0o100644,
                },
            )
            .unwrap()
            .unwrap();
        let right = cow
            .apply(
                "right",
                &SourceChange::Create {
                    path: "right".into(),
                    mode: 0o100644,
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(count(), 2);
        let moved = cow
            .apply(
                "replace",
                &SourceChange::Rename {
                    path: "left".into(),
                    expected: left.version,
                    target: "right".into(),
                    target_expected: Some(right.version),
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(count(), 1);
        assert_eq!(cow.read("right", moved.version, 0, 1).unwrap().bytes, b"");
        cow.apply(
            "remove",
            &SourceChange::Delete {
                path: "right".into(),
                expected: moved.version,
            },
        )
        .unwrap();
        assert_eq!(count(), 0);
    }
}
