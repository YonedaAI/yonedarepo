//! Root-only entrypoint for registered API-source capture.
pub(crate) use crate::source_capture_runner::execute;

#[cfg(test)]
#[path = "source_capture_validation.rs"]
mod validation;
#[cfg(test)]
pub(crate) use validation::capture_delta;
