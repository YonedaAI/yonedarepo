//! Production JSON diagnostics. Only application targets are enabled, so HTTP
//! clients cannot accidentally emit credentials through dependency debug logs.
use tracing_subscriber::{filter::LevelFilter, prelude::*};

/// Install once from the executable; libraries never replace a host subscriber.
/// Diagnostics use stderr so scoped MCP stdout remains a protocol stream.
pub fn init_telemetry() {
    let level = std::env::var("YONEDA_LOG_LEVEL")
        .ok()
        .and_then(|value| value.parse::<LevelFilter>().ok())
        .unwrap_or(LevelFilter::INFO);
    let targets = tracing_subscriber::filter::Targets::new().with_target("yoneda_runtime", level);
    let _ = tracing_subscriber::registry()
        .with(targets)
        .with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_writer(std::io::stderr),
        )
        .try_init();
}
