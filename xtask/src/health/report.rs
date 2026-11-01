//! `cargo xtask health`: every measure, dated values in `.local/health/`, then what moved. A
//! measure that can't run says so and leaves its value out, so a gap never reads as a zero. A
//! breached gate still fails the command, after the values are written.
use super::values::{self, Values};
use super::{deps, evidence, lines, live, migrations, secrets, size, test_history};
use crate::process::Result;
use std::path::Path;

const DOC: &str = "docs/code-health.md";
const MEGABYTE: f64 = 1_000_000.0;
/// How many breaking updates are named; the count covers the rest.
const NAMED: usize = 8;

#[derive(Default)]
struct Report {
    values: Values,
    breaches: Vec<String>,
    flags: Vec<String>,
    unmeasured: Vec<String>,
}

impl Report {
    fn set(&mut self, name: &str, value: f64) {
        self.values.insert(name.to_owned(), value);
    }

    fn measure(&mut self, name: &str, step: impl FnOnce(&mut Self) -> Result<()>) {
        if let Err(error) = step(self) {
            self.unmeasured.push(format!("{name}: {error}"));
        }
    }

    fn lines(&mut self, root: &Path) -> Result<()> {
        let census = lines::census(root)?;
        self.breaches
            .extend(lines::breaches(&lines::listed(root)?, &census.over));
        let excess = census.over.values().map(|count| count - lines::LIMIT);
        self.set("lines_excess_over_300", excess.sum::<usize>() as f64);
        self.set("lines_files_over_300", census.over.len() as f64);
        let largest = census.over.values().max().copied().unwrap_or(0);
        self.set("lines_largest_file", largest as f64);
        self.set("lines_test_files_over_300", census.tests_over as f64);
        self.set(
            "lines_generated_files_over_300",
            census.generated_over as f64,
        );
        Ok(())
    }

    fn migrations(&mut self, root: &Path) -> Result<()> {
        self.breaches.extend(migrations::current_breaches(root)?);
        Ok(())
    }

    fn secrets(&mut self, root: &Path) -> Result<()> {
        let found = secrets::unpushed(root)?;
        self.set("secrets_unpushed_findings", found.len() as f64);
        self.breaches.extend(found);
        Ok(())
    }

    fn size(&mut self, root: &Path) -> Result<()> {
        let sizes = size::measure(root)?;
        self.breaches.extend(size::current_breaches(root, &sizes)?);
        self.set("size_wasm_bytes", sizes.wasm as f64);
        self.set("size_frontend_js_bytes", sizes.js as f64);
        self.set("size_frontend_css_bytes", sizes.css as f64);
        self.set("size_frontend_total_bytes", sizes.dist as f64);
        Ok(())
    }

    fn deps(&mut self, name: &str, lags: &[deps::Lag]) {
        let breaking: Vec<&deps::Lag> = lags.iter().filter(|lag| lag.is_breaking()).collect();
        self.set(&format!("deps_{name}_behind"), lags.len() as f64);
        self.set(&format!("deps_{name}_breaking"), breaking.len() as f64);
        for lag in breaking.iter().take(NAMED) {
            let deps::Lag {
                name: dep,
                current,
                latest,
            } = lag;
            self.flags
                .push(format!("behind ({name}): {dep} {current} -> {latest}"));
        }
    }

    fn tests(&mut self) -> Result<()> {
        let (flags, total, failed) = test_history::summary()?;
        if total == 0 {
            return Err("no results yet: `cargo xtask check` keeps them".into());
        }
        self.set("tests_flagged", flags.len() as f64);
        self.set("tests_in_newest_runs", total as f64);
        self.set("tests_failed_in_newest_runs", failed as f64);
        self.flags.extend(flags);
        Ok(())
    }

    fn live(&mut self, staging: &Path) -> Result<()> {
        let runs = live::runs(staging);
        let newest = runs.first().ok_or("no kit run in .local/staging")?;
        let count = |status: &str| newest.count(status) as f64;
        self.set("live_items_passed", count("pass"));
        self.set("live_items_failed", count("fail"));
        self.set("live_items_skipped", count("skip"));
        let flags = live::flags(&runs);
        self.set("live_items_flagged", flags.len() as f64);
        self.flags.extend(flags);
        Ok(())
    }

    fn evidence(&mut self, staging: &Path) -> Result<()> {
        let found = evidence::survey(staging)?;
        self.set("evidence_entries", found.entries as f64);
        self.set("evidence_mb", (found.bytes as f64 / MEGABYTE).round());
        let trimmable = (found.trimmable as f64 / MEGABYTE).round();
        self.set("evidence_trimmable_mb", trimmable);
        Ok(())
    }
}

fn print(title: &str, lines: &[String]) {
    if lines.is_empty() {
        return;
    }
    println!("{title}");
    for line in lines {
        println!("  {line}");
    }
}

pub(super) fn run(write_doc: bool) -> Result<()> {
    let root = std::env::current_dir()?;
    let local = super::local_dir()?;
    let staging = local.join("staging");
    let mut report = Report::default();
    report.measure("lines", |r| r.lines(&root));
    report.measure("migrations", |r| r.migrations(&root));
    report.measure("secrets", |r| r.secrets(&root));
    report.measure("size", |r| r.size(&root));
    report.measure("cargo deps", |r| {
        r.deps("cargo", &deps::cargo()?);
        Ok(())
    });
    report.measure("npm deps", |r| {
        r.deps("npm", &deps::pnpm()?);
        Ok(())
    });
    report.measure("tests", Report::tests);
    report.measure("live", |r| r.live(&staging));
    report.measure("evidence", |r| r.evidence(&staging));

    let date = values::today()?;
    let dir = local.join("health");
    let before = values::previous(&dir, &date)?;
    values::write(&dir, &date, &report.values)?;
    if write_doc {
        let doc = std::fs::read_to_string(root.join(DOC))?;
        let doc = values::replace_table(&doc, &date, &report.values)?;
        std::fs::write(root.join(DOC), doc)?;
    }
    match &before {
        Some((day, old)) => {
            let moved = values::moved(old, &report.values);
            println!("health {date}: {} moved since {day}", moved.len());
            print("Moved:", &moved);
        }
        None => println!("health {date}: first record, nothing to compare with"),
    }
    print("Flagged:", &report.flags);
    print("Not measured:", &report.unmeasured);
    print("FAILED:", &report.breaches);
    println!("{} values in {}", report.values.len(), dir.display());
    if report.breaches.is_empty() {
        return Ok(());
    }
    Err(format!("{} health gate breach(es)", report.breaches.len()).into())
}
