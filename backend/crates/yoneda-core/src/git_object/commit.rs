use super::{ObjectId, ObjectKind, hash_object, invalid};
use crate::Result;

/// An author or committer identity line: `Name <email> <seconds> <+hhmm>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signature {
    pub name: String,
    pub email: String,
    pub seconds: i64,
    /// Timezone offset exactly as Git writes it, e.g. `+0100`.
    pub offset: String,
}

impl Signature {
    fn encode(&self) -> Result<String> {
        let unsafe_text = |s: &str| s.contains(['<', '>', '\n', '\0']);
        if unsafe_text(&self.name) || unsafe_text(&self.email) || self.name.trim() != self.name {
            return Err(invalid(
                "Signature name or email contains reserved characters",
            ));
        }
        let offset = self.offset.as_bytes();
        if offset.len() != 5
            || !matches!(offset[0], b'+' | b'-')
            || !offset[1..].iter().all(u8::is_ascii_digit)
        {
            return Err(invalid("Signature offset must look like +hhmm"));
        }
        Ok(format!(
            "{} <{}> {} {}",
            self.name, self.email, self.seconds, self.offset
        ))
    }
    fn parse(line: &str) -> Result<Self> {
        let bad = || invalid("Malformed signature line");
        let (ident, when) = line.rsplit_once("> ").ok_or_else(bad)?;
        let (name, email) = ident.rsplit_once(" <").ok_or_else(bad)?;
        let (seconds, offset) = when.split_once(' ').ok_or_else(bad)?;
        let signature = Self {
            name: name.to_owned(),
            email: email.to_owned(),
            seconds: seconds.parse().map_err(|_| bad())?,
            offset: offset.to_owned(),
        };
        signature.encode()?;
        Ok(signature)
    }
}

/// A commit kept as its ordered raw headers and message, so decoding is lossless
/// (including `gpgsig`, `encoding` and other headers YonedaRepo does not interpret).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Commit {
    headers: Vec<(String, Vec<u8>)>,
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
        let mut headers = vec![("tree".to_owned(), tree.hex().into_bytes())];
        for parent in parents {
            headers.push(("parent".to_owned(), parent.hex().into_bytes()));
        }
        headers.push(("author".to_owned(), author.encode()?.into_bytes()));
        headers.push(("committer".to_owned(), committer.encode()?.into_bytes()));
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
        let mut headers: Vec<(String, Vec<u8>)> = Vec::new();
        for line in data[..split].split(|&b| b == b'\n') {
            if let Some(continuation) = line.strip_prefix(b" ") {
                let (_, value) = headers
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
            headers.push((key.to_owned(), line[space + 1..].to_vec()));
        }
        let commit = Self {
            headers,
            message: data[split + 2..].to_vec(),
        };
        commit.tree()?;
        commit.parents()?;
        commit.author()?;
        commit.committer()?;
        Ok(commit)
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for (key, value) in &self.headers {
            out.extend_from_slice(key.as_bytes());
            out.push(b' ');
            for (i, line) in value.split(|&b| b == b'\n').enumerate() {
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

    fn header(&self, key: &str) -> impl Iterator<Item = &[u8]> {
        self.headers
            .iter()
            .filter(move |(k, _)| k == key)
            .map(|(_, v)| v.as_slice())
    }
    fn text(value: &[u8]) -> Result<&str> {
        std::str::from_utf8(value).map_err(|_| invalid("Commit header value must be UTF-8"))
    }

    pub fn tree(&self) -> Result<ObjectId> {
        match self.headers.first() {
            Some((key, value)) if key == "tree" => ObjectId::parse(Self::text(value)?),
            _ => Err(invalid("Commit must start with a tree header")),
        }
    }
    pub fn parents(&self) -> Result<Vec<ObjectId>> {
        self.header("parent")
            .map(|v| ObjectId::parse(Self::text(v)?))
            .collect()
    }
    fn signature(&self, key: &str) -> Result<Signature> {
        let mut values = self.header(key);
        match (values.next(), values.next()) {
            (Some(value), None) => Signature::parse(Self::text(value)?),
            _ => Err(invalid(format!("Commit needs exactly one {key} header"))),
        }
    }
    pub fn author(&self) -> Result<Signature> {
        self.signature("author")
    }
    pub fn committer(&self) -> Result<Signature> {
        self.signature("committer")
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
