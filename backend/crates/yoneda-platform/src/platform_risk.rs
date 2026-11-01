//! Risk: one deterministic score for a head of a change, from four inputs the platform already
//! holds, with no model call and no cost. It adds points, so a reader can check the sum, and
//! what cannot be read never lowers it: a commit with no class, or one the walk could not
//! reach, scores above any class, and a file with no line counts adds points of its own.
//! A person's landing never reads it; CTC won't land a High (`platform_ctc`), as a conservative
//! rule the owner can see. The weights are uncalibrated; see
//! `docs/landings-plan.md`.
use crate::platform_instruments::{
    CommitFacts, FileFacts, RiskInput, RiskLevel, RiskReading, RiskReason,
};
mod sensitive;
use sensitive::{Sensitive, kind};
#[cfg(test)]
mod tests;

/// The score at which a level starts.
const MEDIUM: u32 = 25;
const HIGH: u32 = 55;

/// A class no commit could be held to: not recorded, or not reachable.
const NO_CLASS: u32 = 30;
const FINDING: u32 = 5;
const FINDINGS_CAP: u64 = 5;
/// Any file with no line counts: its size is not known, so it does not read as small.
const UNMEASURED: u32 = 10;
/// (at most this many, points): the first band that fits; past the last, `*_TOP`.
const FILE_BANDS: [(usize, u32); 4] = [(3, 0), (10, 5), (30, 10), (100, 15)];
const FILES_TOP: u32 = 20;
const LINE_BANDS: [(u64, u32); 4] = [(50, 0), (200, 5), (500, 10), (1000, 15)];
const LINES_TOP: u32 = 20;
/// Paths named in a reason per kind; the rest are counted.
const NAMED: usize = 1;

/// The score of a head: `commits` it brings, `files` its diff touches, `open_findings`.
pub fn score(commits: &CommitFacts, files: &[FileFacts], open_findings: u64) -> RiskReading {
    let reasons = vec![
        classes(commits),
        size(files),
        sensitive_paths(files),
        findings(open_findings),
    ];
    let score = reasons.iter().map(|r| r.points).sum::<u32>().min(100);
    RiskReading {
        score,
        level: level(score),
        reasons,
    }
}

fn level(score: u32) -> RiskLevel {
    match score {
        s if s >= HIGH => RiskLevel::High,
        s if s >= MEDIUM => RiskLevel::Medium,
        _ => RiskLevel::Low,
    }
}

fn plural(n: u64, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

fn reason(input: RiskInput, points: u32, why: String) -> RiskReason {
    RiskReason { input, points, why }
}

/// The worst class any commit holds; a commit with none counts above all of them.
fn classes(commits: &CommitFacts) -> RiskReason {
    let classified: u64 = commits.classes.values().sum();
    let total = classified + commits.unclassified;
    let (points, why) = if commits.unread {
        (
            NO_CLASS,
            "Some commits could not be read: a merge, or too many to walk".to_owned(),
        )
    } else if commits.unclassified > 0 {
        (
            NO_CLASS,
            format!(
                "{} of {total} commits {} no review class yet",
                commits.unclassified,
                if commits.unclassified == 1 {
                    "has"
                } else {
                    "have"
                },
            ),
        )
    } else {
        let worst = commits.classes.keys().map(|c| class(c)).max_by_key(|c| c.0);
        worst.map_or((0, "No commits to land".to_owned()), |(points, why)| {
            (points, why.to_owned())
        })
    };
    reason(RiskInput::Classes, points, why)
}

fn class(name: &str) -> (u32, &'static str) {
    match name {
        "docs" | "formatting" | "comment_only" => (0, "Docs, formatting or comments only"),
        "logic" => (15, "Code logic changed"),
        "instructions" => (25, "Agent instructions changed"),
        _ => (25, "A commit's change could not be classified"),
    }
}

/// Files and lines touched. Lockfile lines are generated, so they weigh as a sensitive path
/// and not as size.
fn size(files: &[FileFacts]) -> RiskReason {
    let counted = files
        .iter()
        .filter(|f| kind(&f.path) != Some(Sensitive::Lockfiles));
    let lines: u64 = counted
        .clone()
        .map(|f| {
            f.additions
                .unwrap_or(0)
                .saturating_add(f.deletions.unwrap_or(0))
        })
        .fold(0, u64::saturating_add);
    let unmeasured = counted.filter(|f| f.additions.is_none()).count() as u64;
    let file_points = band(files.len(), &FILE_BANDS, FILES_TOP);
    let line_points = band(lines, &LINE_BANDS, LINES_TOP);
    let extra = if unmeasured > 0 { UNMEASURED } else { 0 };
    let touched = plural(files.len() as u64, "file");
    let measured = plural(lines, "line");
    let why = if unmeasured > 0 {
        format!("{touched}, at least {measured}, {unmeasured} not measured")
    } else {
        format!("{touched}, {measured}")
    };
    reason(RiskInput::Size, file_points + line_points + extra, why)
}

fn band<T: PartialOrd + Copy>(value: T, bands: &[(T, u32)], top: u32) -> u32 {
    bands
        .iter()
        .find(|(limit, _)| value <= *limit)
        .map_or(top, |(_, points)| *points)
}

/// Each kind of sensitive path counts once, whichever side of a rename it is on.
fn sensitive_paths(files: &[FileFacts]) -> RiskReason {
    let mut seen: Vec<(Sensitive, Vec<&str>)> = Vec::new();
    for file in files {
        let sides = [Some(file.path.as_str()), file.old_path.as_deref()];
        for path in sides.into_iter().flatten() {
            let Some(found) = kind(path) else { continue };
            match seen.iter_mut().find(|(k, _)| *k == found) {
                Some((_, paths)) if !paths.contains(&path) => paths.push(path),
                Some(_) => {}
                None => seen.push((found, vec![path])),
            }
        }
    }
    seen.sort_by_key(|(k, _)| *k);
    let points = seen.iter().map(|(k, _)| k.points()).sum();
    let parts: Vec<String> = seen.iter().map(|(k, paths)| named(*k, paths)).collect();
    let why = if parts.is_empty() {
        "No sensitive paths".to_owned()
    } else {
        parts.join("; ")
    };
    reason(RiskInput::Sensitive, points, why)
}

fn named(kind: Sensitive, paths: &[&str]) -> String {
    let shown = paths[..paths.len().min(NAMED)].join(", ");
    match paths.len().saturating_sub(NAMED) {
        0 => format!("{}: {shown}", kind.label()),
        more => format!("{}: {shown} and {more} more", kind.label()),
    }
}

fn findings(open: u64) -> RiskReason {
    let points = open.min(FINDINGS_CAP) as u32 * FINDING;
    let why = match open {
        0 => "No open findings".to_owned(),
        n => plural(n, "open finding"),
    };
    reason(RiskInput::Findings, points, why)
}
