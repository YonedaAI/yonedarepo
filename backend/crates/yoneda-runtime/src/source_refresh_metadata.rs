//! Bounded Git tree metadata walk. No blob/history reads; hash-check every frozen directory.
use crate::{
    source_git::SourceGitObjects,
    source_git_tree::{TreeEntry, encode_tree},
    source_refresh_api::Api,
    source_refresh_plan::{Files, error},
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yoneda_agents_core::Result;
pub(crate) struct Metadata {
    pub files: Files,
    pub directories: BTreeMap<String, Vec<TreeEntry>>,
}
pub(crate) async fn walk(
    api: &Api,
    store: &SourceGitObjects,
    input: &str,
    root: &str,
) -> Result<Metadata> {
    let mut pending = vec![(String::new(), root.to_owned())];
    let mut result = Metadata {
        files: Files::new(),
        directories: BTreeMap::new(),
    };
    let mut count = 0;
    let mut bytes = 0;
    while let Some((path, expected)) = pending.pop() {
        let mut entries = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = api
                .json(
                    "tree",
                    json!({"input":input,"path":path,"cursor":cursor,"limit":200}),
                )
                .await?;
            if page["tree_oid"] != expected {
                return Err(error("Refresh tree identity differs from frozen revision"));
            }
            let rows = page["items"]
                .as_array()
                .filter(|v| v.len() <= 200)
                .ok_or_else(|| error("Refresh metadata page exceeds bound"))?;
            bytes += serde_json::to_vec(rows)
                .map_err(|_| error("Invalid refresh metadata"))?
                .len();
            if bytes > 64 * 1024 * 1024 {
                return Err(error("Refresh metadata exceeds byte bound"));
            }
            for row in rows {
                let name = row["name"]
                    .as_str()
                    .ok_or_else(|| error("Refresh tree name missing"))?;
                let mode = match row["mode"].as_str() {
                    Some("40000" | "040000") => 0o040000,
                    Some("100644") => 0o100644,
                    Some("100755") => 0o100755,
                    _ => return Err(error("Unsupported refresh tree mode")),
                };
                let oid = row["oid"]
                    .as_str()
                    .ok_or_else(|| error("Refresh tree OID missing"))?;
                entries.push(TreeEntry {
                    name: name.into(),
                    mode,
                    oid: oid.into(),
                });
                count += 1;
                if count > 10000 {
                    return Err(error("Refresh tree metadata exceeds 10000 entries"));
                }
            }
            let next = match page.get("next_cursor") {
                Some(Value::Null) => None,
                Some(Value::String(c)) => Some(c.clone()),
                _ => return Err(error("Invalid refresh tree cursor")),
            };
            if next.is_some() && (rows.is_empty() || cursor == next) {
                return Err(error("Refresh tree paging did not advance"));
            }
            cursor = next;
            if cursor.is_none() {
                break;
            }
        }
        let raw = encode_tree(&entries).map_err(|_| error("Invalid refresh Git tree shape"))?;
        if store
            .hash("tree", &raw)
            .map_err(|_| error("Refresh tree hash failed"))?
            != expected
        {
            return Err(error("Refresh metadata differs from frozen Git tree hash"));
        }
        for entry in &entries {
            let full = if path.is_empty() {
                entry.name.clone()
            } else {
                format!("{path}/{}", entry.name)
            };
            yoneda_agents_core::validate_path(&full)?;
            if entry.mode == 0o040000 {
                pending.push((full, entry.oid.clone()));
            } else if result.files.insert(full, entry.clone()).is_some() {
                return Err(error("Duplicate refresh file path"));
            }
        }
        result.directories.insert(path, entries);
    }
    Ok(result)
}
