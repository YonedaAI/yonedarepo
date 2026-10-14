//! Canonical Git SHA-1 tree records for incremental trusted capture.
use std::{collections::BTreeSet, io};

pub(crate) const MAX_TREE_ENTRIES: usize = 100_000;
const MAX_TREE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TreeEntry {
    pub name: String,
    pub mode: u32,
    pub oid: String,
}

pub(crate) fn validate_oid(oid: &str) -> io::Result<()> {
    if oid.len() != 40
        || !oid
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(io::Error::other(
            "Capture requires a lowercase Git SHA-1 object ID",
        ));
    }
    Ok(())
}

pub(crate) fn encode_tree(entries: &[TreeEntry]) -> io::Result<Vec<u8>> {
    if entries.len() > MAX_TREE_ENTRIES {
        return Err(io::Error::other(
            "Affected directory metadata exceeds entry limit",
        ));
    }
    let mut names = BTreeSet::new();
    let mut size = 0usize;
    for entry in entries {
        if entry.name.is_empty()
            || entry.name.len() > 4096
            || matches!(entry.name.as_str(), "." | "..")
            || entry.name.bytes().any(|b| b == b'/' || b == 0)
            || !names.insert(&entry.name)
        {
            return Err(io::Error::other("Invalid or duplicate Git tree component"));
        }
        if ![0o040000, 0o100644, 0o100755].contains(&entry.mode) {
            return Err(io::Error::other(
                "Nonregular source entry is outside capture capability",
            ));
        }
        validate_oid(&entry.oid)?;
        size = size
            .checked_add(entry.name.len() + 28)
            .ok_or_else(|| io::Error::other("Tree metadata size overflow"))?;
        if size > MAX_TREE_BYTES {
            return Err(io::Error::other(
                "Affected directory metadata exceeds byte limit",
            ));
        }
    }
    let mut sorted = entries.iter().collect::<Vec<_>>();
    // Git compares a directory as if its name ends in '/', not NUL.
    sorted.sort_by_cached_key(|entry| {
        let mut key = entry.name.as_bytes().to_vec();
        key.push(if entry.mode == 0o040000 { b'/' } else { 0 });
        key
    });
    let mut encoded = Vec::with_capacity(size);
    for entry in sorted {
        encoded.extend(format!("{:o} {}\0", entry.mode, entry.name).bytes());
        for offset in (0..40).step_by(2) {
            encoded.push(
                u8::from_str_radix(&entry.oid[offset..offset + 2], 16)
                    .map_err(|_| io::Error::other("Invalid Git tree object ID"))?,
            );
        }
    }
    Ok(encoded)
}
