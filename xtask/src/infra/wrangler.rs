//! Wrangler subprocesses for one account. Wrangler authenticates itself (OAuth login or
//! `CLOUDFLARE_API_TOKEN`); this module never sees or stores a credential. The binary is
//! called directly rather than through pnpm, so it also works in worktrees whose
//! node_modules is a symlink.
use crate::process::Result;
use std::io::Write;
use std::process::{Command, Stdio};

const WRANGLER: &str = "node_modules/.bin/wrangler";

fn command(account_id: &str, args: &[&str]) -> Command {
    let mut command = Command::new(WRANGLER);
    command.args(args).env("CLOUDFLARE_ACCOUNT_ID", account_id);
    command
}

fn describe(args: &[&str]) -> String {
    format!("wrangler {}", args.join(" "))
}

/// Runs with inherited output; fails on a non-zero exit.
pub(crate) fn run(account_id: &str, args: &[&str]) -> Result<()> {
    println!("$ {}", describe(args));
    let status = command(account_id, args)
        .status()
        .map_err(|error| format!("Cannot start {WRANGLER}: {error}"))?;
    if !status.success() {
        return Err(format!("{} failed ({status})", describe(args)).into());
    }
    Ok(())
}

/// Captures stdout (for `--json` listings); stderr stays visible.
pub(crate) fn output(account_id: &str, args: &[&str]) -> Result<Vec<u8>> {
    let out = command(account_id, args)
        .stderr(Stdio::inherit())
        .output()
        .map_err(|error| format!("Cannot start {WRANGLER}: {error}"))?;
    if !out.status.success() {
        return Err(format!("{} failed ({})", describe(args), out.status).into());
    }
    Ok(out.stdout)
}

/// Feeds `input` (a secret payload) through stdin, so it never appears in arguments,
/// files or logs.
pub(crate) fn run_with_stdin(account_id: &str, args: &[&str], input: &[u8]) -> Result<()> {
    println!("$ {} < (stdin)", describe(args));
    let mut child = command(account_id, args)
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Cannot start {WRANGLER}: {error}"))?;
    child
        .stdin
        .take()
        .ok_or("Missing wrangler stdin pipe")?
        .write_all(input)?;
    let status = child.wait()?;
    if !status.success() {
        return Err(format!("{} failed ({status})", describe(args)).into());
    }
    Ok(())
}

/// Prints `title` and a fixed-width table; in GitHub Actions also appends it to the job
/// summary as Markdown, so a run is readable without the raw log.
pub(crate) fn table(title: &str, headers: &[&str], rows: &[Vec<String>]) {
    println!("{title}");
    print_table(headers, rows);
    if let Some(path) = std::env::var_os("GITHUB_STEP_SUMMARY")
        && let Err(error) = append_markdown(std::path::Path::new(&path), title, headers, rows)
    {
        eprintln!("Could not write the job summary: {error}");
    }
}

pub(crate) fn markdown(title: &str, headers: &[&str], rows: &[Vec<String>]) -> String {
    let cell = |c: &str| c.replace('|', "\\|").replace('\n', " ");
    let mut out = format!(
        "### {}\n\n| {} |\n|{}\n",
        cell(title),
        headers.join(" | "),
        " --- |".repeat(headers.len())
    );
    for row in rows {
        let cells: Vec<String> = row.iter().map(|c| cell(c)).collect();
        out.push_str(&format!("| {} |\n", cells.join(" | ")));
    }
    out.push('\n');
    out
}

fn append_markdown(
    path: &std::path::Path,
    title: &str,
    headers: &[&str],
    rows: &[Vec<String>],
) -> Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)?;
    file.write_all(markdown(title, headers, rows).as_bytes())?;
    Ok(())
}

fn print_table(headers: &[&str], rows: &[Vec<String>]) {
    let mut widths: Vec<usize> = headers.iter().map(|h| h.len()).collect();
    for row in rows {
        for (index, cell) in row.iter().enumerate() {
            if let Some(width) = widths.get_mut(index) {
                *width = (*width).max(cell.chars().count());
            }
        }
    }
    let line = |cells: Vec<&str>| {
        let padded: Vec<String> = cells
            .iter()
            .zip(&widths)
            .map(|(cell, width)| format!("{cell:<width$}"))
            .collect();
        println!("| {} |", padded.join(" | "));
    };
    line(headers.to_vec());
    println!(
        "|{}|",
        widths
            .iter()
            .map(|w| "-".repeat(w + 2))
            .collect::<Vec<_>>()
            .join("|")
    );
    for row in rows {
        line(row.iter().map(String::as_str).collect());
    }
}
