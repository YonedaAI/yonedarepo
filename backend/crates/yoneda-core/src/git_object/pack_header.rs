//! A pack entry's header: its type and inflated size, then for a delta where its base is
//! (an earlier offset or an object id). Sizes are read as u64, so a 32-bit target (Wasm)
//! refuses an oversized entry instead of wrapping.
use super::{ObjectId, ObjectKind, invalid};
use crate::Result;

/// How an entry's content is stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Whole(ObjectKind),
    /// A delta against the entry starting at this pack offset.
    OfsDelta(u64),
    /// A delta against the object with this id (in the same pack: thin packs are refused).
    RefDelta(ObjectId),
}

/// Little-endian base-128 with a continuation bit, `first`'s low `bits` already taken.
fn size(data: &[u8], at: &mut usize, first: u8, bits: u32) -> Result<Option<u64>> {
    let mut value = u64::from(first & ((1 << bits) - 1));
    let (mut byte, mut shift) = (first, bits);
    while byte & 0x80 != 0 {
        let Some(&next) = data.get(*at) else {
            return Ok(None);
        };
        (byte, *at) = (next, *at + 1);
        if shift > 57 {
            return Err(invalid("Pack object size overflows"));
        }
        value |= u64::from(byte & 0x7f) << shift;
        shift += 7;
    }
    Ok(Some(value))
}

/// The header of the entry at pack `offset` (`data` starts there): its kind, inflated
/// size and header length; `None` until all of it has arrived.
pub fn entry_header(data: &[u8], offset: u64) -> Result<Option<(EntryKind, usize, usize)>> {
    let Some(&first) = data.first() else {
        return Ok(None);
    };
    let mut at = 1;
    let Some(declared) = size(data, &mut at, first, 4)? else {
        return Ok(None);
    };
    let size = usize::try_from(declared).map_err(|_| invalid("Pack object is too large"))?;
    let kind = match (first >> 4) & 7 {
        6 => {
            // Offsets use a different varint: big-endian, each continuation adding one.
            let Some(&first) = data.get(at) else {
                return Ok(None);
            };
            at += 1;
            let (mut back, mut byte) = (u64::from(first & 0x7f), first);
            while byte & 0x80 != 0 {
                let Some(&next) = data.get(at) else {
                    return Ok(None);
                };
                (byte, at) = (next, at + 1);
                back = back
                    .checked_add(1)
                    .and_then(|b| b.checked_mul(128))
                    .map(|b| b | u64::from(byte & 0x7f))
                    .ok_or_else(|| invalid("Delta base offset overflows"))?;
            }
            let base = offset
                .checked_sub(back)
                .filter(|b| *b >= 12)
                .ok_or_else(|| invalid("Delta base offset is outside the pack"))?;
            EntryKind::OfsDelta(base)
        }
        7 => {
            let Some(id) = data.get(at..at + 20) else {
                return Ok(None);
            };
            at += 20;
            let mut bytes = [0u8; 20];
            bytes.copy_from_slice(id);
            EntryKind::RefDelta(ObjectId::from_bytes(bytes))
        }
        code => EntryKind::Whole(ObjectKind::from_pack_code(code)?),
    };
    Ok(Some((kind, size, at)))
}
