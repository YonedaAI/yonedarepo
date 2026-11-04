//! Wall-time reporting for deployment execution.
use crate::infra::wrangler::table;
use std::time::Instant;

/// Wall time per step, printed as a table (and to the Actions job summary).
#[derive(Debug, Default)]
pub(crate) struct Timings {
    rows: Vec<(String, f64, bool)>,
}

impl Timings {
    pub(crate) fn record(&mut self, step: &str, started: Instant, ok: bool) {
        self.rows
            .push((step.into(), started.elapsed().as_secs_f64(), ok));
    }

    pub(crate) fn print(&self) {
        let mut rows: Vec<Vec<String>> = self
            .rows
            .iter()
            .map(|(step, secs, ok)| {
                let result = if *ok { "ok" } else { "FAILED" };
                vec![step.clone(), format!("{secs:.1}"), result.into()]
            })
            .collect();
        let total: f64 = self.rows.iter().map(|(_, secs, _)| secs).sum();
        rows.push(vec!["total".into(), format!("{total:.1}"), String::new()]);
        table("deploy timings", &["Step", "Seconds", "Result"], &rows);
    }
}
