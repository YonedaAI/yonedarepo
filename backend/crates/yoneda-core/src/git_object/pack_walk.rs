//! A pack walker fed in chunks as a push arrives: each entry is parsed and inflated as
//! soon as its bytes are in, with zlib state kept across chunks, so a large object costs
//! one pass and size limits fail the push early. Whole objects are hashed while they
//! inflate and kept only when the caller asks; delta payloads are handed over whole. A
//! whole blob over `spill_blob_bytes` is not held at all (`spill`). (Over 300 lines: an
//! entry's header, limits and inflation share the buffer and offsets kept here.)
use super::pack_header::{EntryKind, entry_header};
use super::{ObjectId, ObjectKind, PackLimits, invalid};
use crate::Result;
use miniz_oxide::{
    DataFormat, MZError, MZFlush, MZStatus,
    inflate::stream::{InflateState, inflate},
};
use sha1::{Digest, Sha1};
use std::ops::Range;

const WINDOW: usize = 64 * 1024;

mod spill;
use spill::SPILL_OUT;
pub use spill::Spill;
/// One parsed entry: where it starts, its declared inflated size, its compressed bytes.
#[derive(Clone, Debug)]
pub struct Walked {
    pub offset: u64,
    pub kind: EntryKind,
    pub size: usize,
    pub span: Range<usize>,
    pub content: Content,
    /// Handed out as `Spill`s: not in the pack's bytes, not a delta base.
    pub spilled: bool,
}

#[derive(Clone, Debug)]
pub enum Content {
    /// A whole object, hashed; its bytes when the caller's `keep` asked for them.
    Object { id: ObjectId, data: Option<Vec<u8>> },
    /// A delta's instructions, to apply to its base.
    Delta(Vec<u8>),
}

struct Inflating {
    offset: u64,
    kind: EntryKind,
    size: usize,
    start: usize,
    state: Box<InflateState>,
    written: usize,
    hasher: Option<Sha1>,
    kept: Option<Vec<u8>>,
    spill: bool,
}

pub struct PackWalker {
    limits: PackLimits,
    max_pack_bytes: usize,
    buf: Vec<u8>,
    pos: usize,
    hasher: Sha1,
    hashed: usize,
    remaining: Option<u32>,
    total: usize,
    current: Option<Inflating>,
    finished: bool,
    /// Bytes dropped from `buf` (spilled entries' compressed bytes): a position's pack
    /// offset is its index plus this, for everything after them.
    dropped: usize,
    spilled: Vec<Spill>,
    spilled_bytes: usize,
}

impl PackWalker {
    pub fn new(limits: PackLimits, max_pack_bytes: usize) -> Self {
        Self {
            limits,
            max_pack_bytes,
            buf: Vec::new(),
            pos: 0,
            hasher: Sha1::new(),
            hashed: 0,
            remaining: None,
            total: 0,
            current: None,
            finished: false,
            dropped: 0,
            spilled: Vec::new(),
            spilled_bytes: 0,
        }
    }

    /// The pack bytes received so far (entries' spans index into this).
    pub fn bytes(&self) -> &[u8] {
        &self.buf
    }

    /// Appends `chunk` and returns every entry it completed. `keep(kind, size)` decides
    /// which whole objects come back with their bytes.
    pub fn feed(
        &mut self,
        chunk: &[u8],
        keep: &dyn Fn(ObjectKind, usize) -> bool,
    ) -> Result<Vec<Walked>> {
        if self.finished && !chunk.is_empty() {
            return Err(invalid("Pack has trailing bytes"));
        }
        if self.buf.len() + chunk.len() > self.max_pack_bytes {
            return Err(crate::Error::new(
                "TOO_LARGE",
                format!(
                    "Push exceeds {} MiB of pack data; push fewer commits at a time, or use git-remote-yoneda",
                    self.max_pack_bytes >> 20
                ),
            ));
        }
        self.buf.extend_from_slice(chunk);
        let mut done = Vec::new();
        loop {
            if self.remaining.is_none() && !self.header()? {
                break;
            }
            if self.remaining == Some(0) {
                self.trailer()?;
                break;
            }
            if self.current.is_none() && !self.start_entry(keep)? {
                break;
            }
            match self.inflate()? {
                Some(walked) => done.push(walked),
                None => break,
            }
        }
        Ok(done)
    }

    /// Fails unless the whole pack, trailer included, arrived and checked out.
    pub fn finish(&mut self) -> Result<()> {
        if !self.finished {
            return Err(invalid("Pack is truncated"));
        }
        Ok(())
    }

    fn header(&mut self) -> Result<bool> {
        let Some(head) = self.buf.get(..12) else {
            return Ok(false);
        };
        if &head[..4] != b"PACK" {
            return Err(invalid("Not a pack"));
        }
        if !matches!(
            u32::from_be_bytes([head[4], head[5], head[6], head[7]]),
            2 | 3
        ) {
            return Err(invalid("Only pack versions 2 and 3 are accepted"));
        }
        let count = u32::from_be_bytes([head[8], head[9], head[10], head[11]]);
        if count > self.limits.max_objects {
            return Err(crate::Error::new(
                "TOO_LARGE",
                format!("Push exceeds {} objects", self.limits.max_objects),
            ));
        }
        self.remaining = Some(count);
        self.pos = 12;
        Ok(true)
    }

