//! Policy runners: how the platform itself produces a check result. A `command` runner
//! executes argv in a CheckContainer; a `model` runner makes one structured model call on
//! the commit's diff (`platform_model_check`). Both record through the same fenced run.
use crate::platform_model_check::{DEFAULT_MODEL, model_spec};
use crate::storage::bad;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};
use yoneda_core::Result;

/// A model check's lease: two bounded model calls (one retry) plus the diff read.
pub const MODEL_TIMEOUT_SECONDS: u32 = 120;
const MAX_RUBRIC_CHARS: usize = 8_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Runner {
    Command(CommandRunner),
    Model(ModelRunner),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CommandRunner {
    /// argv, executed without a shell unless the owner writes `["sh", "-c", ...]`.
    pub command: Vec<String>,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u32,
}
fn default_timeout() -> u32 {
    600
}

/// `{kind: "model", rubric, model?, allow_truncated?}`. The rubric is the owner's review
/// instruction; the model must be in the platform's review catalog (it pays for the call).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelRunner {
    pub rubric: String,
    #[serde(default = "default_model")]
    pub model: String,
    /// Review the first part of a diff over the budget instead of failing it. Omitted when
    /// false, the fail-closed default.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub allow_truncated: bool,
}
fn default_model() -> String {
    DEFAULT_MODEL.to_owned()
}

// Command runners serialize without `kind`, so policies written before model runners keep
// their digest (and their recorded results keep counting).
impl Serialize for Runner {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Tagged<'a> {
            kind: &'static str,
            #[serde(flatten)]
            runner: &'a ModelRunner,
        }
        match self {
            Runner::Command(c) => c.serialize(s),
            Runner::Model(m) => Tagged {
                kind: "model",
                runner: m,
            }
            .serialize(s),
        }
    }
}

impl<'de> Deserialize<'de> for Runner {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let mut value = Value::deserialize(d)?;
        let kind = match value.as_object_mut() {
            Some(map) => map.remove("kind"),
            None => return Err(D::Error::custom("a runner is an object")),
        };
        match kind.as_ref().map(|k| k.as_str()) {
            None | Some(Some("command")) => CommandRunner::deserialize(value)
                .map(Runner::Command)
                .map_err(D::Error::custom),
            Some(Some("model")) => ModelRunner::deserialize(value)
                .map(Runner::Model)
                .map_err(D::Error::custom),
            Some(_) => Err(D::Error::custom("runner kind must be command or model")),
        }
    }
}

impl Runner {
    pub fn validate(&self, name: &str) -> Result<()> {
        match self {
            Runner::Command(r) => {
                if r.command.is_empty()
                    || r.command.len() > 64
                    || r.command.iter().any(|a| a.len() > 4096 || a.contains('\0'))
                    || !(1..=3600).contains(&r.timeout_seconds)
                {
                    return Err(bad(
                        "Runners need 1-64 argv entries and a 1-3600 second timeout (at most 32 runners)",
                    ));
                }
            }
            Runner::Model(r) => {
                let chars = r.rubric.trim().chars().count();
                if chars == 0 || chars > MAX_RUBRIC_CHARS || r.rubric.contains('\0') {
                    return Err(bad(&format!(
                        "Model runner {name} needs a rubric of 1-{MAX_RUBRIC_CHARS} characters"
                    )));
                }
                model_spec(&r.model)?;
            }
        }
        Ok(())
    }

    /// How long one executor attempt may hold the run before another may take over.
    pub fn timeout_seconds(&self) -> u32 {
        match self {
            Runner::Command(r) => r.timeout_seconds,
            Runner::Model(_) => MODEL_TIMEOUT_SECONDS,
        }
    }

    /// What the executor needs, merged into a claimed run. `message` is the commit's
    /// message: a model check reads it as the change's stated intent.
    pub fn claim_fields(&self, message: &str) -> Value {
        match self {
            Runner::Command(r) => json!({
                "kind": "command", "command": r.command, "timeout_seconds": r.timeout_seconds,
            }),
            Runner::Model(r) => json!({
                "kind": "model", "rubric": r.rubric, "model": r.model,
                "allow_truncated": r.allow_truncated, "timeout_seconds": MODEL_TIMEOUT_SECONDS,
                "message": message,
            }),
        }
    }
}
