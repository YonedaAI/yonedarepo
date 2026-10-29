//! The `--json` failure document (`yoneda.cli.error.v1`).
use crate::error::Error;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Why a command failed, as a stable code a script can branch on (the message is for
/// people and may change).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// A malformed command line (exit code 64).
    Usage,
    /// Concurrent work collided: a refused landing or rebase (exit code 2 for those).
    Conflict,
    /// No usable credential: the platform answered 401.
    Auth,
    /// The credential may not do this: the platform answered 403.
    Forbidden,
    /// The platform has no such repository, branch, change or record (404).
    NotFound,
    /// The platform could not be reached.
    Unreachable,
    /// The platform or its gateway is over its limits or down (502/503/504); retry later.
    Unavailable,
    /// The platform refused the request for another reason (`platform_code` says which).
    Platform,
    /// Anything else: local state, files, unexpected answers.
    Failed,
}

/// A failed command.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ErrorReport {
    pub code: ErrorCode,
    /// The same message the human mode prints after `yoneda: `.
    pub message: String,
    /// The process exit code (also set under `--json`).
    pub exit_code: i32,
    /// The platform's own error code (`NOT_FOUND`, `STALE_PARENT`, ...), when the platform
    /// refused the request.
    pub platform_code: Option<String>,
}

super::report!(ErrorReport => "error");

impl From<&Error> for ErrorReport {
    fn from(error: &Error) -> Self {
        Self {
            code: error.code,
            message: error.message.clone(),
            exit_code: error.exit_code,
            platform_code: error.platform_code.clone(),
        }
    }
}

/// The stable code for a platform answer with HTTP `status` and platform `code`.
pub fn platform(status: u16, code: &str) -> ErrorCode {
    match (status, code) {
        (_, "CONFLICT") | (409, _) => ErrorCode::Conflict,
        (401, _) => ErrorCode::Auth,
        (403, _) => ErrorCode::Forbidden,
        (404, _) => ErrorCode::NotFound,
        (0, "UNREACHABLE") => ErrorCode::Unreachable,
        (502..=504, _) => ErrorCode::Unavailable,
        _ => ErrorCode::Platform,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_answers_map_to_stable_codes() {
        assert_eq!(platform(409, "STALE_PARENT"), ErrorCode::Conflict);
        assert_eq!(platform(400, "CONFLICT"), ErrorCode::Conflict);
        assert_eq!(platform(401, "UNAUTHENTICATED"), ErrorCode::Auth);
        assert_eq!(platform(403, "FORBIDDEN"), ErrorCode::Forbidden);
        assert_eq!(platform(404, "NOT_FOUND"), ErrorCode::NotFound);
        assert_eq!(platform(0, "UNREACHABLE"), ErrorCode::Unreachable);
        assert_eq!(platform(0, "MALFORMED_RESPONSE"), ErrorCode::Platform);
        assert_eq!(platform(503, "OVERLOADED"), ErrorCode::Unavailable);
        assert_eq!(platform(422, "INVALID"), ErrorCode::Platform);
    }
}
