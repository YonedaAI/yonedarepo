//! A search segment's stored form, read in place. As JSON (an array of decimal file indexes
//! per trigram) a segment was about the size of the content it indexed, and every search
//! parsed each posting of each segment to look up its query's few trigrams. Stored, a
//! segment is its file list (JSON), a table of its trigrams in order with where each one's
//! posting starts, and the postings as delta varints: under half the size for source, and a
//! query binary-searches the table and decodes only its own trigrams' postings.
//!
//! Layout: `YSG1`, u32 file-list length, the file list, u32 trigram count, per trigram its
//! 3 bytes and a u32 posting offset, then the postings (each a varint count and varint
//! deltas between ascending file indexes). Integers are little-endian. Every length and
//! index is checked on read: a damaged segment is an error, never a panic.
use super::{Segment, SegmentFile, candidates};
use crate::{Error, Result};
use std::collections::BTreeSet;

const MAGIC: &[u8; 4] = b"YSG1";
/// A trigram and its posting's offset.
const ENTRY: usize = 3 + 4;

fn damaged(what: &str) -> Error {
    Error::new(
        "INVALID_INPUT",
        format!("Search segment is damaged: {what}"),
    )
}

fn varint(out: &mut Vec<u8>, mut value: u32) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn read_varint(bytes: &[u8], at: &mut usize) -> Result<u32> {
    let mut value = 0u32;
    for shift in [0, 7, 14, 21, 28] {
        let byte = *bytes
            .get(*at)
            .ok_or_else(|| damaged("posting ends early"))?;
        *at += 1;
        value |= u32::from(byte & 0x7f)
            .checked_shl(shift)
            .ok_or_else(|| damaged("varint"))?;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(damaged("varint too long"))
}

fn u32_at(bytes: &[u8], at: usize) -> Result<u32> {
    let word = bytes
        .get(at..at + 4)
        .ok_or_else(|| damaged("length past the end"))?;
    Ok(u32::from_le_bytes([word[0], word[1], word[2], word[3]]))
}

fn push_u32(out: &mut Vec<u8>, value: usize) -> Result<()> {
    let value = u32::try_from(value).map_err(|_| Error::new("TOO_LARGE", "Segment too large"))?;
    out.extend_from_slice(&value.to_le_bytes());
    Ok(())
}

impl Segment {
    /// The stored form. Fails only past 4 GiB, which a segment's bounded chunk never nears.
    pub fn encode(&self) -> Result<Vec<u8>> {
        let files = serde_json::to_vec(&self.files)
            .map_err(|e| Error::new("INTERNAL", format!("Segment files: {e}")))?;
        let mut postings = Vec::new();
        let mut table = Vec::with_capacity(self.grams.len() * ENTRY);
        for (gram, indexes) in &self.grams {
            table.extend_from_slice(gram);
            push_u32(&mut table, postings.len())?;
            varint(&mut postings, indexes.len() as u32);
            let mut previous = 0;
            for &index in indexes {
                varint(&mut postings, index - previous);
                previous = index;
            }
        }
        let mut out = Vec::with_capacity(16 + files.len() + table.len() + postings.len());
        out.extend_from_slice(MAGIC);
        push_u32(&mut out, files.len())?;
        out.extend_from_slice(&files);
        push_u32(&mut out, self.grams.len())?;
        out.extend_from_slice(&table);
        out.extend_from_slice(&postings);
        Ok(out)
    }
}

/// A stored segment opened in place: its files parsed, its trigrams read on demand.
pub struct StoredSegment<'a> {
    pub files: Vec<SegmentFile>,
    table: &'a [u8],
    postings: &'a [u8],
}

