//! CLI errors: a message for the person at the terminal and the process exit code.
use std::fmt;

/// Exit code for a landing refused with conflicts (conflict files were written).
pub const EXIT_CONFLICT: i32 = 2;
/// Exit code for a malformed command line.
pub const EXIT_USAGE: i32 = 64;

#[derive(Debug)]
pub struct Error {
    pub message: String,
    pub exit_code: i32,
}

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit_code: 1,
        }
    }
    pub fn usage(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit_code: EXIT_USAGE,
        }
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            exit_code: EXIT_CONFLICT,
        }
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
