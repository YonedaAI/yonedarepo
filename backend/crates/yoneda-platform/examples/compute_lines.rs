//! `platform_compute` over standard input: one JSON request a line, one JSON answer a line, for
//! tools that must run the platform's own code on real data with no Worker in between
//! (`tools/risk-calibrate`). An error answers `{"error": ...}` and the stream goes on.
use std::io::{BufRead, Write, stdin, stdout};

use serde_json::{Value, json};
use yoneda_platform::platform_compute;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut out = stdout().lock();
    for line in stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line?)?;
        let answer = platform_compute(request).unwrap_or_else(|e| json!({"error": e.to_string()}));
        writeln!(out, "{answer}")?;
        out.flush()?;
    }
    Ok(())
}
