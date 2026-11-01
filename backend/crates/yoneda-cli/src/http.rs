//! The CLI's HTTP client, and the mark our own tools ask for: `YONEDA_OWN_TRAFFIC=1` sends
//! `x-yoneda-own-traffic: 1` so the platform's analytics leave the run out (tools/own-traffic.mjs
//! sets it for the live tests). The header unlocks nothing and nothing else reads the variable.
use crate::error::{Error, Result};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

const OWN_TRAFFIC: &str = "x-yoneda-own-traffic";

fn marked(value: Option<&str>) -> bool {
    value == Some("1")
}

fn marked_by_environment() -> bool {
    marked(std::env::var("YONEDA_OWN_TRAFFIC").ok().as_deref())
}

/// The client every platform call goes through.
pub(crate) fn client() -> Result<reqwest::Client> {
    let mut headers = HeaderMap::new();
    if marked_by_environment() {
        headers.insert(
            HeaderName::from_static(OWN_TRAFFIC),
            HeaderValue::from_static("1"),
        );
    }
    reqwest::Client::builder()
        .user_agent(concat!("yoneda-cli/", env!("CARGO_PKG_VERSION")))
        .default_headers(headers)
        .build()
        .map_err(|e| Error::new(format!("building the HTTP client: {e}")))
}

#[cfg(test)]
mod tests {
    use super::marked;

    #[test]
    fn only_one_marks_a_run() {
        assert!(marked(Some("1")));
        for value in [None, Some(""), Some("0"), Some("yes"), Some("true")] {
            assert!(!marked(value), "{value:?}");
        }
    }
}
