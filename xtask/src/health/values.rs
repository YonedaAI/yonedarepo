//! The dated numbers `cargo xtask health` keeps in `.local/health/<date>.json`, and what moved
//! between two of them. Numbers only: nothing here may name an account or a repository.
use crate::process::Result;
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

pub(super) type Values = BTreeMap<String, f64>;

/// Today, UTC, as `YYYY-MM-DD`.
pub(super) fn today() -> Result<String> {
    let output = Command::new("date").args(["-u", "+%F"]).output()?;
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

pub(super) fn write(dir: &Path, date: &str, values: &Values) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let text = serde_json::to_string_pretty(values)?;
    std::fs::write(dir.join(format!("{date}.json")), format!("{text}\n"))?;
    Ok(())
}

/// The newest values dated before `date`.
pub(super) fn previous(dir: &Path, date: &str) -> Result<Option<(String, Values)>> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(None);
    };
    let names = entries.flatten().map(|e| e.file_name());
    let dates = names.filter_map(|name| {
        let name = name.to_string_lossy();
        let day = name.strip_suffix(".json")?;
        (day.len() == date.len() && day < date).then(|| day.to_owned())
    });
    let Some(newest) = dates.max() else {
        return Ok(None);
    };
    let text = std::fs::read_to_string(dir.join(format!("{newest}.json")))?;
    Ok(Some((newest, serde_json::from_str(&text)?)))
}

fn number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        format!("{value:.1}")
    }
}

/// One line per value that changed, appeared or went away.
pub(super) fn moved(before: &Values, now: &Values) -> Vec<String> {
    let mut lines = Vec::new();
    for (name, value) in now {
        match before.get(name) {
            None => lines.push(format!("{name}: new, {}", number(*value))),
            Some(old) if old != value => {
                let percent = (*old != 0.0).then(|| (value - old) / old * 100.0);
                let change = percent.map_or(String::new(), |p| format!(" ({p:+.1}%)"));
                lines.push(format!(
                    "{name}: {} -> {}{change}",
                    number(*old),
                    number(*value)
                ));
            }
            Some(_) => {}
        }
    }
    let gone = before.keys().filter(|name| !now.contains_key(*name));
    lines.extend(gone.map(|name| format!("{name}: not measured this time")));
    lines
}

/// The Markdown table of `docs/code-health.md`.
fn table(date: &str, values: &Values) -> String {
    let rows = values
        .iter()
        .map(|(name, value)| format!("| `{name}` | {} |\n", number(*value)));
    format!(
        "Measured {date}.\n\n| Value | Now |\n|---|---|\n{}",
        rows.collect::<String>()
    )
}

const START: &str = "<!-- values:start (cargo xtask health --doc) -->";
const END: &str = "<!-- values:end -->";

/// `doc` with the text between the markers replaced by the table.
pub(super) fn replace_table(doc: &str, date: &str, values: &Values) -> Result<String> {
    let start = doc
        .find(START)
        .ok_or("The doc has no values:start marker")?;
    let end = doc.find(END).ok_or("The doc has no values:end marker")?;
    if end < start {
        return Err("The doc's value markers are out of order".into());
    }
    let head = &doc[..start + START.len()];
    Ok(format!("{head}\n{}{}", table(date, values), &doc[end..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(rows: &[(&str, f64)]) -> Values {
        rows.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect()
    }

    #[test]
    fn reports_what_moved_and_nothing_else() {
        let before = values(&[("same", 1.0), ("wasm", 100.0), ("zero", 0.0), ("old", 3.0)]);
        let now = values(&[("same", 1.0), ("wasm", 110.0), ("zero", 2.0), ("new", 2.5)]);
        assert_eq!(
            moved(&before, &now),
            [
                "new: new, 2.5",
                "wasm: 100 -> 110 (+10.0%)",
                "zero: 0 -> 2",
                "old: not measured this time",
            ]
        );
    }

    #[test]
    fn the_previous_values_are_the_newest_of_an_earlier_day() {
        let dir = tempfile::tempdir().unwrap();
        for (date, value) in [
            ("2026-10-01", 1.0),
            ("2026-10-02", 2.0),
            ("2026-10-03", 3.0),
        ] {
            write(dir.path(), date, &values(&[("a", value)])).unwrap();
        }
        std::fs::write(dir.path().join("notes.json"), "{").unwrap();
        let (date, found) = previous(dir.path(), "2026-10-03").unwrap().unwrap();
        assert_eq!(date, "2026-10-02");
        assert_eq!(found, values(&[("a", 2.0)]));
        assert!(previous(dir.path(), "2026-10-01").unwrap().is_none());
    }

    #[test]
    fn the_doc_table_replaces_only_what_is_between_the_markers() {
        let doc = format!("before\n{START}\nold\n{END}\nafter\n");
        let new = replace_table(&doc, "2026-10-31", &values(&[("a", 5.0)])).unwrap();
        assert!(new.starts_with("before\n"));
        assert!(new.ends_with(&format!("{END}\nafter\n")));
        assert!(new.contains("| `a` | 5 |"));
        assert!(!new.contains("old"));
        assert!(replace_table("no markers", "d", &Values::new()).is_err());
    }
}
