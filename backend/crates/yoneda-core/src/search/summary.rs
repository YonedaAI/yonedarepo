//! A repository's search summary: every case-folded trigram of its searchable content and
//! its paths, hashed into a fixed set of bits. It answers one question, whether the repository
//! can't match a query, so a search across an owner's repositories can skip it. A repository
//! that can match is then asked through its own search; a summary never shows anything.
//!
//! A set bit promises nothing (trigrams share bits), but a clear one is a promise: a file
//! `candidates` returns holds all of the query's trigrams in its content, or the query in its
//! path, so every one of them is set here.
//!
//! Bits are stored four to a hex digit, so a reader can pick out the few digits a query
//! needs (`digit_of`) without reading the rest.
use super::{fold, trigrams};
use crate::{Error, Result};

/// A summary's format. A row of another version is treated as no row at all.
pub const SUMMARY_VERSION: i64 = 1;
/// Bits in a summary: 16 KiB, 32 KiB of hex.
pub const SUMMARY_BITS: u32 = 1 << 17;
/// How many of a query's bits a directory tests. Testing fewer only lets more through.
pub const TESTED_BITS: usize = 8;

const DIGITS: usize = (SUMMARY_BITS / 4) as usize;
const HEX: &[u8; 16] = b"0123456789abcdef";

/// A trigram's bit (FNV-1a).
fn position(gram: &[u8; 3]) -> u32 {
    let hash = gram.iter().fold(0x811c_9dc5_u32, |hash, byte| {
        (hash ^ u32::from(*byte)).wrapping_mul(0x0100_0193)
    });
    hash % SUMMARY_BITS
}

/// Which hex digit holds bit `position`, from 0.
pub fn digit_of(position: u32) -> usize {
    (position / 4) as usize
}

/// Whether hex digit `digit` has bit `position` set. Anything else reads as set: a character
/// a summary never holds proves nothing.
pub fn digit_holds(digit: &str, position: u32) -> bool {
    u8::from_str_radix(digit, 16).map_or(true, |value| value & 1 << (position % 4) != 0)
}

/// The bits a repository matching `query` must have set, at most `TESTED_BITS`. Empty when the
/// query has no trigram, and then it says nothing about any repository.
pub fn query_bits(query: &str) -> Vec<u32> {
    let mut bits: Vec<u32> = trigrams(&fold(query.as_bytes()))
        .iter()
        .map(position)
        .collect();
    bits.sort_unstable();
    bits.dedup();
    bits.truncate(TESTED_BITS);
    bits
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    /// One value from 0 to 15 per hex digit.
    digits: Vec<u8>,
}

impl Default for Summary {
    fn default() -> Self {
        Self {
            digits: vec![0; DIGITS],
        }
    }
}

impl Summary {
    pub fn from_hex(hex: &str) -> Result<Self> {
        let digits = hex
            .chars()
            .map(|c| c.to_digit(16).map(|d| d as u8))
            .collect::<Option<Vec<u8>>>()
            .filter(|digits| digits.len() == DIGITS)
            .ok_or_else(|| Error::new("INVALID_INPUT", "A search summary is damaged"))?;
        Ok(Self { digits })
    }

    pub fn to_hex(&self) -> String {
        self.digits
            .iter()
            .map(|d| char::from(HEX[usize::from(*d)]))
            .collect()
    }

    pub fn add_gram(&mut self, gram: &[u8; 3]) {
        let bit = position(gram);
        self.digits[digit_of(bit)] |= 1 << (bit % 4);
    }

    /// Adds a path, as searched: the whole of it, folded.
    pub fn add_path(&mut self, path: &str) {
        for gram in &trigrams(&fold(path.as_bytes())) {
            self.add_gram(gram);
        }
    }

    fn filled(&self) -> u32 {
        self.digits.iter().map(|d| d.count_ones()).sum()
    }

    /// Above two thirds full, nearly every query passes: such a repository is always asked.
    pub fn saturated(&self) -> bool {
        self.filled() as u64 * 3 > u64::from(SUMMARY_BITS) * 2
    }

