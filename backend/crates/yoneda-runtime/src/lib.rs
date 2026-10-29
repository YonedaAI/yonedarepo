//! The platform check executor that runs inside the CheckContainer image.
use yoneda_core::Error;
pub mod check_runner;
#[cfg(all(test, unix))]
mod check_runner_tests;
mod check_server;
pub mod check_stream;
#[cfg(all(test, unix))]
mod check_stream_tests;
mod process_privileges;
mod telemetry;
pub use check_server::serve_checks;
pub use telemetry::init_telemetry;
fn err(e: impl std::fmt::Display) -> Error {
    Error::new("RUNTIME", e.to_string())
}
