#[tokio::main]
async fn main() {
    yoneda_runtime::init_telemetry();
    let result = if std::env::args().nth(1).as_deref() == Some("mcp") {
        yoneda_runtime::mcp().await
    } else {
        yoneda_runtime::serve().await
    };
    if let Err(e) = result {
        tracing::error!(event = "runtime.stopped", error_code = %e.code);
        std::process::exit(1);
    }
}
