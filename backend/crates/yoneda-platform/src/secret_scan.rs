//! Secret scanning for committed content. A commit carrying a credential is refused before
//! it is built, so the secret never reaches history, an object store or a clone. Text the
//! platform keeps rather than commits (session transcripts) is redacted instead. Rules
//! match a credential's full shape, not its prefix alone: a prefix in prose, a lockfile
//! hash or a token-like word inside a longer one is not a secret. One pass over the bytes,
//! dispatched on the first byte; no network and no regular expressions.
use serde::{Deserialize, Serialize};
use std::cell::OnceCell;
use yoneda_core::{Error, Result};

mod redact;
pub use redact::redact;

/// The rule names a policy's `secret_allow` may list.
pub const RULES: [&str; 11] = [
    "aws-access-key",
    "github-token",
    "github-pat",
    "anthropic-key",
    "openai-key",
    "mimo-key",
    "slack-token",
    "stripe-live-key",
    "private-key",
    "yonedarepo-token",
    "yonedarepo-pat",
];

/// A false positive the owner accepted: `rule` may match in `path`, a file or a directory
/// ending in `/`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SecretAllow {
    pub path: String,
    pub rule: String,
}

impl SecretAllow {
    fn covers(&self, path: &str, rule: &str) -> bool {
        self.rule == rule
            && (self.path == path || self.path.ends_with('/') && path.starts_with(&self.path))
    }
}

pub fn validate_allow(allow: &[SecretAllow]) -> Result<()> {
    let valid = |a: &SecretAllow| {
        RULES.contains(&a.rule.as_str())
            && !a.path.is_empty()
            && a.path.len() <= 4096
            && !a.path.starts_with('/')
            && !a.path.contains('\0')
    };
    if allow.len() > 256 || !allow.iter().all(valid) {
        return Err(Error::new(
            "INVALID_INPUT",
            format!(
                "secret_allow lists at most 256 {{path, rule}} entries with a relative path and one of: {}",
                RULES.join(", ")
            ),
        ));
    }
    Ok(())
}

/// Refuses `bytes` committed at `path` when they hold a credential that `allow` does not
/// excuse. The error names the path, line and rule, never the secret.
pub fn scan(path: &str, bytes: &[u8], allow: &[SecretAllow]) -> Result<()> {
    let Some((rule, at)) = find(bytes, &|rule| allow.iter().any(|a| a.covers(path, rule))) else {
        return Ok(());
    };
    let line = 1 + bytes[..at].iter().filter(|b| **b == b'\n').count();
    Err(Error::new(
        "SECRET_DETECTED",
        format!(
            "{path} line {line} looks like a credential ({rule}). Remove it and rotate it if it was real; \
             if it is not a secret, the repository owner can allow {{\"path\": \"{path}\", \"rule\": \"{rule}\"}} in policy secret_allow"
        ),
    ))
}

/// A rule's name and the end of its match.
type Rule = Option<(&'static str, usize)>;

pub(super) const AWS_SECRET: usize = 40;
const AWS_REACH: usize = 1024;

/// The rules over one text. AWS secret positions are found once per text, so a text of key
/// ids stays linear.
pub(super) struct Scanner<'a> {
    bytes: &'a [u8],
    aws_secrets: OnceCell<Vec<usize>>,
}

