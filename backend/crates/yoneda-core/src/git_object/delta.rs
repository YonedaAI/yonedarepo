//! Git's delta format (OFS_DELTA and REF_DELTA pack entries): a varint base size and
//! result size, then copy-from-base and insert-literal instructions. Every size and range
//! is checked against the base and the declared result, so a hostile delta cannot read
//! outside its base or grow past its declared size.
use super::invalid;
use crate::Result;

/// A size: little-endian base-128, read as u64 so a 32-bit target refuses, not wraps.
fn varint(delta: &[u8], at: &mut usize) -> Result<usize> {
    let mut value = 0u64;
    let mut shift = 0;
    loop {
        let byte = *delta
            .get(*at)
            .ok_or_else(|| invalid("Truncated delta header"))?;
        *at += 1;
        if shift > 57 {
            return Err(invalid("Delta size overflows"));
        }
        value |= u64::from(byte & 0x7f) << shift;
        shift += 7;
        if byte & 0x80 == 0 {
            return usize::try_from(value).map_err(|_| invalid("Delta size overflows"));
        }
    }
}

/// The result size a delta declares, without applying it (for size limits up front).
pub fn delta_result_size(delta: &[u8]) -> Result<usize> {
    let mut at = 0;
    varint(delta, &mut at)?;
    varint(delta, &mut at)
}

/// Applies `delta` to `base`; refuses results larger than `max`.
pub fn apply_delta(base: &[u8], delta: &[u8], max: usize) -> Result<Vec<u8>> {
    let mut at = 0;
    if varint(delta, &mut at)? != base.len() {
        return Err(invalid("Delta base size does not match its base"));
    }
    let size = varint(delta, &mut at)?;
    if size > max {
        return Err(invalid("Delta result exceeds the object size limit"));
    }
    let mut out = Vec::with_capacity(size);
    while let Some(&op) = delta.get(at) {
        at += 1;
        if op & 0x80 != 0 {
            let mut field = |bits: u8, shift: u32| -> Result<usize> {
                if op & bits == 0 {
                    return Ok(0);
                }
                let byte = *delta
                    .get(at)
                    .ok_or_else(|| invalid("Truncated delta copy"))?;
                at += 1;
                Ok((byte as usize) << shift)
            };
            let offset = field(0x01, 0)? | field(0x02, 8)? | field(0x04, 16)? | field(0x08, 24)?;
            let mut length = field(0x10, 0)? | field(0x20, 8)? | field(0x40, 16)?;
            if length == 0 {
                length = 0x10000;
            }
            let copied = offset
                .checked_add(length)
                .and_then(|end| base.get(offset..end))
                .ok_or_else(|| invalid("Delta copies outside its base"))?;
            out.extend_from_slice(copied);
        } else if op != 0 {
            let inserted = delta
                .get(at..at + op as usize)
                .ok_or_else(|| invalid("Truncated delta insert"))?;
            at += op as usize;
            out.extend_from_slice(inserted);
        } else {
            return Err(invalid("Reserved delta instruction"));
        }
        if out.len() > size {
            return Err(invalid("Delta result exceeds its declared size"));
        }
    }
    if out.len() != size {
        return Err(invalid("Delta result differs from its declared size"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(base: usize, result: usize) -> Vec<u8> {
        let mut out = Vec::new();
        for mut value in [base, result] {
            loop {
                let byte = (value & 0x7f) as u8;
                value >>= 7;
                out.push(if value > 0 { byte | 0x80 } else { byte });
                if value == 0 {
                    break;
                }
            }
        }
        out
    }

    #[test]
    fn copies_and_inserts() {
        let base = b"hello, world";
        let mut delta = header(base.len(), 11);
        delta.extend_from_slice(&[0x80 | 0x01 | 0x10, 7, 5]); // copy "world"
        delta.extend_from_slice(&[6]);
        delta.extend_from_slice(b" again");
        assert_eq!(apply_delta(base, &delta, 1024).unwrap(), b"world again");
        assert_eq!(delta_result_size(&delta).unwrap(), 11);
    }

    #[test]
    fn refuses_hostile_deltas() {
        let base = b"abc";
        let out_of_base = [header(3, 4), vec![0x80 | 0x01 | 0x10, 1, 4]].concat();
        assert!(apply_delta(base, &out_of_base, 1024).is_err());
        let wrong_base = [header(4, 1), vec![1, b'x']].concat();
        assert!(apply_delta(base, &wrong_base, 1024).is_err());
        let too_long = [header(3, 1), vec![2, b'x', b'y']].concat();
        assert!(apply_delta(base, &too_long, 1024).is_err());
        let reserved = [header(3, 1), vec![0]].concat();
        assert!(apply_delta(base, &reserved, 1024).is_err());
        let over_limit = [header(3, 2000), vec![]].concat();
        assert!(apply_delta(base, &over_limit, 1024).is_err());
        assert!(apply_delta(base, &[0x80], 1024).is_err());
    }
}
