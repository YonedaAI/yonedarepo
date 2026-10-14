use crate::source_client::{SourceBackend, SourceChange, SourceNode, SourceSlice, failure};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use yoneda_core::Result;

#[derive(Default)]
struct State {
    files: BTreeMap<String, (u64, u32, Vec<u8>)>,
    reads: usize,
    stats: usize,
    mutations: usize,
    bad_slice: bool,
    lose_ack: bool,
    forge_receipt: bool,
}
pub struct MemorySource(Mutex<State>);
impl MemorySource {
    pub fn new() -> Arc<Self> {
        Arc::new(Self(Mutex::new(State {
            files: BTreeMap::from([
                ("app.js".into(), (1, 0o100644, b"old".to_vec())),
                ("other.js".into(), (1, 0o100644, b"two".to_vec())),
            ]),
            ..State::default()
        })))
    }
    pub fn forge_receipt(&self, value: bool) {
        self.0.lock().unwrap().forge_receipt = value;
    }
    pub fn seed(&self, path: &str, bytes: &[u8]) {
        self.0
            .lock()
            .unwrap()
            .files
            .insert(path.into(), (1, 0o100644, bytes.into()));
    }
    pub fn reads(&self) -> usize {
        self.0.lock().unwrap().reads
    }
    pub fn stats(&self) -> usize {
        self.0.lock().unwrap().stats
    }
    pub fn mutations(&self) -> usize {
        self.0.lock().unwrap().mutations
    }
    pub fn bad_slice(&self, value: bool) {
        self.0.lock().unwrap().bad_slice = value;
    }
    pub fn lose_ack(&self, value: bool) {
        self.0.lock().unwrap().lose_ack = value;
    }
    pub fn external_write(&self, path: &str, bytes: &[u8]) {
        let mut state = self.0.lock().unwrap();
        let value = state.files.get_mut(path).unwrap();
        value.0 += 1;
        value.2 = bytes.to_vec();
    }
}
fn node(state: &State, path: &str) -> Result<SourceNode> {
    if path.is_empty() {
        return Ok(SourceNode {
            path: "".into(),
            version: 0,
            mode: 0o040755,
            size: 0,
        });
    }
    if state
        .files
        .keys()
        .any(|name| name.starts_with(&format!("{path}/")))
    {
        return Ok(SourceNode {
            path: path.into(),
            version: 0,
            mode: 0o040755,
            size: 0,
        });
    }
    let (version, mode, bytes) = state
        .files
        .get(path)
        .ok_or_else(|| failure("SOURCE_NOT_FOUND", "Missing source file"))?;
    Ok(SourceNode {
        path: path.into(),
        version: *version,
        mode: *mode,
        size: bytes.len() as u64,
    })
}
impl SourceBackend for MemorySource {
    fn stat(&self, path: &str) -> Result<SourceNode> {
        let mut state = self.0.lock().unwrap();
        state.stats += 1;
        node(&state, path)
    }
    fn list(&self, path: &str) -> Result<Vec<SourceNode>> {
        let state = self.0.lock().unwrap();
        let prefix = if path.is_empty() {
            "".into()
        } else {
            format!("{path}/")
        };
        let mut entries = BTreeMap::new();
        for name in state.files.keys().filter(|name| name.starts_with(&prefix)) {
            let child = name[prefix.len()..].split('/').next().unwrap();
            let child = format!("{prefix}{child}");
            entries.insert(child.clone(), node(&state, &child)?);
        }
        Ok(entries.into_values().collect())
    }

    fn read(&self, path: &str, version: u64, offset: u64, length: usize) -> Result<SourceSlice> {
        let mut state = self.0.lock().unwrap();
        state.reads += 1;
        let (_, _, bytes) = state
            .files
            .get(path)
            .ok_or_else(|| failure("SOURCE_NOT_FOUND", "Missing source file"))?;
        let begin = usize::try_from(offset).unwrap();
        let end = (begin + length).min(bytes.len());
        Ok(SourceSlice {
            version: if state.bad_slice {
                version + 1
            } else {
                version
            },
            offset,
            bytes: bytes[begin..end].to_vec(),
        })
    }
    fn apply(&self, _request_id: &str, change: &SourceChange) -> Result<Option<SourceNode>> {
        let mut state = self.0.lock().unwrap();
        state.mutations += 1;
        let path = change.path();
        let current = state.files.get(path).map(|(version, _, _)| *version);
        let expected = match change {
            SourceChange::Write { expected, .. }
            | SourceChange::Truncate { expected, .. }
            | SourceChange::Mode { expected, .. }
            | SourceChange::Delete { expected, .. }
            | SourceChange::Rename { expected, .. } => Some(*expected),
            SourceChange::Create { .. } => None,
        };
        if current != expected {
            return Err(failure("SOURCE_CAS", "Source version changed"));
        }
        let new_version = current.unwrap_or(0) + 1;
        let mut result_path = path.to_string();
        match change {
            SourceChange::Write { offset, bytes, .. } => {
                let value = state.files.get_mut(path).unwrap();
                value
                    .2
                    .resize(((*offset as usize) + bytes.len()).max(value.2.len()), 0);
                value.2[*offset as usize..*offset as usize + bytes.len()].copy_from_slice(bytes);
                value.0 = new_version;
            }
            SourceChange::Create { mode, .. } => {
                state
                    .files
                    .insert(path.into(), (new_version, *mode, vec![]));
            }
            SourceChange::Truncate { size, .. } => {
                let value = state.files.get_mut(path).unwrap();
                value.2.resize(*size as usize, 0);
                value.0 = new_version;
            }
            SourceChange::Mode { mode, .. } => {
                let value = state.files.get_mut(path).unwrap();
                value.1 = *mode;
                value.0 = new_version;
            }
            SourceChange::Delete { .. } => {
                state.files.remove(path);
                return Ok(None);
            }
            SourceChange::Rename {
                target,
                target_expected,
                ..
            } => {
                if state.files.get(target).map(|(version, _, _)| *version) != *target_expected {
                    return Err(failure("SOURCE_CAS", "Destination changed"));
                }
                let mut value = state.files.remove(path).unwrap();
                value.0 = new_version;
                state.files.insert(target.clone(), value);
                result_path = target.clone();
            }
        }
        if state.lose_ack {
            return Err(failure("SOURCE_UNCERTAIN", "Synthetic lost acknowledgment"));
        }
        Ok(Some(node(
            &state,
            if state.forge_receipt {
                "other.js"
            } else {
                &result_path
            },
        )?))
    }
}
