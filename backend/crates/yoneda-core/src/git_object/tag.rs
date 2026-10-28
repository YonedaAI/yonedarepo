//! Annotated tag objects (`git tag -a`): `object`, `type`, `tag` and an optional `tagger`
//! header, then the message (a signed tag carries its signature at the message's end).
//! YonedaRepo accepts only tags of commits and keeps the pushed bytes as they are, so the
//! tag's id is the one the client computed.
use super::{ObjectId, ObjectKind, Signature, hash_object, invalid};
use crate::Result;

/// Largest tag object accepted (a message plus a signature fit well within it).
pub const MAX_TAG_BYTES: usize = 64 * 1024;

/// A decoded annotated tag of a commit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnnotatedTag {
    /// The tagged commit.
    pub object: ObjectId,
    /// The name the tag object carries (`tag` header), without `refs/tags/`.
    pub name: String,
    pub tagger: Option<Signature>,
    pub message: String,
}

impl AnnotatedTag {
    /// A new tag of `commit`; the message gets Git's trailing newline if it lacks one.
    pub fn new(commit: ObjectId, name: &str, tagger: Signature, message: &str) -> Result<Self> {
        let tag = Self {
            object: commit,
            name: name.to_owned(),
            tagger: Some(tagger),
            message: if message.ends_with('\n') {
                message.to_owned()
            } else {
                format!("{message}\n")
            },
        };
        Self::decode(&tag.encode()?)
    }

    /// Checks `data` is a well-formed tag of a commit: the headers in Git's order, a
    /// one-line name, a valid tagger when present, UTF-8 throughout, within
    /// `MAX_TAG_BYTES`.
    pub fn decode(data: &[u8]) -> Result<Self> {
        if data.len() > MAX_TAG_BYTES {
            return Err(invalid(format!(
                "Tag objects are at most {MAX_TAG_BYTES} bytes"
            )));
        }
        let text = std::str::from_utf8(data).map_err(|_| invalid("Tag object must be UTF-8"))?;
        let (head, message) = text
            .split_once("\n\n")
            .ok_or_else(|| invalid("Tag lacks a header terminator"))?;
        let mut lines = head.split('\n');
        let mut field = |key: &str| {
            lines
                .next()
                .and_then(|line| line.strip_prefix(key)?.strip_prefix(' '))
                .ok_or_else(|| invalid(format!("Tag needs a {key} header in Git's order")))
        };
        let object = ObjectId::parse(field("object")?)?;
        if field("type")? != ObjectKind::Commit.name() {
            return Err(invalid("Only tags of commits are accepted"));
        }
        let name = field("tag")?.to_owned();
        if name.is_empty() || name.contains(|c: char| c.is_control()) {
            return Err(invalid("Tag name must be one non-empty line"));
        }
        let rest: Vec<&str> = lines.collect();
        let tagger = match rest.first().and_then(|l| l.strip_prefix("tagger ")) {
            Some(line) => Some(Signature::parse(line)?),
            None => None,
        };
        // Extra headers (e.g. `encoding`) are kept in the bytes, but never a second tagger.
        if rest
            .iter()
            .skip(usize::from(tagger.is_some()))
            .any(|l| l.starts_with("tagger ") || l.starts_with(' ') || l.is_empty())
        {
            return Err(invalid("Malformed tag header"));
        }
        let tag = Self {
            object,
            name,
            tagger,
            message: message.to_owned(),
        };
        Ok(tag)
    }

    /// The canonical bytes of a tag this platform builds (no extra headers).
    pub fn encode(&self) -> Result<Vec<u8>> {
        let mut out = format!(
            "object {}\ntype commit\ntag {}\n",
            self.object.hex(),
            self.name
        );
        if let Some(tagger) = &self.tagger {
            out.push_str(&format!("tagger {}\n", tagger.encode()?));
        }
        out.push('\n');
        out.push_str(&self.message);
        Ok(out.into_bytes())
    }

    pub fn id(&self) -> Result<ObjectId> {
        Ok(hash_object(ObjectKind::Tag, &self.encode()?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn who() -> Signature {
        Signature {
            name: "Ada".into(),
            email: "ada@example.com".into(),
            seconds: 1_700_000_000,
            offset: crate::git_object::TzOffset::UTC,
        }
    }

    #[test]
    fn builds_the_bytes_git_writes_and_decodes_them_back() {
        let commit = ObjectId::parse(&"a".repeat(40)).unwrap();
        let tag = AnnotatedTag::new(commit, "v1", who(), "x").unwrap();
        let bytes = tag.encode().unwrap();
        assert_eq!(
            String::from_utf8(bytes.clone()).unwrap(),
            format!(
                "object {}\ntype commit\ntag v1\ntagger Ada <ada@example.com> 1700000000 +0000\n\nx\n",
                "a".repeat(40)
            )
        );
        assert_eq!(AnnotatedTag::decode(&bytes).unwrap(), tag);
    }

    #[test]
    fn refuses_malformed_tags() {
        let object = "b".repeat(40);
        for bad in [
            format!("type commit\nobject {object}\ntag v1\n\nm\n"),
            format!("object {object}\ntype tree\ntag v1\n\nm\n"),
            format!("object {object}\ntype commit\ntag \n\nm\n"),
            format!("object {object}\ntype commit\ntag v1\ntagger nobody\n\nm\n"),
            format!("object {object}\ntype commit\ntag v1\n"),
            format!("object {}\ntype commit\ntag v1\n\nm\n", "z".repeat(40)),
            format!(
                "object {object}\ntype commit\ntag v1\ntagger A <a@b> 1 +0000\ntagger A <a@b> 1 +0000\n\nm\n"
            ),
        ] {
            assert!(AnnotatedTag::decode(bad.as_bytes()).is_err(), "{bad}");
        }
        assert!(AnnotatedTag::decode(&vec![b'a'; MAX_TAG_BYTES + 1]).is_err());
        let untagged = format!("object {object}\ntype commit\ntag v1\n\nm\n");
        assert_eq!(
            AnnotatedTag::decode(untagged.as_bytes()).unwrap().tagger,
            None
        );
    }
}
