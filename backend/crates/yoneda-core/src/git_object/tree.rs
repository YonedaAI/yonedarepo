use super::{ObjectId, invalid};
use crate::Result;
use std::collections::BTreeSet;

pub const MAX_TREE_ENTRIES: usize = 100_000;

/// Git tree entry modes. Only canonical spellings are accepted so decode/encode is lossless.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileMode {
    Tree,
    Blob,
    Executable,
    Symlink,
    Gitlink,
}

impl FileMode {
    pub fn bits(self) -> u32 {
        match self {
            Self::Tree => 0o040000,
            Self::Blob => 0o100644,
            Self::Executable => 0o100755,
            Self::Symlink => 0o120000,
            Self::Gitlink => 0o160000,
        }
    }
    pub fn is_tree(self) -> bool {
        self == Self::Tree
    }
    fn text(self) -> &'static [u8] {
        match self {
            Self::Tree => b"40000",
            Self::Blob => b"100644",
            Self::Executable => b"100755",
            Self::Symlink => b"120000",
            Self::Gitlink => b"160000",
        }
    }
    fn parse(text: &[u8]) -> Result<Self> {
        [
            Self::Tree,
            Self::Blob,
            Self::Executable,
            Self::Symlink,
            Self::Gitlink,
        ]
        .into_iter()
        .find(|mode| mode.text() == text)
        .ok_or_else(|| invalid("Non-canonical or unsupported tree entry mode"))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeEntry {
    pub name: String,
    pub mode: FileMode,
    pub id: ObjectId,
}

pub(crate) fn validate_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 4096
        || matches!(name, "." | "..")
        || name.eq_ignore_ascii_case(".git")
        || name.bytes().any(|b| b == b'/' || b == 0)
    {
        return Err(invalid(format!("Invalid tree entry name {name:?}")));
    }
    Ok(())
}

// Git orders a directory as if its name ends in '/'.
fn sort_key(entry: &TreeEntry) -> Vec<u8> {
    let mut key = entry.name.as_bytes().to_vec();
    if entry.mode.is_tree() {
        key.push(b'/');
    }
    key
}

/// Encodes entries in canonical Git order; rejects duplicates and unsafe names.
pub fn encode_tree(entries: &[TreeEntry]) -> Result<Vec<u8>> {
    if entries.len() > MAX_TREE_ENTRIES {
        return Err(invalid("Tree exceeds entry limit"));
    }
    let mut names = BTreeSet::new();
    for entry in entries {
        validate_name(&entry.name)?;
        if !names.insert(entry.name.as_str()) {
            return Err(invalid(format!("Duplicate tree entry {:?}", entry.name)));
        }
    }
    let mut sorted: Vec<&TreeEntry> = entries.iter().collect();
    sorted.sort_by_cached_key(|entry| sort_key(entry));
    let mut out = Vec::with_capacity(entries.len() * 40);
    for entry in sorted {
        out.extend_from_slice(entry.mode.text());
        out.push(b' ');
        out.extend_from_slice(entry.name.as_bytes());
        out.push(0);
        out.extend_from_slice(entry.id.as_bytes());
    }
    Ok(out)
}

/// Decodes a tree, requiring canonical order and UTF-8 names so the bytes re-encode exactly.
pub fn decode_tree(mut data: &[u8]) -> Result<Vec<TreeEntry>> {
    let mut entries = Vec::new();
    while !data.is_empty() {
        if entries.len() >= MAX_TREE_ENTRIES {
            return Err(invalid("Tree exceeds entry limit"));
        }
        let space = data
            .iter()
            .position(|&b| b == b' ')
            .ok_or_else(|| invalid("Truncated tree entry mode"))?;
        let mode = FileMode::parse(&data[..space])?;
        let rest = &data[space + 1..];
        let nul = rest
            .iter()
            .position(|&b| b == 0)
            .ok_or_else(|| invalid("Truncated tree entry name"))?;
        let name = std::str::from_utf8(&rest[..nul])
            .map_err(|_| invalid("Tree entry names must be UTF-8"))?
            .to_owned();
        let id_bytes: [u8; 20] = rest
            .get(nul + 1..nul + 21)
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| invalid("Truncated tree entry id"))?;
        entries.push(TreeEntry {
            name,
            mode,
            id: ObjectId::from_bytes(id_bytes),
        });
        data = &rest[nul + 21..];
    }
    // Validates names and duplicates; strict ordering below makes re-encoding byte-identical.
    encode_tree(&entries)?;
    let keys = entries.iter().map(sort_key).collect::<Vec<_>>();
    if !keys.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(invalid("Tree entries are not in canonical Git order"));
    }
    Ok(entries)
}
