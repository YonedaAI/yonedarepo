//! Bounded, non-authoritative observations of refused pushes since service start.
//! Accepted history remains in the repository log; this view never changes a verdict.
use crate::moves::{Command, Outcomes};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;

#[derive(Clone, Serialize)]
pub struct Refusal {
    pub branch: String,
    pub commit: Option<String>,
    pub actor: String,
    pub reason: String,
    pub at_ms: u64,
}

#[derive(Default)]
pub struct Activity(Mutex<VecDeque<Refusal>>);

impl Activity {
    pub fn record(&self, actor: &str, commands: &[Command], outcomes: &Outcomes, at_ms: u64) {
        let mut recent = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for command in commands {
            if let Some(Some(reason)) = outcomes.get(&command.refname) {
                let reason = reason
                    .split_once(": ")
                    .filter(|(prefix, _)| {
                        !prefix.is_empty()
                            && prefix.chars().all(|c| c.is_ascii_uppercase() || c == '_')
                    })
                    .map_or(reason.as_str(), |(_, rest)| rest);
                recent.push_front(Refusal {
                    branch: crate::moves::short(&command.refname).to_owned(),
                    commit: command.new.clone(),
                    actor: actor.to_owned(),
                    // Secret scanner diagnostics stay in the authenticated Git response.
                    reason: if reason.to_lowercase().contains("secret") {
                        "The push did not pass credential scanning.".into()
                    } else {
                        reason.chars().take(240).collect()
                    },
                    at_ms,
                });
                recent.truncate(40);
            }
        }
    }

    pub fn recent(&self) -> Vec<Refusal> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect()
    }
}
