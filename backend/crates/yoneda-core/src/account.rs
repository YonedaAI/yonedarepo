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
