//! A coding session's transcript as the platform keeps it: the context packet the agent was
//! given at session start, then its turns in order (the person's prompts, the agent's
//! replies, and each tool call with its input and output). Clients build one from their
//! CLI's own record and fit it to [`UPLOAD`]; the platform redacts credentials and fits it
//! again to [`STORED`].
//!
//! Fitting is the stated truncation rule, the same on both sides:
//! - a text longer than `head + tail` bytes keeps its first `head` and last `tail` bytes
//!   around a `[… N bytes cut …]` marker (the context packet: three quarters and one
//!   quarter of `context`); a tool name keeps 128 bytes and a subject 300;
//! - when the turns are still over `total` bytes or `turns` in number, the first turn (the
//!   opening prompt) stays, the most recent turns that fit stay, and the turns between are
//!   replaced by one `omitted` turn counting them.
//!
//! Every [`UPLOAD`] bound is wider than its [`STORED`] one, so where a client cut a text,
//! the platform's own cut removes the text around it: a credential split by the client's
//! cut (too short to be recognised and redacted) never reaches storage.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The stored document's `format`.
pub const FORMAT: &str = "yoneda-transcript/1";

/// Bounds a transcript is fitted to (see the module documentation).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub head: usize,
    pub tail: usize,
    pub context: usize,
    pub total: usize,
    pub turns: usize,
}

/// What the platform stores: at most 1 MiB, 2,000 turns, 16 KiB per text, 32 KiB of context.
pub const STORED: Limits = Limits {
    head: 12 * 1024,
    tail: 4 * 1024,
    context: 32 * 1024,
    total: 1024 * 1024,
    turns: 2_000,
};

/// What a client uploads (the platform takes request bodies up to 4 MiB).
pub const UPLOAD: Limits = Limits {
    head: 48 * 1024,
    tail: 16 * 1024,
    context: 64 * 1024,
    total: 3 * 1024 * 1024,
    turns: 8_000,
};

// Every upload bound is wider than its stored one (see the module documentation).
const _: () = assert!(
    UPLOAD.head > STORED.head
        && UPLOAD.tail > STORED.tail
        && UPLOAD.context > STORED.context
        && UPLOAD.total > STORED.total
        && UPLOAD.turns > STORED.turns
);

const NAME_BYTES: usize = 128;
const SUBJECT_BYTES: usize = 300;
/// Room for the document's other fields around its turns.
const OVERHEAD: usize = 1024;
/// A text within `head + tail` and this many bytes is kept whole, so a text already cut
/// (its head, the marker and its tail) is not cut again by the same bounds.
const MARKER_ROOM: usize = 48;

/// One step of a session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Turn {
    /// What the person asked.
    Prompt { text: String },
    /// What the agent answered.
    Reply { text: String },
    /// A tool call: the tool, what it acted on (a file, a command), its input as text, its
    /// output, and whether it failed.
    Tool {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subject: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        error: bool,
    },
    /// Turns left out to fit the size bounds.
    Omitted { turns: u64 },
}

/// A session's context packet and turns.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transcript {
    #[serde(default)]
    pub context: Option<String>,
    pub turns: Vec<Turn>,
}

impl Transcript {
    /// A transcript from untrusted JSON: `{context?, turns: [{kind, …}]}`.
    pub fn parse(value: &Value) -> Result<Self> {
        Self::deserialize(value).map_err(|e| {
            Error::new(
                "INVALID_INPUT",
                format!("transcript must be {{context?, turns: [{{kind: prompt|reply|tool|omitted, …}}]}}: {e}"),
            )
        })
    }

    /// Every text the transcript holds, for redaction.
    pub fn texts_mut(&mut self) -> Vec<&mut String> {
        let mut texts: Vec<&mut String> = self.context.iter_mut().collect();
        for turn in &mut self.turns {
            match turn {
                Turn::Prompt { text } | Turn::Reply { text } => texts.push(text),
                Turn::Tool {
                    name,
                    subject,
                    input,
                    output,
                    ..
                } => {
                    texts.push(name);
                    texts.extend(subject.iter_mut());
                    texts.extend(input.iter_mut());
                    texts.extend(output.iter_mut());
                }
                Turn::Omitted { .. } => {}
            }
        }
        texts
    }

    /// The turns that are steps of the session (not `omitted` markers).
    pub fn steps(&self) -> usize {
        self.turns
            .iter()
            .filter(|t| !matches!(t, Turn::Omitted { .. }))
            .count()
    }

