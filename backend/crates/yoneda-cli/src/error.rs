//! CLI errors: a message for the person at the terminal, the process exit code, and a
//! stable code for `--json` (`output::ErrorReport`).
pub use crate::output::ErrorCode;
use std::fmt;

/// Exit code for a landing refused with conflicts (conflict files were written).
pub const EXIT_CONFLICT: i32 = 2;
/// Exit code for a malformed command line.
pub const EXIT_USAGE: i32 = 64;

#[derive(Debug)]
pub struct Error {
    pub message: String,
    pub exit_code: i32,
    pub code: ErrorCode,
    /// The platform's error code when the platform refused the request.
    pub platform_code: Option<String>,
}

impl Error {
    fn with(message: impl Into<String>, exit_code: i32, code: ErrorCode) -> Self {
        Self {
            message: message.into(),
            exit_code,
            code,
            platform_code: None,
        }
    }
    pub fn new(message: impl Into<String>) -> Self {
        Self::with(message, 1, ErrorCode::Failed)
    }
    pub fn usage(message: impl Into<String>) -> Self {
        Self::with(message, EXIT_USAGE, ErrorCode::Usage)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::with(message, EXIT_CONFLICT, ErrorCode::Conflict)
    }
    /// The same error, refused by the platform with `code`.
    pub fn from_platform(mut self, code: &str) -> Self {
        self.platform_code = Some(code.to_owned());
        self
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// Adds what the CLI was doing to a lower-level error.
pub trait Context<T> {
    fn context(self, what: impl fmt::Display) -> Result<T>;
}

impl<T, E: fmt::Display> Context<T> for std::result::Result<T, E> {
    fn context(self, what: impl fmt::Display) -> Result<T> {
        self.map_err(|e| Error::new(format!("{what}: {e}")))
    }
}
