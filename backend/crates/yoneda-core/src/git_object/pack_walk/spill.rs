//! Spilling: a whole blob over the limits' spill size is handed out as it inflates
//! (`take_spilled`, at most SPILL_OUT bytes waiting, the walk pausing until they are taken)
//! and its compressed bytes are dropped once hashed into the trailer check, so no amount of
//! it stays in the walker. Entries keep their pack offsets (deltas name bases by them); a
//! spilled entry's span is empty, so it can never be a delta's base.
use super::PackWalker;
use crate::git_object::ObjectId;
use sha1::Digest;

/// Spilled content waiting to be taken before the walk pauses.
pub(super) const SPILL_OUT: usize = 4 * 1024 * 1024;

/// A spilled blob's content, in order: its size, its bytes in pieces, then its id once
/// the bytes hashed to it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Spill {
    Begin { size: usize },
    Data(Vec<u8>),
    End { id: ObjectId },
}

impl PackWalker {
    /// Spilled content handed out since the last call; the walk resumes on the next feed.
    pub fn take_spilled(&mut self) -> Vec<Spill> {
        self.spilled_bytes = 0;
        std::mem::take(&mut self.spilled)
    }

    /// Whether the walk paused with spilled content waiting (feed an empty chunk after
    /// taking it).
    pub fn paused(&self) -> bool {
        self.spilled_bytes >= SPILL_OUT && self.current.is_some()
    }

    /// Hashes a spilled entry's compressed bytes consumed so far into the trailer check and
    /// drops them (the bytes after them keep their pack offsets through `dropped`).
    pub(super) fn drop_spilled(&mut self) {
        let Some(entry) = self.current.as_ref().filter(|e| e.spill) else {
            return;
        };
        let start = entry.start;
        self.hasher.update(&self.buf[self.hashed..self.pos]);
        self.buf.drain(start..self.pos);
        self.dropped += self.pos - start;
        self.pos = start;
        self.hashed = start;
    }
}
