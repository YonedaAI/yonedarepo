//! Bounded cache keyed by the server's file version, never by path alone.
use std::collections::VecDeque;

#[derive(PartialEq, Eq)]
pub(super) struct Key {
    pub path: String,
    pub version: u64,
    pub offset: u64,
    pub length: usize,
}
pub(super) struct Cache {
    entries: VecDeque<(Key, Vec<u8>)>,
    bytes: usize,
    limit: usize,
}
impl Cache {
    pub fn new(limit: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            bytes: 0,
            limit,
        }
    }
    pub fn get(&mut self, key: &Key) -> Option<Vec<u8>> {
        let index = self
            .entries
            .iter()
            .position(|(candidate, _)| candidate == key)?;
        let entry = self.entries.remove(index)?;
        let result = entry.1.clone();
        self.entries.push_back(entry);
        Some(result)
    }
    pub fn put(&mut self, key: Key, bytes: Vec<u8>) {
        if bytes.len() > self.limit {
            return;
        }
        self.entries.retain(|(candidate, _)| {
            candidate != &key && (candidate.path != key.path || candidate.version == key.version)
        });
        self.bytes = self.entries.iter().map(|(_, value)| value.len()).sum();
        while self.bytes + bytes.len() > self.limit {
            if let Some((_, evicted)) = self.entries.pop_front() {
                self.bytes -= evicted.len();
            } else {
                break;
            }
        }
        self.bytes += bytes.len();
        self.entries.push_back((key, bytes));
    }
    pub fn invalidate(&mut self, path: &str) {
        self.entries
            .retain(|(key, _)| key.path != path && !key.path.starts_with(&format!("{path}/")));
        self.bytes = self.entries.iter().map(|(_, value)| value.len()).sum();
    }
    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }
}
