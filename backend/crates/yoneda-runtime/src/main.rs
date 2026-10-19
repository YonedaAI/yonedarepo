#[tokio::main]
async fn main() {
    yoneda_runtime::init_telemetry();
    let result = match std::env::args().nth(1).as_deref() {
        Some("mcp") => yoneda_runtime::mcp().await,
        Some("check-server") => yoneda_runtime::serve_checks().await,
        _ => yoneda_runtime::serve().await,
    };
    if let Err(e) = result {
        tracing::error!(event = "runtime.stopped", error_code = %e.code);
        std::process::exit(1);
    }
}