    /// Whether a repository with this summary can match `query`.
    pub fn may_match(&self, query: &str) -> bool {
        query_bits(query)
            .iter()
            .all(|&bit| self.digits[digit_of(bit)] & 1 << (bit % 4) != 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_object::{ObjectKind, hash_object};
    use crate::search::{StoredSegment, build_segment};

    fn file(path: &str, text: &[u8]) -> (String, crate::git_object::ObjectId, Option<Vec<u8>>) {
        let id = hash_object(ObjectKind::Blob, text);
        (path.to_owned(), id, Some(text.to_vec()))
    }

    fn summary_of(
        prefix: &str,
        files: &[(String, crate::git_object::ObjectId, Option<Vec<u8>>)],
    ) -> Summary {
        let bytes = build_segment(files).encode().unwrap();
        let stored = StoredSegment::open(&bytes).unwrap();
        let mut summary = Summary::default();
        stored.summarize(prefix, &mut summary);
        summary
    }

    /// The promise: whatever `candidates` finds in a segment, its summary lets through.
    #[test]
    fn nothing_a_segment_finds_is_ever_filtered_out() {
        let files = [
            file(
                "Retry.rs",
                b"fn Retry_With_Backoff() {}\nlet deadline = 3;\n",
            ),
            file("bin/tool", b"\0\x01binary_content_here"),
            file(
                "notes/line.md",
                "caf\u{e9} au lait\nsecond line\n".as_bytes(),
            ),
        ];
        let bytes = build_segment(&files).encode().unwrap();
        let stored = StoredSegment::open(&bytes).unwrap();
        let mut summary = Summary::default();
        stored.summarize("top", &mut summary);
        for query in [
            "retry_with",
            "BACKOFF",
            "deadline",
            "top/retry",
            "TOP/NOTES/LINE",
            "bin/tool",
            "e au",
            "caf\u{e9}",
            "line\nsecond",
            "ab",
            "\n\n\n",
        ] {
            if !stored.candidates("top", query).unwrap().is_empty() {
                assert!(summary.may_match(query), "{query} was filtered out");
            }
        }
    }

    #[test]
    fn a_query_with_a_missing_trigram_cannot_match() {
        let summary = summary_of("", &[file("a.rs", b"alpha beta gamma\n")]);
        assert!(summary.may_match("alpha"));
        assert!(!summary.may_match("zebra_quantum"));
    }

    #[test]
    fn binary_content_is_not_summarized_but_its_path_is() {
        let summary = summary_of("", &[file("data/blob.bin", b"\0\x01binary_content_here")]);
        assert!(summary.may_match("blob.bin"));
        assert!(!summary.may_match("binary_content"));
    }

    #[test]
    fn a_query_without_a_trigram_says_nothing() {
        assert!(query_bits("ab").is_empty());
        assert!(query_bits("\n\n\n").is_empty());
        assert!(Summary::default().may_match("ab"));
        assert_eq!(query_bits("abc"), query_bits("ABC"));
    }

    #[test]
    fn a_long_query_tests_a_bounded_number_of_bits() {
        let long = "the quick brown fox jumps over the lazy dog".repeat(4);
        assert_eq!(query_bits(&long).len(), TESTED_BITS);
    }

    #[test]
    fn a_stored_digit_answers_as_the_summary_does() {
        let mut summary = Summary::default();
        summary.add_path("needle");
        let hex = summary.to_hex();
        assert_eq!(hex.len(), DIGITS);
        assert_eq!(Summary::from_hex(&hex).unwrap(), summary);
        for bit in query_bits("needle").into_iter().chain(query_bits("absent")) {
            let digit = &hex[digit_of(bit)..=digit_of(bit)];
            let set = summary.digits[digit_of(bit)] & 1 << (bit % 4) != 0;
            assert_eq!(digit_holds(digit, bit), set);
        }
        // A digit that isn't one proves nothing.
        assert!(digit_holds("", 3));
        assert!(digit_holds("z", 3));
    }

    #[test]
    fn a_damaged_summary_is_refused() {
        assert!(Summary::from_hex("00").is_err());
        assert!(Summary::from_hex(&"z".repeat(DIGITS)).is_err());
    }

    #[test]
    fn it_saturates_above_two_thirds() {
        let mut summary = Summary::default();
        assert!(!summary.saturated());
        for a in 0..=255u8 {
            for b in 0..=255u8 {
                for c in (0..=255u8).step_by(16) {
                    summary.add_gram(&[a, b, c]);
                }
            }
            if summary.saturated() {
                return;
            }
        }
        panic!("never saturated");
    }
}