    /// Fits the transcript to `limits`; whether anything was cut or left out.
    pub fn fit(&mut self, limits: &Limits) -> bool {
        let mut cut_any = false;
        let mut fit_text = |text: &mut String, head: usize, tail: usize| {
            if let Some(shorter) = cut(text, head, tail) {
                *text = shorter;
                cut_any = true;
            }
        };
        if let Some(context) = &mut self.context {
            fit_text(context, limits.context / 4 * 3, limits.context / 4);
        }
        for turn in &mut self.turns {
            match turn {
                Turn::Prompt { text } | Turn::Reply { text } => {
                    fit_text(text, limits.head, limits.tail)
                }
                Turn::Tool {
                    name,
                    subject,
                    input,
                    output,
                    ..
                } => {
                    fit_text(name, NAME_BYTES, 0);
                    for text in subject.iter_mut() {
                        fit_text(text, SUBJECT_BYTES, 0);
                    }
                    for text in input.iter_mut().chain(output.iter_mut()) {
                        fit_text(text, limits.head, limits.tail);
                    }
                }
                Turn::Omitted { .. } => {}
            }
        }
        self.drop_middle(limits) || cut_any
    }

    /// Keeps the first turn and the most recent ones within `limits`; the turns between
    /// become one `omitted` turn. Whether any were dropped.
    fn drop_middle(&mut self, limits: &Limits) -> bool {
        let size = |t: &Turn| serde_json::to_string(t).map_or(0, |s| s.len()) + 1;
        let context = self.context.as_ref().map_or(0, |c| c.len() * 2 + 2);
        let sizes: Vec<usize> = self.turns.iter().map(size).collect();
        let budget = limits.total.saturating_sub(context + OVERHEAD);
        if self.turns.len() <= limits.turns && sizes.iter().sum::<usize>() <= budget {
            return false;
        }
        let marker = size(&Turn::Omitted { turns: u64::MAX });
        let mut room = budget.saturating_sub(sizes.first().copied().unwrap_or(0) + marker);
        let mut keep_from = self.turns.len();
        while keep_from > 1
            && sizes[keep_from - 1] <= room
            && self.turns.len() - keep_from + 2 < limits.turns
        {
            room -= sizes[keep_from - 1];
            keep_from -= 1;
        }
        let first_kept = 1.min(self.turns.len());
        let dropped: u64 = self.turns[first_kept..keep_from]
            .iter()
            .map(|t| match t {
                Turn::Omitted { turns } => *turns,
                _ => 1,
            })
            .sum();
        let tail = self.turns.split_off(keep_from);
        self.turns.truncate(first_kept);
        self.turns.push(Turn::Omitted { turns: dropped });
        self.turns.extend(tail);
        true
    }
}

