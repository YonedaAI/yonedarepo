//! Named points where crash tests stop the service: with `YONEDA_LOCAL_PAUSE=<point>` the
//! service writes `YONEDA_LOCAL_PAUSE_FILE` on reaching it and waits there to be killed.
//! Unset (always, outside the tests in `tests/local.rs`), a point does nothing.
pub fn point(name: &str) {
    if std::env::var("YONEDA_LOCAL_PAUSE").as_deref() != Ok(name) {
        return;
    }
    if let Ok(file) = std::env::var("YONEDA_LOCAL_PAUSE_FILE") {
        let _ = std::fs::write(file, name);
    }
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
