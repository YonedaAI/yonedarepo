//! A received pack, resolved as it streams in: every entry's object id and kind (deltas
//! applied to bases in the same pack; thin packs are refused), the commits, trees and tags
//! kept for verification, and any object's content on demand, re-inflated from the pack
//! when it is not cached. Memory stays near the pack's own size: blobs are hashed while
//! they inflate and only small ones are cached as likely delta bases. Blobs over the
//! limits' spill size are not held at all (`take_spilled`), so they cannot be delta bases,
//! and deltas resolve to at most that size.
use super::delta::apply_delta;
use super::pack::inflate_exact;
use super::pack_header::EntryKind;
use super::pack_walk::{Content, PackWalker, Spill, Walked};
use super::{ObjectId, ObjectKind, PackLimits, hash_object, invalid};
use crate::{Error, Result};
use std::collections::{HashMap, VecDeque};
use std::ops::Range;
use std::rc::Rc;

/// Whole objects up to this size are cached as they arrive (deltas usually follow their
/// bases closely); larger ones are re-inflated if a delta needs them.
const CACHE_ITEM: usize = 256 * 1024;
const CACHE_BYTES: usize = 8 * 1024 * 1024;
/// Commits, trees and tags are kept whole for verification, up to this much.
const KEPT_BYTES: usize = 16 * 1024 * 1024;
/// Git writes chains of at most 50 by default (4095 at the most aggressive).
const MAX_DEPTH: usize = 5000;

struct Slot {
    kind: EntryKind,
    size: usize,
    span: Range<usize>,
    object: Option<(ObjectId, ObjectKind)>,
    spilled: bool,
}

/// First in, first out by bytes: pack order puts deltas near their bases.
#[derive(Default)]
struct Cache {
    map: HashMap<usize, Rc<Vec<u8>>>,
    order: VecDeque<usize>,
    bytes: usize,
}

impl Cache {
    fn put(&mut self, index: usize, data: Rc<Vec<u8>>) {
        if data.len() > CACHE_ITEM || self.map.contains_key(&index) {
            return;
        }
        self.bytes += data.len();
        self.map.insert(index, data);
        self.order.push_back(index);
        while self.bytes > CACHE_BYTES {
            let Some(old) = self.order.pop_front() else {
                break;
            };
            if let Some(gone) = self.map.remove(&old) {
                self.bytes -= gone.len();
            }
        }
    }
}

pub struct PackReader {
    walker: PackWalker,
    /// What a delta may resolve to (deltas are applied in memory).
    max_delta_result: usize,
    slots: Vec<Slot>,
    by_offset: HashMap<u64, usize>,
    by_id: HashMap<ObjectId, usize>,
    waiting: Vec<usize>,
    cache: Cache,
    kept: HashMap<ObjectId, Rc<Vec<u8>>>,
    kept_bytes: usize,
}

impl PackReader {
    pub fn new(limits: PackLimits, max_pack_bytes: usize) -> Self {
        Self {
            walker: PackWalker::new(limits, max_pack_bytes),
            max_delta_result: limits.max_object_bytes.min(limits.spill_blob_bytes),
            slots: Vec::new(),
            by_offset: HashMap::new(),
            by_id: HashMap::new(),
            waiting: Vec::new(),
            cache: Cache::default(),
            kept: HashMap::new(),
            kept_bytes: 0,
        }
    }

