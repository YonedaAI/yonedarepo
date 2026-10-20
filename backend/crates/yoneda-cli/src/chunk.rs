//! Splitting one local commit's changes into requests the platform accepts. A commit
//! larger than one request becomes a series of commits whose last tree is the original.
use crate::changes::Change;
use crate::error::{Error, Result};

const MIB: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_files: usize,
    pub max_file_bytes: usize,
    /// Encoded request budget (base64 content and framing). A single file within
    /// `max_file_bytes` that exceeds it still travels, alone.
    pub max_request_bytes: usize,
}

/// `POST /commits`: 500 files and 4 MiB per request as agreed for clients; the platform
/// itself accepts files up to 32 MiB, which then travel one per request.
pub const API: Limits = Limits {
    max_files: 500,
    max_file_bytes: 32 * MIB,
    max_request_bytes: 4 * MIB,
};

/// Remote MCP `attempt_commit`: 500 files of 1 MiB within its 4 MiB request body
/// (less room for the JSON-RPC envelope).
pub const ATTEMPT: Limits = Limits {
    max_files: 500,
    max_file_bytes: MIB,
    max_request_bytes: 4 * MIB - 64 * 1024,
};

/// Greedy, order-preserving split: deletes stay ahead of the writes that follow them.
pub fn chunk(changes: Vec<Change>, limits: &Limits) -> Result<Vec<Vec<Change>>> {
    let mut chunks: Vec<Vec<Change>> = Vec::new();
    let mut current: Vec<Change> = Vec::new();
    let mut bytes = 0usize;
    for change in changes {
        if change.content_len() > limits.max_file_bytes {
            return Err(Error::new(format!(
                "{} is {} bytes; files over {} bytes cannot be synced this way",
                change.path,
                change.content_len(),
                limits.max_file_bytes
            )));
        }
        let size = change.encoded_len();
        let full = current.len() >= limits.max_files || bytes + size > limits.max_request_bytes;
        if full && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
            bytes = 0;
        }
        bytes += size;
        current.push(change);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::changes::Target;

    fn write(path: &str, len: usize) -> Change {
        Change {
            path: path.into(),
            old_blob: None,
            target: Target::Write {
                blob: "0".repeat(40),
                executable: false,
                data: vec![b'x'; len],
            },
        }
    }

    fn total_files(chunks: &[Vec<Change>]) -> usize {
        chunks.iter().map(Vec::len).sum()
    }

    #[test]
    fn splits_exactly_at_the_file_count() -> Result<()> {
        let at = |n: usize| {
            (0..n)
                .map(|i| write(&format!("f/{i}"), 1))
                .collect::<Vec<_>>()
        };
        assert_eq!(chunk(at(500), &ATTEMPT)?.len(), 1);
        let split = chunk(at(501), &ATTEMPT)?;
        assert_eq!(split.iter().map(Vec::len).collect::<Vec<_>>(), [500, 1]);
        assert!(chunk(Vec::new(), &API)?.is_empty());
        Ok(())
    }

    #[test]
    fn splits_at_the_request_budget_and_keeps_order() -> Result<()> {
        // Three 1 MiB files encode to ~1.33 MiB each: two fit in 4 MiB - 64 KiB, three do not.
        let files = vec![
            write("a", MIB),
            write("b", MIB),
            write("c", MIB),
            write("d", 10),
        ];
        let chunks = chunk(files, &ATTEMPT)?;
        let paths: Vec<Vec<&str>> = chunks
            .iter()
            .map(|c| c.iter().map(|f| f.path.as_str()).collect())
            .collect();
        assert_eq!(paths, [vec!["a", "b"], vec!["c", "d"]]);
        for c in &chunks {
            assert!(c.iter().map(Change::encoded_len).sum::<usize>() <= ATTEMPT.max_request_bytes);
        }
        Ok(())
    }

    #[test]
    fn enforces_the_file_limit_and_lets_a_large_api_file_travel_alone() -> Result<()> {
        assert!(chunk(vec![write("ok", MIB)], &ATTEMPT).is_ok());
        let refused = chunk(vec![write("big", MIB + 1)], &ATTEMPT)
            .err()
            .map(|e| e.message);
        assert!(refused.is_some_and(|m| m.contains("big is 1048577 bytes")));
        let chunks = chunk(
            vec![write("s", 1), write("big", 5 * MIB), write("t", 1)],
            &API,
        )?;
        assert_eq!(chunks.iter().map(Vec::len).collect::<Vec<_>>(), [1, 1, 1]);
        assert_eq!(total_files(&chunks), 3);
        Ok(())
    }
}
