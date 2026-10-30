//! The account's picture. A sign-in identity carries the avatar URL its provider reported
//! (kept only on that provider's own image hosts, refreshed on every sign-in and link); an
//! uploaded picture, typed by its leading bytes and at most 1 MiB, wins over it. The
//! adapter stores an upload's bytes in the object store under the key this returns, serves
//! them from our origin, and redirects to a provider's picture; it never fetches one.
use super::op::AvatarOp;
use super::*;

/// The largest uploaded picture, in bytes.
pub(super) const MAX_BYTES: i64 = 1024 * 1024;
/// Leading bytes the adapter sends for the type check.
const HEAD_BYTES: i64 = 16;
const MAX_URL: usize = 1024;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: AvatarOp, now: i64) -> Result<Value> {
    let a = account(db)?;
    match op {
        // What the browser needs: where the picture comes from and a version for its URL.
        AvatarOp::Get => Ok(match (uploaded(db)?, provider_picture(db)?) {
            (Some(up), _) => json!({"source":"upload","version":&up.digest[..12]}),
            (None, Some(url)) => json!({"source":"provider","version":version(&url)}),
            (None, None) => json!({"source":null,"version":null}),
        }),
        // What the adapter serves: the upload's bytes, or a redirect to the provider's.
        AvatarOp::Serve => Ok(match (uploaded(db)?, provider_picture(db)?) {
            (Some(up), _) => {
                json!({"upload":{"key":up.key,"content_type":up.content_type,"digest":up.digest}})
            }
            (None, Some(url)) => json!({ "provider_url": url }),
            (None, None) => json!({}),
        }),
        AvatarOp::Upload => upload(db, c, &a, now),
        AvatarOp::Remove => {
            let current = uploaded(db)?;
            // The adapter's rollback names the upload it made; a newer one stays.
            let guard = match c.get("digest") {
                None | Some(Value::Null) => None,
                Some(_) => Some(hash(c, "digest", &[64])?),
            };
            let Some(current) = current.filter(|u| guard.is_none_or(|d| d == u.digest)) else {
                return Ok(json!({"previous_key":null}));
            };
            db.query("DELETE FROM account_avatar", &[])?;
            audit(db, "avatar.removed", now, json!({}))?;
            Ok(json!({"previous_key":current.key}))
        }
    }
}

struct Upload {
    key: String,
    content_type: String,
    digest: String,
}

fn upload<S: SqlStore>(db: &S, c: &Value, a: &Value, now: i64) -> Result<Value> {
    let size = c["size"]
        .as_i64()
        .filter(|n| (1..=MAX_BYTES).contains(n))
        .ok_or_else(|| bad("A picture must be 1 byte to 1 MB"))?;
    let digest = hash(c, "digest", &[64])?;
    if digest != digest.to_ascii_lowercase() {
        return Err(bad("Invalid digest"));
    }
    let head = string(c, "head")?;
    let expected = 2 * size.min(HEAD_BYTES) as usize;
    let bytes = (head.len() == expected && head.len() % 2 == 0)
        .then(|| {
            (0..head.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&head[i..i + 2], 16).ok())
                .collect::<Option<Vec<u8>>>()
        })
        .flatten()
        .ok_or_else(|| bad("head must be the picture's first 16 bytes, as hex"))?;
    let content_type = sniff(&bytes).ok_or_else(|| bad("Use a PNG, JPEG or WebP picture"))?;
    let username = a["username"].as_str().unwrap_or_default();
    // Keyed by digests only: the key names neither the account nor anything it uploaded.
    let key = format!(
        "avatars/{}/{digest}",
        &yoneda_core::digest(username.as_bytes())[..32]
    );
    let previous = uploaded(db)?.map(|u| u.key).filter(|k| *k != key);
    db.query(
        "INSERT INTO account_avatar(id,object_key,content_type,size,digest,uploaded_at) VALUES(1,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET object_key=excluded.object_key,content_type=excluded.content_type,
         size=excluded.size,digest=excluded.digest,uploaded_at=excluded.uploaded_at",
        &[json!(key), json!(content_type), json!(size), json!(digest), json!(now)],
    )?;
    audit(
        db,
        "avatar.uploaded",
        now,
        json!({"content_type":content_type,"size":size}),
    )?;
    Ok(json!({
        "key": key,
        "content_type": content_type,
        "previous_key": previous,
        "version": &digest[..12],
    }))
}

/// The picture type its leading bytes show: PNG, JPEG or WebP, nothing else.
fn sniff(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if head.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// A short version for a provider picture's URL, so a browser fetches a changed one (an
/// upload's is its digest's prefix).
fn version(of: &str) -> String {
    yoneda_core::digest(of.as_bytes())[..12].to_string()
}

fn uploaded<S: SqlStore>(db: &S) -> Result<Option<Upload>> {
    Ok(db
        .query(
            "SELECT object_key,content_type,digest FROM account_avatar WHERE id=1",
            &[],
        )?
        .into_iter()
        .next()
        .map(|row| Upload {
            key: row["object_key"].as_str().unwrap_or_default().to_string(),
            content_type: row["content_type"].as_str().unwrap_or_default().to_string(),
            digest: row["digest"].as_str().unwrap_or_default().to_string(),
        }))
}

/// The most recently used identity's provider picture, if any carries one.
fn provider_picture<S: SqlStore>(db: &S) -> Result<Option<String>> {
    Ok(db
        .query(
            "SELECT avatar_url FROM account_identities WHERE avatar_url IS NOT NULL
             ORDER BY last_used_at DESC, provider LIMIT 1",
            &[],
        )?
        .into_iter()
        .next()
        .and_then(|row| row["avatar_url"].as_str().map(str::to_string)))
}

/// A provider's avatar URL from a sign-in command, kept only when it is an `https` URL on
/// that provider's own image hosts (no port, no credentials, nothing a page could misread).
/// Anything else is no picture: a bad one never blocks the sign-in.
pub(super) fn provider_avatar(provider: &str, c: &Value) -> Option<String> {
    let url = c.get("avatar_url")?.as_str()?;
    let hosts: &[&str] = match provider {
        "github" => &["avatars.githubusercontent.com"],
        "google" => &[
            "lh3.googleusercontent.com",
            "lh4.googleusercontent.com",
            "lh5.googleusercontent.com",
            "lh6.googleusercontent.com",
        ],
        _ => return None,
    };
    let rest = url.strip_prefix("https://")?;
    let host = &rest[..rest.find('/')?];
    let safe = url.len() <= MAX_URL
        && url
            .bytes()
            .all(|b| b.is_ascii_graphic() && !b"\"'<>\\`".contains(&b));
    (safe && hosts.contains(&host)).then(|| url.to_string())
}
