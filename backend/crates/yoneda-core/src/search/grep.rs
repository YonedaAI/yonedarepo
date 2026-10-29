//! The lines of a file that hold a query, with where each match lies, ranked inputs for a
//! search: every match counted (not only the lines listed), and how many fall on identifier
//! boundaries (a whole word: `test` in `test(` but not in `latest`).
use crate::textdiff::is_binary;
use serde::Serialize;

/// Characters of a line returned at most.
const LINE_CHARS: usize = 500;

/// A matching line: 1-based number, its text (at most LINE_CHARS characters) and each
/// match within that text as `[start, end)` in UTF-16 code units (what a browser indexes).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LineMatch {
    pub line: u32,
    pub text: String,
    pub ranges: Vec<[u32; 2]>,
}

/// A file's matches: the first `max` lines holding one, every match counted, and how many
/// are whole words.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Grep {
    pub lines: Vec<LineMatch>,
    pub hits: u32,
    pub word_hits: u32,
}

fn word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Whether `[start, end)` of `line` sits on identifier boundaries on both sides.
fn whole_word(line: &[u8], start: usize, end: usize) -> bool {
    (start == 0 || !word_byte(line[start - 1])) && (end == line.len() || !word_byte(line[end]))
}

/// UTF-16 length of `text`'s first `bytes` bytes (cut at a character boundary).
fn utf16_at(text: &str, bytes: usize) -> u32 {
    let mut at = bytes.min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    text[..at].encode_utf16().count() as u32
}

/// Lines of `data` holding `query` (case-folded when `ignore_case`; only whole words when
/// `word`), the first `max` listed with their match ranges. Binary content holds none.
pub fn grep(data: &[u8], query: &str, ignore_case: bool, word: bool, max: usize) -> Grep {
    let mut found = Grep::default();
    if is_binary(data) || query.is_empty() {
        return found;
    }
    let fold = |b: &[u8]| -> Vec<u8> {
        if ignore_case {
            b.to_ascii_lowercase()
        } else {
            b.to_vec()
        }
    };
    let needle = fold(query.as_bytes());
    for (n, line) in data.split(|b| *b == b'\n').enumerate() {
        let hay = fold(line);
        let mut spans = Vec::new();
        let mut at = 0;
        while let Some(i) = hay.get(at..).and_then(|rest| {
            rest.windows(needle.len())
                .position(|w| w == needle.as_slice())
        }) {
            let (start, end) = (at + i, at + i + needle.len());
            let is_word = whole_word(&hay, start, end);
            if is_word || !word {
                spans.push((start, end));
                found.hits += 1;
                found.word_hits += u32::from(is_word);
            }
            at = end;
        }
        if spans.is_empty() || found.lines.len() >= max {
            continue;
        }
        let full = String::from_utf8_lossy(line);
        let text: String = full.chars().take(LINE_CHARS).collect();
        let ranges = spans
            .iter()
            .filter(|(start, _)| *start < text.len())
            .map(|(start, end)| [utf16_at(&text, *start), utf16_at(&text, *end)])
            .filter(|[s, e]| s < e)
            .collect();
        found.lines.push(LineMatch {
            line: n as u32 + 1,
            text,
            ranges,
        });
    }
    found
}

/// Files a search never reports as "not searched": binary formats by extension (a file
/// over the indexing cap is not read, so its content cannot be sniffed).
pub fn binary_path(path: &str) -> bool {
    const BINARY: [&str; 44] = [
        "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "ico", "bmp", "tif", "tiff", "psd",
        "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "war", "whl", "mp3",
        "mp4", "m4a", "mov", "avi", "mkv", "webm", "wav", "flac", "ogg", "woff", "woff2", "ttf",
        "otf", "eot", "wasm", "exe", "dll", "so", "dylib",
    ];
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| BINARY.contains(&ext.to_ascii_lowercase().as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_every_match_and_the_whole_words_among_them() {
        let data = b"ARG CLAUDE_CODE_VERSION=latest\nrun test(); test_case\nTest the test\n";
        let all = grep(data, "test", false, false, 10);
        assert_eq!((all.hits, all.word_hits), (4, 2));
        assert_eq!(
            all.lines.iter().map(|l| l.line).collect::<Vec<_>>(),
            [1, 2, 3]
        );
        assert_eq!(all.lines[1].ranges, vec![[4, 8], [12, 16]]);
        let words = grep(data, "test", false, true, 10);
        assert_eq!((words.hits, words.word_hits), (2, 2));
        assert_eq!(
            words.lines.iter().map(|l| l.line).collect::<Vec<_>>(),
            [2, 3]
        );
        assert_eq!(words.lines[1].ranges, vec![[9, 13]]);
        let folded = grep(data, "test", true, true, 10);
        assert_eq!(folded.hits, 3);
        // Listing stops at `max` lines; counting does not.
        let one = grep(data, "test", false, false, 1);
        assert_eq!((one.lines.len(), one.hits), (1, 4));
    }

    #[test]
    fn ranges_are_utf16_offsets_into_the_returned_text() {
        let data = "é😀 test é\n".as_bytes();
        let found = grep(data, "test", false, false, 10);
        let text: Vec<u16> = found.lines[0].text.encode_utf16().collect();
        let [s, e] = found.lines[0].ranges[0];
        assert_eq!(
            String::from_utf16(&text[s as usize..e as usize]).unwrap(),
            "test"
        );
        assert!(
            grep(b"bin\0test", "test", false, false, 10)
                .lines
                .is_empty()
        );
    }

    #[test]
    fn knows_binary_formats_by_extension() {
        assert!(binary_path("demo.gif"));
        assert!(binary_path("assets/Logo.PNG"));
        assert!(!binary_path("huge.log"));
        assert!(!binary_path("gif"));
    }
}
