use super::{ObjectId, ObjectKind, Signature, hash_object, invalid};
use crate::Result;
use std::borrow::Cow;

/// One commit header, named as Git names it. Values are the header text with continuation
/// lines joined by `\n`.
///
/// Decoding is lossless, so a header keeps the exact bytes that make the commit's id:
/// - `Author` and `Committer` keep their validated line rather than a [`Signature`], since
///   Git writes spellings (a zero-padded time) that re-encoding one would change;
///   [`Commit::author`] and [`Commit::committer`] parse it.
/// - `Other` holds unrecognised headers and the value of a recognised one that does not fit
///   its variant (an `encoding` that is not UTF-8, a second `tree` that is not an id),
///   which Git keeps rather than refuses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommitHeader {
    Tree(ObjectId),
    Parent(ObjectId),
    Author(String),
    Committer(String),
    Encoding(String),
    /// An embedded signed tag of a merged parent.
    Mergetag(Vec<u8>),
    Gpgsig(Vec<u8>),
    GpgsigSha256(Vec<u8>),
    Other(String, Vec<u8>),
}

impl CommitHeader {
    pub fn key(&self) -> &str {
        match self {
            Self::Tree(_) => "tree",
            Self::Parent(_) => "parent",
            Self::Author(_) => "author",
            Self::Committer(_) => "committer",
            Self::Encoding(_) => "encoding",
            Self::Mergetag(_) => "mergetag",
            Self::Gpgsig(_) => "gpgsig",
            Self::GpgsigSha256(_) => "gpgsig-sha256",
            Self::Other(key, _) => key,
        }
    }

    pub fn value(&self) -> Cow<'_, [u8]> {
        match self {
            Self::Tree(id) | Self::Parent(id) => Cow::Owned(id.hex().into_bytes()),
            Self::Author(text) | Self::Committer(text) | Self::Encoding(text) => {
                Cow::Borrowed(text.as_bytes())
            }
            Self::Mergetag(value)
            | Self::Gpgsig(value)
            | Self::GpgsigSha256(value)
            | Self::Other(_, value) => Cow::Borrowed(value),
        }
    }

    /// Types a decoded header. `first` marks the header that must be the commit's tree.
    fn decode(key: String, value: Vec<u8>, first: bool) -> Result<Self> {
        let id = |value: &[u8]| ObjectId::parse(text(value)?);
        Ok(match key.as_str() {
            "tree" if first => Self::Tree(id(&value)?),
            "tree" => match id(&value) {
                Ok(tree) => Self::Tree(tree),
                Err(_) => Self::Other(key, value),
            },
            "parent" => Self::Parent(id(&value)?),
            "author" => Self::Author(text(&value)?.to_owned()),
            "committer" => Self::Committer(text(&value)?.to_owned()),
            "encoding" => match String::from_utf8(value) {
                Ok(encoding) => Self::Encoding(encoding),
                Err(e) => Self::Other(key, e.into_bytes()),
            },
            "mergetag" => Self::Mergetag(value),
            "gpgsig" => Self::Gpgsig(value),
            "gpgsig-sha256" => Self::GpgsigSha256(value),
            _ => Self::Other(key, value),
        })
    }
}

fn text(value: &[u8]) -> Result<&str> {
    std::str::from_utf8(value).map_err(|_| invalid("Commit header value must be UTF-8"))
}

/// A commit kept as its ordered typed headers and message, so decoding is lossless
/// (including `gpgsig`, `encoding` and other headers YonedaRepo does not interpret).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Commit {
    headers: Vec<CommitHeader>,
    message: Vec<u8>,
}

impl Commit {
    /// Builds a new commit; the message gets Git's trailing newline if it lacks one.
    pub fn new(
        tree: ObjectId,
        parents: &[ObjectId],
        author: &Signature,
        committer: &Signature,
        message: &str,
    ) -> Result<Self> {
        let mut headers = vec![CommitHeader::Tree(tree)];
        headers.extend(parents.iter().copied().map(CommitHeader::Parent));
        headers.push(CommitHeader::Author(author.encode()?));
        headers.push(CommitHeader::Committer(committer.encode()?));
        let mut message = message.as_bytes().to_vec();
        if !message.ends_with(b"\n") {
            message.push(b'\n');
        }
        Ok(Self { headers, message })
    }

