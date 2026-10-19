use super::invalid;
use crate::Result;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha1::{Digest, Sha1};
use std::fmt;

/// A Git SHA-1 object id; serialized as 40 lowercase hex digits.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ObjectId([u8; 20]);

impl ObjectId {
    pub const fn from_bytes(bytes: [u8; 20]) -> Self {
        Self(bytes)
    }
    pub fn as_bytes(&self) -> &[u8; 20] {
        &self.0
    }
    /// Parses the canonical lowercase form only, so one object never has two spellings.
    pub fn parse(hex: &str) -> Result<Self> {
        let bytes = hex.as_bytes();
        if bytes.len() != 40 || !bytes.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err(invalid("Object id must be 40 lowercase hex digits"));
        }
        let mut out = [0u8; 20];
        for (i, pair) in bytes.chunks_exact(2).enumerate() {
            out[i] = (nibble(pair[0]) << 4) | nibble(pair[1]);
        }
        Ok(Self(out))
    }
    pub fn hex(&self) -> String {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        let mut out = String::with_capacity(40);
        for byte in self.0 {
            out.push(DIGITS[(byte >> 4) as usize] as char);
            out.push(DIGITS[(byte & 15) as usize] as char);
        }
        out
    }
}

fn nibble(digit: u8) -> u8 {
    match digit {
        b'0'..=b'9' => digit - b'0',
        _ => digit - b'a' + 10,
    }
}

impl fmt::Display for ObjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.hex())
    }
}
impl fmt::Debug for ObjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ObjectId({})", self.hex())
    }
}
impl Serialize for ObjectId {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.hex())
    }
}
impl<'de> Deserialize<'de> for ObjectId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let hex = String::deserialize(deserializer)?;
        Self::parse(&hex).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectKind {
    Commit,
    Tree,
    Blob,
    Tag,
}

impl ObjectKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Commit => "commit",
            Self::Tree => "tree",
            Self::Blob => "blob",
            Self::Tag => "tag",
        }
    }
    pub(crate) fn pack_code(self) -> u8 {
        match self {
            Self::Commit => 1,
            Self::Tree => 2,
            Self::Blob => 3,
            Self::Tag => 4,
        }
    }
    pub(crate) fn from_pack_code(code: u8) -> Result<Self> {
        Ok(match code {
            1 => Self::Commit,
            2 => Self::Tree,
            3 => Self::Blob,
            4 => Self::Tag,
            6 | 7 => return Err(invalid("Deltified pack objects are not accepted")),
            _ => return Err(invalid("Unknown pack object type")),
        })
    }
}

/// Git's object id: SHA-1 over `"<kind> <len>\0" + data`.
pub fn hash_object(kind: ObjectKind, data: &[u8]) -> ObjectId {
    let mut hasher = Sha1::new();
    hasher.update(format!("{} {}\0", kind.name(), data.len()).as_bytes());
    hasher.update(data);
    ObjectId(hasher.finalize().into())
}