impl<'a> StoredSegment<'a> {
    pub fn open(bytes: &'a [u8]) -> Result<Self> {
        if bytes.get(..4) != Some(MAGIC) {
            return Err(damaged("not a stored segment"));
        }
        let files_len = u32_at(bytes, 4)? as usize;
        let files_end = 8usize
            .checked_add(files_len)
            .filter(|&end| end <= bytes.len())
            .ok_or_else(|| damaged("file list past the end"))?;
        let files: Vec<SegmentFile> = serde_json::from_slice(&bytes[8..files_end])
            .map_err(|_| damaged("file list is not valid"))?;
        let count = u32_at(bytes, files_end)? as usize;
        let table_start = files_end + 4;
        let table_end = count
            .checked_mul(ENTRY)
            .and_then(|n| n.checked_add(table_start))
            .filter(|&end| end <= bytes.len())
            .ok_or_else(|| damaged("trigram table past the end"))?;
        Ok(Self {
            files,
            table: &bytes[table_start..table_end],
            postings: &bytes[table_end..],
        })
    }

    /// The file indexes holding `gram` (none when absent).
    fn posting(&self, gram: &[u8; 3]) -> Result<BTreeSet<u32>> {
        let (mut low, mut high) = (0, self.table.len() / ENTRY);
        while low < high {
            let middle = (low + high) / 2;
            let entry = &self.table[middle * ENTRY..(middle + 1) * ENTRY];
            match entry[..3].cmp(gram.as_slice()) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
                std::cmp::Ordering::Equal => return self.decode(u32_at(entry, 3)? as usize),
            }
        }
        Ok(BTreeSet::new())
    }

    fn decode(&self, mut at: usize) -> Result<BTreeSet<u32>> {
        let count = read_varint(self.postings, &mut at)? as usize;
        if count > self.files.len() {
            return Err(damaged("posting longer than the file list"));
        }
        let mut found = BTreeSet::new();
        let mut index = 0u32;
        for _ in 0..count {
            index = index
                .checked_add(read_varint(self.postings, &mut at)?)
                .filter(|&i| (i as usize) < self.files.len())
                .ok_or_else(|| damaged("file index out of range"))?;
            found.insert(index);
        }
        Ok(found)
    }

    /// Files that may contain `query` or whose path matches, under `prefix` (see
    /// `candidates`).
    pub fn candidates(&self, prefix: &str, query: &str) -> Result<Vec<SegmentFile>> {
        candidates(&self.files, prefix, query, |gram| self.posting(gram))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_object::{ObjectKind, hash_object};
    use crate::search::build_segment;

    fn built(n: usize) -> Segment {
        let files: Vec<_> = (0..n)
            .map(|i| {
                let text = format!(
                    "file {i} says {}\n",
                    if i % 3 == 0 { "fizz" } else { "buzz" }
                );
                let id = hash_object(ObjectKind::Blob, text.as_bytes());
                (format!("f{i}.txt"), id, Some(text.into_bytes()))
            })
            .collect();
        build_segment(&files)
    }

    #[test]
    fn every_posting_reads_back_as_built() {
        let segment = built(300);
        let bytes = segment.encode().unwrap();
        let stored = StoredSegment::open(&bytes).unwrap();
        assert_eq!(stored.files, segment.files);
        for (gram, indexes) in &segment.grams {
            let read: Vec<u32> = stored.posting(gram).unwrap().into_iter().collect();
            assert_eq!(&read, indexes);
        }
        assert!(stored.posting(b"zzz").unwrap().is_empty());
        let fizz = stored.candidates("", "FIZZ").unwrap();
        assert_eq!(fizz.len(), 100);
    }

    #[test]
    fn damaged_segments_are_errors() {
        let segment = built(5);
        let bytes = segment.encode().unwrap();
        let read_all = |bytes: &[u8]| -> Result<()> {
            let s = StoredSegment::open(bytes)?;
            for gram in segment.grams.keys() {
                s.posting(gram)?;
            }
            Ok(())
        };
        assert!(read_all(&bytes).is_ok());
        assert!(StoredSegment::open(b"{\"files\":[]}").is_err());
        for cut in [0, 4, 9, bytes.len() / 2, bytes.len() - 1] {
            assert!(read_all(&bytes[..cut]).is_err(), "cut at {cut}");
        }
        // The last posting's last delta pointing past the file list.
        let mut wrong = bytes.clone();
        let last = wrong.len() - 1;
        wrong[last] = 0x7f;
        let last_gram = segment.grams.keys().next_back().unwrap();
        assert!(
            StoredSegment::open(&wrong)
                .unwrap()
                .posting(last_gram)
                .is_err()
        );
    }
}