impl<'a> Scanner<'a> {
    pub(super) fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            aws_secrets: OnceCell::new(),
        }
    }

    pub(super) fn rule_at(&self, i: usize) -> Rule {
        let bytes = self.bytes;
        match bytes[i] {
            b'A' => self.aws(i),
            b'g' => github(bytes, i),
            b's' => sk(bytes, i),
            b'r' => after(bytes, i, b"rk_live_")
                .and_then(|e| alnum_run(bytes, e, 24))
                .map(|end| ("stripe-live-key", end)),
            b't' => mimo(bytes, i),
            b'x' => slack(bytes, i),
            b'y' => ours(bytes, i),
            b'-' => private_key(bytes, i),
            _ => None,
        }
    }

    fn secrets(&self) -> &[usize] {
        self.aws_secrets.get_or_init(|| aws_secrets(self.bytes))
    }

    /// Starts of the secret access keys within reach of the key id at `start..end`.
    pub(super) fn aws_secrets_near(
        &self,
        start: usize,
        end: usize,
    ) -> impl Iterator<Item = usize> + '_ {
        let secrets = self.secrets();
        let first = secrets.partition_point(|at| *at + AWS_REACH < start);
        secrets[first..]
            .iter()
            .copied()
            .take_while(move |at| *at <= end + AWS_REACH)
    }

    /// An AWS access key id with a secret access key within 1 KiB of it (an id alone is
    /// not a secret).
    fn aws(&self, i: usize) -> Rule {
        let bytes = self.bytes;
        let e = after(bytes, i, b"AKIA").or_else(|| after(bytes, i, b"ASIA"))?;
        let id = run(bytes, e, |b| b.is_ascii_uppercase() || b.is_ascii_digit());
        if id != 16 || bytes[e..e + id].ends_with(b"EXAMPLE") {
            return None;
        }
        let end = e + id;
        self.aws_secrets_near(i, end)
            .next()
            .map(|_| ("aws-access-key", end))
    }
}

/// The first match `allowed` does not excuse: its rule and byte offset.
fn find(bytes: &[u8], allowed: &dyn Fn(&str) -> bool) -> Option<(&'static str, usize)> {
    let scanner = Scanner::new(bytes);
    (0..bytes.len()).find_map(|i| {
        let (rule, _) = scanner.rule_at(i)?;
        (!allowed(rule)).then_some((rule, i))
    })
}

fn word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// The end of `prefix` when it starts at `i` on a word boundary.
fn after(bytes: &[u8], i: usize, prefix: &[u8]) -> Option<usize> {
    let boundary = i == 0 || !word(bytes[i - 1]) && bytes[i - 1] != b'-';
    (boundary && bytes[i..].starts_with(prefix)).then_some(i + prefix.len())
}

/// Length of the run from `start` of bytes satisfying `class`.
fn run(bytes: &[u8], start: usize, class: impl Fn(u8) -> bool) -> usize {
    bytes[start..].iter().take_while(|b| class(**b)).count()
}

/// The end of a run of at least `min` letters and digits from `start`.
fn alnum_run(bytes: &[u8], start: usize, min: usize) -> Option<usize> {
    let n = run(bytes, start, |b| b.is_ascii_alphanumeric());
    (n >= min).then_some(start + n)
}

/// Random-looking: letters and digits both present.
fn mixed(text: &[u8]) -> bool {
    text.iter().any(u8::is_ascii_digit) && text.iter().any(u8::is_ascii_alphabetic)
}

fn github(bytes: &[u8], i: usize) -> Rule {
    if let Some(e) = after(bytes, i, b"github_pat_") {
        let n = run(bytes, e, word);
        return (n >= 80).then_some(("github-pat", e + n));
    }
    let e = after(bytes, i, b"gh")?;
    let kind = *bytes.get(e)?;
    let shaped = b"pousr".contains(&kind)
        && bytes.get(e + 1) == Some(&b'_')
        && run(bytes, e + 2, |b| b.is_ascii_alphanumeric()) == 36;
    shaped.then_some(("github-token", e + 38))
}

fn sk(bytes: &[u8], i: usize) -> Rule {
    let token = |b: u8| word(b) || b == b'-';
    if let Some(e) = after(bytes, i, b"sk-ant-") {
        let n = run(bytes, e, token);
        return (n >= 80).then_some(("anthropic-key", e + n));
    }
    if let Some(e) = after(bytes, i, b"sk_live_") {
        return alnum_run(bytes, e, 24).map(|end| ("stripe-live-key", end));
    }
    for prefix in [&b"sk-proj-"[..], b"sk-svcacct-", b"sk-admin-"] {
        if let Some(e) = after(bytes, i, prefix) {
            let n = run(bytes, e, token);
            return (n >= 40).then_some(("openai-key", e + n));
        }
    }
    let e = after(bytes, i, b"sk-")?;
    let n = run(bytes, e, |b| b.is_ascii_alphanumeric());
    (n >= 32 && mixed(&bytes[e..e + n])).then_some(("openai-key", e + n))
}

