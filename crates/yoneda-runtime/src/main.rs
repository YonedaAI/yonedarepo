#[tokio::main]
async fn main() {
    let result = if std::env::args().nth(1).as_deref() == Some("mcp") {
        yoneda_runtime::mcp().await
    } else {
        yoneda_runtime::serve().await
    };
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
