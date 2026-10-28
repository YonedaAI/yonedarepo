use super::invalid;
use crate::Result;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use std::{fmt, str::FromStr};

/// A timezone offset as Git writes it: a sign and four digits, `+hhmm`. The digits are
/// kept as written (Git records `-0000` and out-of-range minutes verbatim), so encoding a
/// parsed offset gives back the same text. Serializes as that text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TzOffset {
    negative: bool,
    hours: u8,
    minutes: u8,
}

impl TzOffset {
    pub const UTC: Self = Self {
        negative: false,
        hours: 0,
        minutes: 0,
    };

    pub fn parse(text: &str) -> Result<Self> {
        let bad = || invalid("Signature offset must look like +hhmm");
        let (negative, digits) = match text.as_bytes() {
            [b'+', rest @ ..] => (false, rest),
            [b'-', rest @ ..] => (true, rest),
            _ => return Err(bad()),
        };
        let &[h1, h2, m1, m2] = digits else {
            return Err(bad());
        };
        let pair = |high: u8, low: u8| {
            (high.is_ascii_digit() && low.is_ascii_digit())
                .then(|| (high - b'0') * 10 + (low - b'0'))
        };
        Ok(Self {
            negative,
            hours: pair(h1, h2).ok_or_else(bad)?,
            minutes: pair(m1, m2).ok_or_else(bad)?,
        })
    }
}

impl fmt::Display for TzOffset {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sign = if self.negative { '-' } else { '+' };
        write!(f, "{sign}{:02}{:02}", self.hours, self.minutes)
    }
}

impl FromStr for TzOffset {
    type Err = crate::Error;
    fn from_str(text: &str) -> Result<Self> {
        Self::parse(text)
    }
}

impl Serialize for TzOffset {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for TzOffset {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::parse(&text).map_err(|e| de::Error::custom(e.message))
    }
}

/// An author or committer identity line: `Name <email> <seconds> <+hhmm>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signature {
    pub name: String,
    pub email: String,
    pub seconds: i64,
    pub offset: TzOffset,
}

impl Signature {
    pub(super) fn encode(&self) -> Result<String> {
        let unsafe_text = |s: &str| s.contains(['<', '>', '\n', '\0']);
        if unsafe_text(&self.name) || unsafe_text(&self.email) || self.name.trim() != self.name {
            return Err(invalid(
                "Signature name or email contains reserved characters",
            ));
        }
        Ok(format!(
            "{} <{}> {} {}",
            self.name, self.email, self.seconds, self.offset
        ))
    }
    pub(super) fn parse(line: &str) -> Result<Self> {
        let bad = || invalid("Malformed signature line");
        let (ident, when) = line.rsplit_once("> ").ok_or_else(bad)?;
        let (name, email) = ident.rsplit_once(" <").ok_or_else(bad)?;
        let (seconds, offset) = when.split_once(' ').ok_or_else(bad)?;
        let signature = Self {
            name: name.to_owned(),
            email: email.to_owned(),
            seconds: seconds.parse().map_err(|_| bad())?,
            offset: TzOffset::parse(offset)?,
        };
        signature.encode()?;
        Ok(signature)
    }
}
