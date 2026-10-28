//! Writes Git deltas (the instructions `apply_delta` reads), so a fetch can send a file's
//! next version as the bytes that changed. Versions of one file mostly share a prefix and
//! a suffix (an entry added on top of a changelog, a function edited mid-file): those are
//! one copy each, found by comparing bytes; only the middle between them is matched block
//! by block against the base's middle, so a typical edit costs a scan, not an index of the
//! whole base.
use std::collections::HashMap;

/// Bytes a block match covers at least (and the base's index step).
const BLOCK: usize = 16;
/// Bytes one copy instruction carries at most (Git's limit for a 3-byte size field).
const MAX_COPY: usize = 0xff_ffff;
/// Bytes one insert instruction carries at most.
const MAX_INSERT: usize = 0x7f;

fn varint(out: &mut Vec<u8>, mut value: usize) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        out.push(if value > 0 { byte | 0x80 } else { byte });
        if value == 0 {
            return;
        }
    }
}

struct Writer {
    out: Vec<u8>,
    literal: Vec<u8>,
}

impl Writer {
    fn flush(&mut self) {
        for piece in self.literal.chunks(MAX_INSERT) {
            self.out.push(piece.len() as u8);
            self.out.extend_from_slice(piece);
        }
        self.literal.clear();
    }

    fn copy(&mut self, mut offset: usize, mut length: usize) {
        self.flush();
        while length > 0 {
            let size = length.min(MAX_COPY);
            let mut op = 0x80u8;
            let mut fields = Vec::with_capacity(7);
            for (i, byte) in (offset as u32).to_le_bytes().into_iter().enumerate() {
                if byte != 0 {
                    op |= 1 << i;
                    fields.push(byte);
                }
            }
            for (i, byte) in (size as u32).to_le_bytes().into_iter().take(3).enumerate() {
                if byte != 0 {
                    op |= 0x10 << i;
                    fields.push(byte);
                }
            }
            self.out.push(op);
            self.out.extend_from_slice(&fields);
            offset += size;
            length -= size;
        }
    }
}

fn block_key(bytes: &[u8]) -> u128 {
    let mut key = [0u8; BLOCK];
    key.copy_from_slice(&bytes[..BLOCK]);
    u128::from_le_bytes(key)
}

/// A delta turning `base` into `target`, or `None` when it would not be smaller than
/// `limit` bytes (the caller sends the whole object instead). Offsets above 4 GiB are not
/// expressible, so such a base yields `None`.
pub fn encode_delta(base: &[u8], target: &[u8], limit: usize) -> Option<Vec<u8>> {
    if base.len() > u32::MAX as usize {
        return None;
    }
    let prefix = base.iter().zip(target).take_while(|(a, b)| a == b).count();
    let suffix = base[prefix..]
        .iter()
        .rev()
        .zip(target[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let (base_end, target_end) = (base.len() - suffix, target.len() - suffix);
    let mut w = Writer {
        out: Vec::with_capacity(64),
        literal: Vec::new(),
    };
    varint(&mut w.out, base.len());
    varint(&mut w.out, target.len());
    if prefix > 0 {
        w.copy(0, prefix);
    }
    // The base's middle, indexed by aligned block (first occurrence kept).
    let mut index: HashMap<u128, usize> = HashMap::new();
    let mut at = prefix;
    while at + BLOCK <= base_end {
        index.entry(block_key(&base[at..])).or_insert(at);
        at += BLOCK;
    }
    let mut i = prefix;
    while i < target_end {
        let found = (i + BLOCK <= target_end)
            .then(|| index.get(&block_key(&target[i..])))
            .flatten();
        match found {
            Some(&start) => {
                let mut length = BLOCK;
                while start + length < base_end
                    && i + length < target_end
                    && base[start + length] == target[i + length]
                {
                    length += 1;
                }
                w.copy(start, length);
                i += length;
            }
            None => {
                w.literal.push(target[i]);
                i += 1;
            }
        }
        if w.out.len() + w.literal.len() >= limit {
            return None;
        }
    }
    if suffix > 0 {
        w.copy(base_end, suffix);
    }
    w.flush();
    (w.out.len() < limit).then_some(w.out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_object::apply_delta;

    fn round_trip(base: &[u8], target: &[u8]) -> usize {
        let delta = encode_delta(base, target, usize::MAX).unwrap();
        assert_eq!(apply_delta(base, &delta, target.len()).unwrap(), target);
        delta.len()
    }

    #[test]
    fn an_entry_on_top_of_a_changelog_is_a_few_bytes() {
        let old: Vec<u8> = (0..20_000)
            .flat_map(|n| format!("- change {n}\n").into_bytes())
            .collect();
        let mut new = b"## 2.0\n- new entry\n".to_vec();
        new.extend_from_slice(&old);
        assert!(round_trip(&old, &new) < 64);
        // An edit in the middle, and a block moved from the end to the start.
        let mut edited = old.clone();
        edited[100_000..100_010].copy_from_slice(b"0123456789");
        assert!(round_trip(&old, &edited) < 64);
        let mut moved = old[200_000..].to_vec();
        moved.extend_from_slice(&old[..200_000]);
        assert!(round_trip(&old, &moved) < 64);
    }

    #[test]
    fn edge_cases_round_trip() {
        for (base, target) in [
            (&b""[..], &b""[..]),
            (b"", b"abc"),
            (b"abc", b""),
            (b"same", b"same"),
            (b"abcdefghijklmnopqrstuvwxyz", b"xyz"),
        ] {
            round_trip(base, target);
        }
        let big = vec![7u8; MAX_COPY * 2 + 5];
        round_trip(&big, &big);
    }

    #[test]
    fn unrelated_content_is_not_worth_a_delta() {
        let base: Vec<u8> = (0..4096u32).map(|n| (n * 7919 % 251) as u8).collect();
        let target: Vec<u8> = (0..4096u32).map(|n| (n * 104_729 % 241) as u8).collect();
        assert_eq!(encode_delta(&base, &target, target.len() / 2), None);
    }
}
