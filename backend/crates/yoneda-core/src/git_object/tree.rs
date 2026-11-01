use super::{ObjectId, invalid};
use crate::Result;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MAX_TREE_ENTRIES: usize = 100_000;

/// Git tree entry modes. Only canonical spellings are accepted so decode/encode is lossless.
/// JSON forms use the short wire names (`tree`, `blob`, `exec`, `symlink`, `gitlink`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FileMode {
    Tree,
    Blob,
    #[serde(rename = "exec")]
    Executable,
    Symlink,
    Gitlink,
}

impl FileMode {
    /// The wire spelling used by JSON trees, path touches and change records.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tree => "tree",
            Self::Blob => "blob",
            Self::Executable => "exec",
            Self::Symlink => "symlink",
            Self::Gitlink => "gitlink",
        }
    }
    /// Inverse of [`Self::as_str`]; every other spelling is refused.
    pub fn from_wire(kind: &str) -> Result<Self> {
        match kind {
            "tree" => Ok(Self::Tree),
            "blob" => Ok(Self::Blob),
            "exec" => Ok(Self::Executable),
            "symlink" => Ok(Self::Symlink),
            "gitlink" => Ok(Self::Gitlink),
            _ => Err(invalid("Non-canonical or unsupported tree entry mode")),
        }
    }
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
    /// A mode as Git itself reads one: old tools wrote `040000` and `100664`, and those
    /// trees stay in history (pallets/flask holds five).
    fn parse_loose(text: &[u8]) -> Result<Self> {
        let unsupported = || invalid("Unsupported tree entry mode");
        let mut mode: u32 = 0;
        for byte in text {
            if !(b'0'..=b'7').contains(byte) || mode >= 0o1000000 {
                return Err(unsupported());
            }
            mode = mode * 8 + u32::from(byte - b'0');
        }
        match mode & 0o170000 {
            0o040000 => Ok(Self::Tree),
            0o120000 => Ok(Self::Symlink),
            0o160000 => Ok(Self::Gitlink),
            0o100000 if mode & 0o100 != 0 => Ok(Self::Executable),
            0o100000 => Ok(Self::Blob),
            _ => Err(unsupported()),
        }
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
pub fn decode_tree(data: &[u8]) -> Result<Vec<TreeEntry>> {
    let entries = entries_of(data, FileMode::parse)?;
    // Validates names and duplicates; strict ordering below makes re-encoding byte-identical.
    encode_tree(&entries)?;
    let keys = entries.iter().map(sort_key).collect::<Vec<_>>();
    if !keys.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(invalid("Tree entries are not in canonical Git order"));
    }
    Ok(entries)
}

/// Decodes a tree of history already in Git, as Git reads it, to look at and never to write
/// back: what `decode_tree` refuses of a new tree cannot be refused of an old one.
pub fn decode_tree_loose(data: &[u8]) -> Result<Vec<TreeEntry>> {
    entries_of(data, FileMode::parse_loose)
}

fn entries_of(mut data: &[u8], parse: fn(&[u8]) -> Result<FileMode>) -> Result<Vec<TreeEntry>> {
    let mut entries = Vec::new();
    while !data.is_empty() {
        if entries.len() >= MAX_TREE_ENTRIES {
            return Err(invalid("Tree exceeds entry limit"));
        }
        let space = data
            .iter()
            .position(|&b| b == b' ')
            .ok_or_else(|| invalid("Truncated tree entry mode"))?;
        let mode = parse(&data[..space])?;
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
    Ok(entries)
}

#[cfg(test)]
mod mode_wire_tests {
    use super::{FileMode, decode_tree, decode_tree_loose};

    #[test]
    fn old_trees_read_as_git_reads_them_and_stay_refused_as_new_ones() {
        let id = [7u8; 20];
        let entry = |mode: &str, name: &str| {
            let mut bytes = format!("{mode} {name}\0").into_bytes();
            bytes.extend_from_slice(&id);
            bytes
        };
        let data = [
            entry("100664", "a"),
            entry("100775", "b"),
            entry("040000", "c"),
        ]
        .concat();
        assert!(decode_tree(&data).is_err());
        let read = decode_tree_loose(&data).expect("an old tree");
        let modes: Vec<FileMode> = read.iter().map(|e| e.mode).collect();
        assert_eq!(
            modes,
            [FileMode::Blob, FileMode::Executable, FileMode::Tree]
        );
        assert!(decode_tree_loose(&entry("777777", "a")).is_err());
        assert!(decode_tree_loose(&entry("x", "a")).is_err());
    }

    #[test]
    fn serde_uses_the_same_wire_names_as_as_str() {
        for mode in [
            FileMode::Tree,
            FileMode::Blob,
            FileMode::Executable,
            FileMode::Symlink,
            FileMode::Gitlink,
        ] {
            let json = serde_json::to_string(&mode).unwrap();
            assert_eq!(json, format!("\"{}\"", mode.as_str()));
            assert_eq!(serde_json::from_str::<FileMode>(&json).unwrap(), mode);
            assert_eq!(FileMode::from_wire(mode.as_str()).unwrap(), mode);
        }
    }

    #[test]
    fn from_wire_refuses_non_canonical_spellings() {
        for bad in ["", "100644", "executable", "TREE", "submodule"] {
            assert!(FileMode::from_wire(bad).is_err(), "{bad:?} accepted");
        }
    }
}
