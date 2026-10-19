//! Undeltified pack v2: the smallest pack Git's receive-pack accepts, so the server can
//! push freshly built objects to Artifacts without a Git CLI.
use super::{ObjectKind, invalid};
use crate::Result;
use miniz_oxide::{
    DataFormat, MZFlush, MZStatus,
    deflate::compress_to_vec_zlib,
    inflate::stream::{InflateState, inflate},
};
use sha1::{Digest, Sha1};

#[derive(Clone, Copy, Debug)]
pub struct PackLimits {
    pub max_objects: u32,
    pub max_object_bytes: usize,
    pub max_total_bytes: usize,
}

impl Default for PackLimits {
    fn default() -> Self {
        Self {
            max_objects: 100_000,
            max_object_bytes: 32 * 1024 * 1024,
            max_total_bytes: 256 * 1024 * 1024,
        }
    }
}

pub fn write_pack(objects: &[(ObjectKind, &[u8])]) -> Result<Vec<u8>> {
    let count = u32::try_from(objects.len()).map_err(|_| invalid("Too many pack objects"))?;
    let mut out = b"PACK".to_vec();
    out.extend_from_slice(&2u32.to_be_bytes());
    out.extend_from_slice(&count.to_be_bytes());
    for (kind, data) in objects {
        let mut size = data.len();
        let mut byte = (kind.pack_code() << 4) | (size & 15) as u8;
        size >>= 4;
        while size > 0 {
            out.push(byte | 0x80);
            byte = (size & 0x7f) as u8;
            size >>= 7;
        }
        out.push(byte);
        out.extend_from_slice(&compress_to_vec_zlib(data, 6));
    }
    let trailer: [u8; 20] = Sha1::digest(&out).into();
    out.extend_from_slice(&trailer);
    Ok(out)
}

/// Reads an undeltified pack, verifying the trailer checksum and every size limit.
pub fn read_pack(bytes: &[u8], limits: PackLimits) -> Result<Vec<(ObjectKind, Vec<u8>)>> {
    if bytes.len() < 32 || &bytes[..4] != b"PACK" {
        return Err(invalid("Not a pack"));
    }
    let (body, trailer) = bytes.split_at(bytes.len() - 20);
    if Sha1::digest(body).as_slice() != trailer {
        return Err(invalid("Pack checksum mismatch"));
    }
    if body[4..8] != 2u32.to_be_bytes() {
        return Err(invalid("Only pack version 2 is accepted"));
    }
    let count = u32::from_be_bytes([body[8], body[9], body[10], body[11]]);
    if count > limits.max_objects {
        return Err(invalid("Pack exceeds object limit"));
    }
    let mut at = 12;
    let mut total = 0usize;
    let mut objects = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let mut byte = *body
            .get(at)
            .ok_or_else(|| invalid("Truncated pack header"))?;
        at += 1;
        let kind = ObjectKind::from_pack_code((byte >> 4) & 7)?;
        let mut size = (byte & 15) as usize;
        let mut shift = 4;
        while byte & 0x80 != 0 {
            byte = *body.get(at).ok_or_else(|| invalid("Truncated pack size"))?;
            at += 1;
            if shift > 56 {
                return Err(invalid("Pack object size overflows"));
            }
            size |= ((byte & 0x7f) as usize) << shift;
            shift += 7;
        }
        total = total.saturating_add(size);
        if size > limits.max_object_bytes || total > limits.max_total_bytes {
            return Err(invalid("Pack exceeds size limit"));
        }
        let (data, consumed) = inflate_exact(&body[at..], size)?;
        at += consumed;
        objects.push((kind, data));
    }
    if at != body.len() {
        return Err(invalid("Pack has trailing bytes"));
    }
    Ok(objects)
}

fn inflate_exact(input: &[u8], size: usize) -> Result<(Vec<u8>, usize)> {
    let mut state = InflateState::new_boxed(DataFormat::Zlib);
    // One spare byte detects a stream that inflates past its declared size.
    let mut out = vec![0u8; size + 1];
    let result = inflate(&mut state, input, &mut out, MZFlush::Finish);
    if result.status != Ok(MZStatus::StreamEnd) || result.bytes_written != size {
        return Err(invalid("Pack object does not inflate to its declared size"));
    }
    out.truncate(size);
    Ok((out, result.bytes_consumed))
}