    /// Takes the next chunk of the pack, resolving every entry it completes.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<()> {
        let keep = |kind: ObjectKind, size: usize| kind != ObjectKind::Blob || size <= CACHE_ITEM;
        for walked in self.walker.feed(chunk, &keep)? {
            self.accept(walked)?;
        }
        Ok(())
    }

    /// Checks the trailer and resolves deltas whose base came later in the pack.
    pub fn finish(&mut self) -> Result<()> {
        self.walker.finish()?;
        while !self.waiting.is_empty() {
            let before = self.waiting.len();
            for index in std::mem::take(&mut self.waiting) {
                match self.base_of(index)? {
                    Some(base) => {
                        let delta = self.inflated(index)?;
                        self.resolve_delta(index, base, &delta)?;
                    }
                    None => self.waiting.push(index),
                }
            }
            if self.waiting.len() == before {
                return Err(invalid(
                    "A delta's base is not in the pack (thin packs are not accepted)",
                ));
            }
        }
        Ok(())
    }

    /// Pack bytes held (spilled entries' bytes are not).
    pub fn received(&self) -> usize {
        self.walker.bytes().len()
    }

    /// Spilled blobs' content handed out since the last call (see `PackWalker`).
    pub fn take_spilled(&mut self) -> Vec<Spill> {
        self.walker.take_spilled()
    }

    /// Whether the walk paused for spilled content to be taken.
    pub fn paused(&self) -> bool {
        self.walker.paused()
    }

    /// Whether `id` is a spilled blob (its content was handed out, not kept).
    pub fn spilled(&self, id: &ObjectId) -> bool {
        self.by_id.get(id).is_some_and(|i| self.slots[*i].spilled)
    }

    /// Every object in pack order (after `finish`).
    pub fn objects(&self) -> impl Iterator<Item = (ObjectId, ObjectKind)> + '_ {
        self.slots.iter().filter_map(|s| s.object)
    }
    pub fn kind(&self, id: &ObjectId) -> Option<ObjectKind> {
        self.by_id
            .get(id)
            .and_then(|i| self.slots[*i].object)
            .map(|(_, kind)| kind)
    }
    /// A commit, tree or tag from the pack, whole.
    pub fn kept(&self, id: &ObjectId) -> Option<&[u8]> {
        self.kept.get(id).map(|data| data.as_slice())
    }
    /// The content of any object in the pack.
    pub fn content(&mut self, id: &ObjectId) -> Result<Rc<Vec<u8>>> {
        if let Some(kept) = self.kept.get(id) {
            return Ok(kept.clone());
        }
        let index = *self
            .by_id
            .get(id)
            .ok_or_else(|| invalid(format!("Object {id} is not in the pack")))?;
        self.content_at(index)
    }

    fn accept(&mut self, walked: Walked) -> Result<()> {
        let index = self.slots.len();
        self.by_offset.insert(walked.offset, index);
        self.slots.push(Slot {
            kind: walked.kind,
            size: walked.size,
            span: walked.span,
            object: None,
            spilled: walked.spilled,
        });
        match (walked.kind, walked.content) {
            (EntryKind::Whole(kind), Content::Object { id, data }) => {
                self.resolved(index, id, kind, data.map(Rc::new))
            }
            (_, Content::Delta(delta)) => match self.base_of(index)? {
                Some(base) => self.resolve_delta(index, base, &delta),
                None => {
                    self.waiting.push(index);
                    Ok(())
                }
            },
            _ => Err(invalid("Pack entry and content disagree")),
        }
    }

    /// The resolved entry a delta applies to, or `None` while that base is unresolved.
    fn base_of(&self, index: usize) -> Result<Option<usize>> {
        let base = match self.slots[index].kind {
            EntryKind::Whole(_) => return Ok(None),
            EntryKind::OfsDelta(offset) => *self
                .by_offset
                .get(&offset)
                .ok_or_else(|| invalid("A delta's base offset is not an entry"))?,
            EntryKind::RefDelta(id) => match self.by_id.get(&id) {
                Some(base) => *base,
                None => return Ok(None),
            },
        };
        Ok(self.slots[base].object.map(|_| base))
    }

    fn resolve_delta(&mut self, index: usize, base: usize, delta: &[u8]) -> Result<()> {
        let source = self.content_at(base)?;
        let data = apply_delta(&source, delta, self.max_delta_result)?;
        let kind = self.slots[base]
            .object
            .map(|(_, kind)| kind)
            .ok_or_else(|| invalid("A delta's base is unresolved"))?;
        let id = hash_object(kind, &data);
        self.resolved(index, id, kind, Some(Rc::new(data)))
    }

    fn resolved(
        &mut self,
        index: usize,
        id: ObjectId,
        kind: ObjectKind,
        data: Option<Rc<Vec<u8>>>,
    ) -> Result<()> {
        self.slots[index].object = Some((id, kind));
        self.by_id.entry(id).or_insert(index);
        let Some(data) = data else { return Ok(()) };
        if kind != ObjectKind::Blob && !self.kept.contains_key(&id) {
            self.kept_bytes += data.len();
            if self.kept_bytes > KEPT_BYTES {
                return Err(Error::new(
                    "TOO_LARGE",
                    "Push has too many commits and directories for one HTTPS push",
                ));
            }
            self.kept.insert(id, data.clone());
        }
        self.cache.put(index, data);
        Ok(())
    }

    /// An entry's own inflated payload (a whole object, or a delta's instructions).
    fn inflated(&self, index: usize) -> Result<Vec<u8>> {
        let slot = &self.slots[index];
        if slot.spilled {
            return Err(Error::new(
                "TOO_LARGE",
                format!(
                    "A delta is based on a file of {} MiB, which is not held in memory; push large files whole (git -c pack.window=0 push) or with Git LFS",
                    slot.size >> 20
                ),
            ));
        }
        let bytes = self
            .walker
            .bytes()
            .get(slot.span.clone())
            .ok_or_else(|| invalid("Pack entry span is outside the pack"))?;
        Ok(inflate_exact(bytes, slot.size)?.0)
    }

    /// An entry's object content: from the cache or kept objects, else re-inflated and
    /// re-applied down its delta chain (iteratively, so deep chains cannot overflow).
    fn content_at(&mut self, index: usize) -> Result<Rc<Vec<u8>>> {
        let held = |reader: &Self, i: usize| {
            reader.cache.map.get(&i).cloned().or_else(|| {
                reader.slots[i]
                    .object
                    .and_then(|(id, _)| reader.kept.get(&id).cloned())
            })
        };
        let mut chain = vec![index];
        let mut data = loop {
            let top = chain[chain.len() - 1];
            if let Some(found) = held(self, top) {
                chain.pop();
                break found;
            }
            if matches!(self.slots[top].kind, EntryKind::Whole(_)) {
                chain.pop();
                break Rc::new(self.inflated(top)?);
            }
            let base = self
                .base_of(top)?
                .ok_or_else(|| invalid("A delta's base is unresolved"))?;
            chain.push(base);
            if chain.len() > MAX_DEPTH {
                return Err(invalid("Delta chain is too deep"));
            }
        };
        while let Some(next) = chain.pop() {
            let delta = self.inflated(next)?;
            data = Rc::new(apply_delta(&data, &delta, self.max_delta_result)?);
            self.cache.put(next, data.clone());
        }
        Ok(data)
    }
}
