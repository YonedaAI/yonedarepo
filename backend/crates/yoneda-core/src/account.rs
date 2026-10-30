//! Account identifiers shared by native and deployed signup. Emails are identifiers,
//! not verified contact addresses; existing username workspaces retain their identity.
use crate::{Error, Result};

pub const MAX_ACCOUNT_IDENTIFIER_BYTES: usize = 254;
pub const ACCOUNT_IDENTIFIER_HELP: &str = "Use a username (3–32 letters, digits or underscores, starting with a letter) or an email address";

/// Normalize a username or practical ASCII email without collapsing dots or plus tags.
/// All identifiers are case-insensitive and must remain distinct from operator identities.
pub fn normalize_account_identifier(value: &str) -> Result<String> {
    let value = value.trim();
    if !value.is_ascii() || value.len() > MAX_ACCOUNT_IDENTIFIER_BYTES {
        return Err(Error::new("INVALID_INPUT", ACCOUNT_IDENTIFIER_HELP));
    }
    let value = value.to_ascii_lowercase();
    let valid = if let Some((local, domain)) = value.split_once('@') {
        valid_email(local, domain)
    } else {
        (3..=32).contains(&value.len())
            && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
            && value
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    };
    if !valid {
        return Err(Error::new("INVALID_INPUT", ACCOUNT_IDENTIFIER_HELP));
    }
    Ok(value)
}

/// Names that are top-level paths of the website, the app or the Workers, and a few kept
/// for the platform: `/<handle>` is a profile and `/<handle>/<repository>` a repository, so
/// no account, organization or handle may take one. Sorted. `shared/contracts/
/// reserved-handles.ts` carries the list to TypeScript, where a test fails while a routed
/// top-level path is missing from it. Accounts made before keep their names.
pub const RESERVED_HANDLES: &[&str] = &[
    "about",
    "account",
    "accounts",
    "admin",
    "agents",
    "anonymous",
    "api",
    "app",
    "apps",
    "assets",
    "auth",
    "billing",
    "blog",
    "brand",
    "cdn",
    "cli",
    "company",
    "dashboard",
    "device",
    "docs",
    "download",
    "downloads",
    "explore",
    "favicon",
    "features",
    "git",
    "health",
    "help",
    "home",
    "hooks",
    "install",
    "internal",
    "legal",
    "login",
    "logout",
    "manage",
    "managed",
    "mcp",
    "new",
    "notifications",
    "null",
    "oauth",
    "org",
    "organizations",
    "orgs",
    "pricing",
    "privacy",
    "profile",
    "profiles",
    "public",
    "raw",
    "repo",
    "repos",
    "repositories",
    "resolve",
    "robots",
    "root",
    "search",
    "security",
    "settings",
    "signin",
    "signout",
    "signup",
    "sitemap",
    "source",
    "sso",
    "static",
    "status",
    "support",
    "system",
    "team",
    "teams",
    "terms",
    "undefined",
    "user",
    "users",
    "webhooks",
    "www",
    "yoneda",
    "yonedarepo",
];

pub const HANDLE_HELP: &str =
    "Handles are 3–32 letters, digits or underscores, starting with a letter";

/// A handle as URLs carry it: a username's shape, lowercased, never an email address
/// (`HANDLE_INVALID`) or a reserved name (`HANDLE_RESERVED`).
pub fn normalize_handle(value: &str) -> Result<String> {
    let name = normalize_account_identifier(value)
        .ok()
        .filter(|name| !name.contains('@'))
        .ok_or_else(|| Error::new("HANDLE_INVALID", HANDLE_HELP))?;
    if is_reserved_handle(&name) {
        return Err(Error::new(
            "HANDLE_RESERVED",
            format!("{name} is reserved for the website's own pages"),
        ));
    }
    Ok(name)
}

/// Whether `name` (lowercase) is reserved (`RESERVED_HANDLES`).
pub fn is_reserved_handle(name: &str) -> bool {
    RESERVED_HANDLES.binary_search(&name).is_ok()
}

fn valid_email(local: &str, domain: &str) -> bool {
    if local.is_empty()
        || local.len() > 64
        || local.starts_with('.')
        || local.ends_with('.')
        || local.contains("..")
        || !local
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".!#$%&'*+/=?^_`{|}~-".contains(&b))
        || !domain.contains('.')
    {
        return false;
    }
    domain.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            && label
                .as_bytes()
                .last()
                .is_some_and(u8::is_ascii_alphanumeric)
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        input: String,
        canonical: Option<String>,
    }

    #[test]
    fn matches_the_browser_and_transport_contract_cases() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("account_identifiers.json")).unwrap();
        for case in cases {
            assert_eq!(
                normalize_account_identifier(&case.input).ok(),
                case.canonical,
                "{}",
                case.input
            );
        }
    }

    #[test]
    fn handles_are_usernames_never_addresses_or_reserved_names() {
        assert!(RESERVED_HANDLES.windows(2).all(|w| w[0] < w[1]), "sorted");
        for name in RESERVED_HANDLES {
            assert_eq!(
                normalize_account_identifier(name).ok().as_deref(),
                Some(*name)
            );
            assert_eq!(normalize_handle(name).unwrap_err().code, "HANDLE_RESERVED");
        }
        assert_eq!(normalize_handle(" Ada_Lovelace ").unwrap(), "ada_lovelace");
        for invalid in ["ada@example.com", "ab", "1ada", "ada-l", &"a".repeat(33)] {
            assert_eq!(
                normalize_handle(invalid).unwrap_err().code,
                "HANDLE_INVALID"
            );
        }
    }

    #[test]
    fn enforces_email_and_username_length_boundaries() {
        let max = format!(
            "{}@{}.{}.{}",
            "a".repeat(64),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(61)
        );
        assert_eq!(max.len(), 254);
        assert!(normalize_account_identifier(&max).is_ok());
        assert!(normalize_account_identifier(&(max + "e")).is_err());
        assert!(normalize_account_identifier(&format!("{}@example.com", "a".repeat(65))).is_err());
        assert!(normalize_account_identifier(&"a".repeat(32)).is_ok());
        assert!(normalize_account_identifier(&"a".repeat(33)).is_err());
    }
}