    pub fn decode(data: &[u8]) -> Result<Self> {
        let split = data
            .windows(2)
            .position(|w| w == b"\n\n")
            .ok_or_else(|| invalid("Commit lacks a header terminator"))?;
        let mut raw: Vec<(String, Vec<u8>)> = Vec::new();
        for line in data[..split].split(|&b| b == b'\n') {
            if let Some(continuation) = line.strip_prefix(b" ") {
                let (_, value) = raw
                    .last_mut()
                    .ok_or_else(|| invalid("Commit starts with a continuation line"))?;
                value.push(b'\n');
                value.extend_from_slice(continuation);
                continue;
            }
            let space = line
                .iter()
                .position(|&b| b == b' ')
                .ok_or_else(|| invalid("Commit header lacks a value"))?;
            let key = std::str::from_utf8(&line[..space])
                .map_err(|_| invalid("Commit header key must be UTF-8"))?;
            raw.push((key.to_owned(), line[space + 1..].to_vec()));
        }
        let headers = raw
            .into_iter()
            .enumerate()
            .map(|(i, (key, value))| CommitHeader::decode(key, value, i == 0))
            .collect::<Result<_>>()?;
        let commit = Self {
            headers,
            message: data[split + 2..].to_vec(),
        };
        commit.tree()?;
        commit.author()?;
        commit.committer()?;
        Ok(commit)
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for header in &self.headers {
            out.extend_from_slice(header.key().as_bytes());
            out.push(b' ');
            for (i, line) in header.value().split(|&b| b == b'\n').enumerate() {
                if i > 0 {
                    out.extend_from_slice(b"\n ");
                }
                out.extend_from_slice(line);
            }
            out.push(b'\n');
        }
        out.push(b'\n');
        out.extend_from_slice(&self.message);
        out
    }

    pub fn id(&self) -> ObjectId {
        hash_object(ObjectKind::Commit, &self.encode())
    }

    /// The headers in object order.
    pub fn headers(&self) -> &[CommitHeader] {
        &self.headers
    }

    pub fn tree(&self) -> Result<ObjectId> {
        match self.headers.first() {
            Some(CommitHeader::Tree(tree)) => Ok(*tree),
            _ => Err(invalid("Commit must start with a tree header")),
        }
    }
    /// Every `parent` header was validated when the commit was built or decoded.
    pub fn parents(&self) -> Result<Vec<ObjectId>> {
        Ok(self
            .headers
            .iter()
            .filter_map(|h| match h {
                CommitHeader::Parent(id) => Some(*id),
                _ => None,
            })
            .collect())
    }
    fn signature(&self, key: &str, line: fn(&CommitHeader) -> Option<&str>) -> Result<Signature> {
        let mut values = self.headers.iter().filter_map(line);
        match (values.next(), values.next()) {
            (Some(value), None) => Signature::parse(value),
            _ => Err(invalid(format!("Commit needs exactly one {key} header"))),
        }
    }
    pub fn author(&self) -> Result<Signature> {
        self.signature("author", |h| match h {
            CommitHeader::Author(line) => Some(line),
            _ => None,
        })
    }
    pub fn committer(&self) -> Result<Signature> {
        self.signature("committer", |h| match h {
            CommitHeader::Committer(line) => Some(line),
            _ => None,
        })
    }
    pub fn message(&self) -> &[u8] {
        &self.message
    }

    /// `Key: value` lines of the final message paragraph, where YonedaRepo records provenance.
    pub fn trailers(&self) -> Vec<(String, String)> {
        let text = String::from_utf8_lossy(&self.message);
        let last = text.trim_end().rsplit("\n\n").next().unwrap_or_default();
        let parsed: Vec<_> = last.lines().map(|line| line.split_once(": ")).collect();
        if parsed.is_empty()
            || parsed
                .iter()
                .any(|p| p.is_none_or(|(k, _)| k.is_empty() || k.contains(' ')))
        {
            return Vec::new();
        }
        parsed
            .into_iter()
            .flatten()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect()
    }
}

#[cfg(test)]
#[path = "commit_tests.rs"]
mod tests;