    fn trailer(&mut self) -> Result<()> {
        if self.finished {
            return Ok(());
        }
        let Some(trailer) = self.buf.get(self.pos..self.pos + 20) else {
            return Ok(());
        };
        self.hasher.update(&self.buf[self.hashed..self.pos]);
        self.hashed = self.pos;
        if self.hasher.clone().finalize().as_slice() != trailer {
            return Err(invalid("Pack checksum mismatch"));
        }
        if self.buf.len() != self.pos + 20 {
            return Err(invalid("Pack has trailing bytes"));
        }
        self.finished = true;
        Ok(())
    }

    /// Parses the next entry's header once all of it is here.
    fn start_entry(&mut self, keep: &dyn Fn(ObjectKind, usize) -> bool) -> Result<bool> {
        let offset = self.pos;
        let logical = (offset + self.dropped) as u64;
        let Some((kind, size, at)) = entry_header(&self.buf[offset..], logical)? else {
            return Ok(false);
        };
        self.total = self.total.saturating_add(size);
        if size > self.limits.max_object_bytes {
            return Err(crate::Error::new(
                "TOO_LARGE",
                format!(
                    "Push has an object of {} MiB; the limit is {} MiB per file (use Git LFS for larger files)",
                    size >> 20,
                    self.limits.max_object_bytes >> 20
                ),
            ));
        }
        if self.total > self.limits.max_total_bytes {
            return Err(crate::Error::new(
                "TOO_LARGE",
                format!(
                    "Push exceeds {} MiB of objects; push fewer commits at a time",
                    self.limits.max_total_bytes >> 20
                ),
            ));
        }
        let spill =
            kind == EntryKind::Whole(ObjectKind::Blob) && size > self.limits.spill_blob_bytes;
        let (hasher, kept) = match kind {
            EntryKind::Whole(kind) => {
                let mut hasher = Sha1::new();
                hasher.update(format!("{} {size}\0", kind.name()).as_bytes());
                (
                    Some(hasher),
                    (!spill && keep(kind, size)).then(|| Vec::with_capacity(size)),
                )
            }
            _ => (None, Some(Vec::with_capacity(size))),
        };
        if spill {
            self.spilled.push(Spill::Begin { size });
        }
        self.current = Some(Inflating {
            offset: logical,
            kind,
            size,
            start: offset + at,
            state: InflateState::new_boxed(DataFormat::Zlib),
            written: 0,
            hasher,
            kept,
            spill,
        });
        self.pos = offset + at;
        Ok(true)
    }

    /// Inflates the current entry as far as the bytes allow; the entry once complete.
    fn inflate(&mut self) -> Result<Option<Walked>> {
        let Some(entry) = self.current.as_mut() else {
            return Ok(None);
        };
        let mut window = vec![0u8; WINDOW.min(entry.size + 1).max(1)];
        let complete = loop {
            let input = &self.buf[self.pos..];
            let result = inflate(&mut entry.state, input, &mut window, MZFlush::None);
            self.pos += result.bytes_consumed;
            let out = &window[..result.bytes_written];
            entry.written += out.len();
            if entry.written > entry.size {
                return Err(invalid("Pack object inflates past its declared size"));
            }
            if let Some(hasher) = entry.hasher.as_mut() {
                hasher.update(out);
            }
            if let Some(kept) = entry.kept.as_mut() {
                kept.extend_from_slice(out);
            }
            if entry.spill && !out.is_empty() {
                self.spilled_bytes += out.len();
                self.spilled.push(Spill::Data(out.to_vec()));
            }
            let progress = result.bytes_written > 0 || result.bytes_consumed > 0;
            let starved = self.pos == self.buf.len();
            match result.status {
                Ok(MZStatus::StreamEnd) => break true,
                // Spilled content waits to be taken: pause (the next feed resumes).
                Ok(_) if entry.spill && self.spilled_bytes >= SPILL_OUT => break false,
                Ok(_) if progress => {}
                // Out of input mid-stream: wait for the next chunk.
                Ok(_) | Err(MZError::Buf) if starved => break false,
                _ => return Err(invalid("Pack object is not valid zlib data")),
            }
        };
        self.drop_spilled();
        if !complete {
            return Ok(None);
        }
        let Some(entry) = self.current.take() else {
            return Ok(None);
        };
        if entry.written != entry.size {
            return Err(invalid("Pack object does not inflate to its declared size"));
        }
        self.remaining = self.remaining.map(|r| r - 1);
        let content = match (entry.hasher, entry.kept) {
            (Some(hasher), data) => Content::Object {
                id: ObjectId::from_bytes(hasher.finalize().into()),
                data,
            },
            (None, Some(delta)) => Content::Delta(delta),
            (None, None) => return Err(invalid("Delta entry lost its payload")),
        };
        if let (true, Content::Object { id, .. }) = (entry.spill, &content) {
            self.spilled.push(Spill::End { id: *id });
        }
        // Entries are hashed into the trailer check as they complete.
        self.hasher.update(&self.buf[self.hashed..self.pos]);
        self.hashed = self.pos;
        Ok(Some(Walked {
            offset: entry.offset,
            kind: entry.kind,
            size: entry.size,
            span: entry.start..self.pos,
            content,
            spilled: entry.spill,
        }))
    }
}
