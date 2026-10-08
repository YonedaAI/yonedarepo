mod bootstrap;
mod commands;
mod dev;
mod live;
mod process;
mod verification;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
        .to_path_buf();
    std::env::set_current_dir(root).expect("workspace exists");
    if let Err(error) = commands::execute(std::env::args().skip(1).collect()).await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