/// `text` with its first `head` and last `tail` bytes (on character boundaries) around a
/// marker naming how much was cut; `None` when it is short enough to keep whole.
pub fn cut(text: &str, head: usize, tail: usize) -> Option<String> {
    if text.len() <= head + tail + MARKER_ROOM {
        return None;
    }
    let mut start = head;
    while !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = text.len() - tail;
    while !text.is_char_boundary(end) {
        end += 1;
    }
    Some(format!(
        "{}\n[… {} bytes cut …]\n{}",
        &text[..start],
        end - start,
        &text[end..]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(output: &str) -> Turn {
        Turn::Tool {
            name: "Bash".into(),
            subject: Some("cargo test".into()),
            input: Some("command: cargo test".into()),
            output: Some(output.into()),
            error: false,
        }
    }

    #[test]
    fn parses_turns_and_refuses_unknown_shapes() {
        let parsed = Transcript::parse(&json!({"context": "ctx", "turns": [
            {"kind": "prompt", "text": "Fix it"},
            {"kind": "tool", "name": "Read", "subject": "src/a.rs", "output": "fn a() {}"},
            {"kind": "tool", "name": "Bash", "error": true},
            {"kind": "reply", "text": "Fixed."},
            {"kind": "omitted", "turns": 3}
        ]}))
        .unwrap();
        assert_eq!(parsed.context.as_deref(), Some("ctx"));
        assert_eq!(parsed.turns.len(), 5);
        assert_eq!(parsed.steps(), 4);
        let round = serde_json::to_value(&parsed).unwrap();
        assert_eq!(
            round["turns"][1],
            json!({"kind": "tool", "name": "Read", "subject": "src/a.rs", "output": "fn a() {}"})
        );
        assert_eq!(round["turns"][2]["error"], true);
        for bad in [
            json!({"turns": [{"kind": "thought", "text": "x"}]}),
            json!({"turns": [{"kind": "prompt", "text": "x", "extra": 1}]}),
            json!({"turns": [{"kind": "prompt", "text": 7}]}),
            json!({"turns": "x"}),
            json!({"context": "no turns"}),
            json!("text"),
        ] {
            assert_eq!(
                Transcript::parse(&bad).unwrap_err().code,
                "INVALID_INPUT",
                "{bad}"
            );
        }
    }

    #[test]
    fn cuts_long_texts_around_a_marker_on_character_boundaries() {
        assert_eq!(cut("short", 3, 2), None);
        let long = format!("abc{}yz", "-".repeat(95));
        assert_eq!(cut(&long, 3, 2).unwrap(), "abc\n[… 95 bytes cut …]\nyz");
        // A cut text is not cut again by the same bounds.
        assert_eq!(cut(&cut(&long, 3, 2).unwrap(), 3, 2), None);
        // 'é' is two bytes: the kept head and tail never split it.
        let kept = cut(&"é".repeat(40), 3, 3).unwrap();
        assert!(kept.starts_with("é\n") && kept.ends_with("\né"), "{kept}");
        assert_eq!(
            cut(&"a".repeat(60), 2, 0).unwrap(),
            "aa\n[… 58 bytes cut …]\n"
        );
    }

    #[test]
    fn fits_texts_then_keeps_the_opening_prompt_and_the_latest_turns() {
        let limits = Limits {
            head: 8,
            tail: 4,
            context: 16,
            total: OVERHEAD + 600,
            turns: 100,
        };
        let mut t = Transcript {
            context: Some("c".repeat(100)),
            turns: vec![Turn::Prompt {
                text: "Start".into(),
            }],
        };
        assert!(
            !Transcript {
                context: None,
                turns: vec![Turn::Prompt { text: "ok".into() }]
            }
            .fit(&limits)
        );
        for n in 0..30 {
            t.turns
                .push(tool(&format!("output {n} {}", "x".repeat(80))));
        }
        t.turns.push(Turn::Reply {
            text: "Done.".into(),
        });
        assert!(t.fit(&limits));
        let context = t.context.as_deref().unwrap();
        assert_eq!(context, "cccccccccccc\n[… 84 bytes cut …]\ncccc");
        assert_eq!(
            t.turns[0],
            Turn::Prompt {
                text: "Start".into()
            }
        );
        let Turn::Omitted { turns: dropped } = t.turns[1] else {
            panic!("{:?}", t.turns[1]);
        };
        assert_eq!(
            t.turns.last(),
            Some(&Turn::Reply {
                text: "Done.".into()
            })
        );
        assert_eq!(
            dropped as usize + t.turns.len() - 2,
            31,
            "every turn kept or counted"
        );
        let Turn::Tool { output, .. } = &t.turns[t.turns.len() - 2] else {
            panic!("a tool turn");
        };
        assert_eq!(
            output.as_deref(),
            Some("output 2\n[… 78 bytes cut …]\nxxxx")
        );
        let size: usize = serde_json::to_string(&t).unwrap().len();
        assert!(size <= limits.total, "{size}");
        // Fitting again changes nothing, and an earlier omitted marker is counted on.
        let before = t.clone();
        assert!(!t.fit(&limits));
        assert_eq!(t, before);
        let mut fewer = Limits { turns: 4, ..limits };
        assert!(t.fit(&fewer));
        assert_eq!(t.turns.len(), 4);
        assert_eq!(t.turns[1], Turn::Omitted { turns: 29 });
        fewer.turns = 1;
        assert!(t.fit(&fewer));
        assert_eq!(
            t.turns,
            [
                Turn::Prompt {
                    text: "Start".into()
                },
                Turn::Omitted { turns: 31 }
            ]
        );
    }

    #[test]
    fn a_credential_split_by_the_upload_cut_is_not_stored() {
        // A credential the client's cut splits (its head keeps "SEC") is not stored.
        let original = format!(
            "{}SECRET{}",
            "h".repeat(UPLOAD.head - 3),
            "t".repeat(70_000)
        );
        let uploaded = cut(&original, UPLOAD.head, UPLOAD.tail).unwrap();
        assert!(uploaded.contains("hSEC\n"));
        let stored = cut(&uploaded, STORED.head, STORED.tail).unwrap();
        assert!(original.starts_with(stored.split('\n').next().unwrap()));
        assert!(original.ends_with(stored.rsplit('\n').next().unwrap()));
        assert!(!stored.contains("SEC"));
    }
}
