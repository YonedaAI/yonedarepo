//! Paged frozen ancestor metadata, hash-verified before reuse; no base blob or history reads.
use crate::{
    source_capture_api::{CaptureApi, failure},
    source_git::SourceGitObjects,
    source_git_tree::{MAX_TREE_ENTRIES, TreeEntry, encode_tree, validate_oid},
};
use serde_json::json;
use std::collections::BTreeMap;
use yoneda_agents_core::{Result, source_workspace::SourceRevision};
const METADATA_BYTES: usize = 128 * 1024 * 1024;
pub(crate) struct TreeCache {
    entries: BTreeMap<(Option<String>, String), Vec<TreeEntry>>,
    bytes: usize,
}
impl TreeCache {
    pub fn new() -> Self {
        Self {
            entries: BTreeMap::new(),
            bytes: 0,
        }
    }
    pub async fn directory(
        &mut self,
        api: &CaptureApi,
        objects: &SourceGitObjects,
        path: &str,
        expected: &str,
        input: Option<&str>,
    ) -> Result<Vec<TreeEntry>> {
        validate_oid(expected).map_err(|_| failure("Frozen tree identity is not Git SHA-1"))?;
        let key = (input.map(str::to_owned), path.to_owned());
        if let Some(entries) = self.entries.get(&key) {
            if objects
                .hash(
                    "tree",
                    &encode_tree(entries).map_err(|_| failure("Invalid cached tree metadata"))?,
                )
                .map_err(|_| failure("Tree hash verification failed"))?
                != expected
            {
                return Err(failure("Cached tree belongs to a different frozen input"));
            }
            return Ok(entries.clone());
        }
        let mut cursor: Option<String> = None;
        let mut entries = Vec::new();
        loop {
            let mut args = json!({"path":path,"cursor":cursor,"limit":200});
            if let Some(input) = input {
                args["input"] = json!(input);
            }
            let page = api.json("tree", args).await?;
            if page["tree_oid"].as_str() != Some(expected) {
                return Err(failure("Ancestor page differs from frozen tree identity"));
            }
            let rows = page["items"]
                .as_array()
                .filter(|r| r.len() <= 200)
                .ok_or_else(|| failure("Ancestor metadata page exceeds bound"))?;
            self.bytes = self
                .bytes
                .checked_add(
                    serde_json::to_vec(rows)
                        .map_err(|_| failure("Invalid tree metadata"))?
                        .len(),
                )
                .filter(|b| *b <= METADATA_BYTES)
                .ok_or_else(|| failure("Capture ancestor metadata exceeds bounded cache"))?;
            for row in rows {
                let name = row["name"]
                    .as_str()
                    .ok_or_else(|| failure("Tree entry has no name"))?;
                let mode = match row["mode"].as_str() {
                    Some("40000" | "040000") => 0o040000,
                    Some("100644") => 0o100644,
                    Some("100755") => 0o100755,
                    _ => return Err(failure("Tree contains unsupported source mode")),
                };
                let oid = row["oid"]
                    .as_str()
                    .ok_or_else(|| failure("Tree entry identity missing"))?
                    .to_owned();
                entries.push(TreeEntry {
                    name: name.into(),
                    mode,
                    oid,
                });
            }
            if entries.len() > MAX_TREE_ENTRIES {
                return Err(failure("Affected directory exceeds metadata entry bound"));
            }
            let next = match page.get("next_cursor") {
                Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(s)) => Some(s.clone()),
                _ => return Err(failure("Tree page cursor invalid")),
            };
            if next.is_some() && (rows.is_empty() || next == cursor) {
                return Err(failure("Tree paging did not advance"));
            }
            cursor = next;
            if cursor.is_none() {
                break;
            }
        }
        let raw = encode_tree(&entries)
            .map_err(|_| failure("Ancestor metadata violates canonical Git tree shape"))?;
        if objects
            .hash("tree", &raw)
            .map_err(|_| failure("Ancestor metadata hashing failed"))?
            != expected
        {
            return Err(failure(
                "Ancestor metadata hash differs from frozen Git tree",
            ));
        }
        self.entries.insert(key, entries.clone());
        Ok(entries)
    }
    pub async fn lookup(
        &mut self,
        api: &CaptureApi,
        objects: &SourceGitObjects,
        revision: &SourceRevision,
        path: &str,
        input: Option<&str>,
    ) -> Result<Option<TreeEntry>> {
        yoneda_agents_core::validate_path(path)?;
        let mut directory = String::new();
        let mut tree = revision.tree.clone();
        let parts = path.split('/').collect::<Vec<_>>();
        for (i, name) in parts.iter().enumerate() {
            let entries = self
                .directory(api, objects, &directory, &tree, input)
                .await?;
            let Some(entry) = entries.into_iter().find(|entry| entry.name == *name) else {
                return Ok(None);
            };
            if i + 1 == parts.len() {
                return Ok(Some(entry));
            }
            if entry.mode != 0o040000 {
                return Ok(None);
            }
            directory = if directory.is_empty() {
                (*name).into()
            } else {
                format!("{directory}/{name}")
            };
            tree = entry.oid;
        }
        Err(failure("Invalid frozen path traversal"))
    }
    pub fn base_directory(&self, path: &str) -> std::io::Result<Vec<TreeEntry>> {
        self.entries
            .get(&(None, path.into()))
            .cloned()
            .ok_or_else(|| std::io::Error::other("Affected ancestor metadata was not loaded"))
    }
}