/// MiMo Token Plan keys (`tp-`, `ttp-`).
fn mimo(bytes: &[u8], i: usize) -> Rule {
    let e = after(bytes, i, b"tp-").or_else(|| after(bytes, i, b"ttp-"))?;
    let n = run(bytes, e, |b| b.is_ascii_alphanumeric());
    (n >= 40 && mixed(&bytes[e..e + n])).then_some(("mimo-key", e + n))
}

fn slack(bytes: &[u8], i: usize) -> Rule {
    let e = after(bytes, i, b"xox")?;
    if !b"abprs".contains(bytes.get(e)?) || bytes.get(e + 1) != Some(&b'-') {
        return None;
    }
    let n = run(bytes, e + 2, |b| b.is_ascii_alphanumeric() || b == b'-');
    let body = &bytes[e + 2..e + 2 + n];
    (n >= 30 && body.iter().filter(|b| **b == b'-').count() >= 2)
        .then_some(("slack-token", e + 2 + n))
}

/// Our own repository tokens and personal access tokens: 32 random bytes, base64url.
fn ours(bytes: &[u8], i: usize) -> Rule {
    let (e, rule) = after(bytes, i, b"yrp_")
        .map(|e| (e, "yonedarepo-token"))
        .or_else(|| after(bytes, i, b"ypat_").map(|e| (e, "yonedarepo-pat")))?;
    (run(bytes, e, |b| word(b) || b == b'-') == 43).then_some((rule, e + 43))
}

/// A PEM private key: its header followed by key material, not the header named in prose.
/// The match ends with its `-----END …-----` footer, or without one, its last body line.
fn private_key(bytes: &[u8], i: usize) -> Rule {
    let e = after(bytes, i, b"-----BEGIN ")?;
    let label = run(bytes, e, |b| b.is_ascii_uppercase() || b == b' ');
    let rest = &bytes[e + label..];
    let named = bytes[e..e + label].ends_with(b"PRIVATE KEY")
        || bytes[e..e + label].ends_with(b"PRIVATE KEY BLOCK");
    if !named || label > 40 || !rest.starts_with(b"-----") {
        return None;
    }
    let base64 = |b: u8| b.is_ascii_alphanumeric() || b"+/=".contains(&b);
    // Header lines (`Proc-Type: ...`) and blank lines may precede the base64 body.
    let mut at = e + label + 5;
    let mut body_end = None;
    for (n, raw) in bytes[at..].split(|b| *b == b'\n').enumerate() {
        let line_end = at + raw.len();
        let line = raw.strip_suffix(b"\r").unwrap_or(raw);
        at = line_end + 1;
        if n == 0 {
            continue;
        }
        let body = !line.is_empty() && !line.contains(&b':') && line.iter().all(|b| base64(*b));
        match body_end {
            None if n > 8 => return None,
            None if body && line.len() >= 32 => body_end = Some(line_end),
            None if line.is_empty() || line.contains(&b':') => {}
            None => return None,
            Some(_) if body => body_end = Some(line_end),
            Some(_) => break,
        }
    }
    let body_end = body_end?;
    let footer = bytes[body_end..]
        .windows(9)
        .position(|w| w == b"-----END ")
        .filter(|p| {
            bytes[body_end..body_end + p]
                .iter()
                .all(u8::is_ascii_whitespace)
        })
        .and_then(|p| {
            let start = body_end + p + 9;
            let close = bytes[start..].windows(5).position(|w| w == b"-----")?;
            (close <= 40).then_some(start + close + 5)
        });
    Some(("private-key", footer.unwrap_or(body_end)))
}

/// Starts of every 40-character mixed-case run of `[A-Za-z0-9/+]` (not base64 padding).
fn aws_secrets(bytes: &[u8]) -> Vec<usize> {
    let class = |b: u8| b.is_ascii_alphanumeric() || b == b'/' || b == b'+';
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let n = run(bytes, at, class);
        let secret = &bytes[at..at + n];
        if n == AWS_SECRET
            && secret.iter().any(u8::is_ascii_uppercase)
            && secret.iter().any(u8::is_ascii_lowercase)
            && secret.iter().any(u8::is_ascii_digit)
            && bytes.get(at + n) != Some(&b'=')
        {
            found.push(at);
        }
        at += n.max(1);
    }
    found
}

#[cfg(test)]
#[path = "secret_scan_tests.rs"]
mod tests;
