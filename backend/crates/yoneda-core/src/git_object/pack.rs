//! Pack v2: undeltified, the smallest pack Git's receive-pack accepts, so the server can
//! push freshly built objects to Artifacts without a Git CLI; a fetch's pack may also
//! carry REF_DELTA entries against objects in the same pack.
use super::{ObjectId, ObjectKind, invalid};
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
    let (mut writer, mut out) = PackWriter::new(count);
    for (kind, data) in objects {
        out.extend(writer.entry(*kind, data));
    }
    out.extend_from_slice(&writer.finish());
    Ok(out)
}

/// Writes an undeltified pack piece by piece (header, each entry, trailer), so a large
/// pack streams out without being held whole.
pub struct PackWriter {
    hasher: Sha1,
}

impl PackWriter {
    /// The writer and the pack header for `count` entries.
    pub fn new(count: u32) -> (Self, Vec<u8>) {
        let mut header = b"PACK".to_vec();
        header.extend_from_slice(&2u32.to_be_bytes());
        header.extend_from_slice(&count.to_be_bytes());
        let mut hasher = Sha1::new();
        hasher.update(&header);
        (Self { hasher }, header)
    }

    /// One whole object, zlib-compressed.
    pub fn entry(&mut self, kind: ObjectKind, data: &[u8]) -> Vec<u8> {
        let mut out = entry_header(kind.pack_code(), data.len());
        out.extend_from_slice(&compress_to_vec_zlib(data, 6));
        self.hasher.update(&out);
        out
    }

    /// One object as `delta` (see `encode_delta`) against `base`, which must be in the
    /// same pack (REF_DELTA: Git resolves it by id, wherever the base is).
    pub fn delta_entry(&mut self, base: &ObjectId, delta: &[u8]) -> Vec<u8> {
        let mut out = entry_header(7, delta.len());
        out.extend_from_slice(base.as_bytes());
        out.extend_from_slice(&compress_to_vec_zlib(delta, 6));
        self.hasher.update(&out);
        out
    }

    /// The trailer: SHA-1 of everything written before it.
    pub fn finish(self) -> [u8; 20] {
        self.hasher.finalize().into()
    }
}

/// An entry's type and size header.
fn entry_header(code: u8, mut size: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(size / 2 + 32);
    let mut byte = (code << 4) | (size & 15) as u8;
    size >>= 4;
    while size > 0 {
        out.push(byte | 0x80);
        byte = (size & 0x7f) as u8;
        size >>= 7;
    }
    out.push(byte);
    out
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

pub(super) fn inflate_exact(input: &[u8], size: usize) -> Result<(Vec<u8>, usize)> {
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
