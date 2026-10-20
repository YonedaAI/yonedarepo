//! Environment names: dev, prod and throwaway ephemeral-<id> stacks.
use super::spec::SPEC_DIR;
use crate::process::Result;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Env {
    Dev,
    Prod,
    /// A throwaway full stack on workers.dev hostnames with its own resources.
    Ephemeral(String),
}

impl Env {
    pub(crate) fn parse(value: &str) -> Result<Self> {
        match value {
            "dev" => Ok(Self::Dev),
            "prod" => Ok(Self::Prod),
            other => match other.strip_prefix("ephemeral-") {
                Some(id)
                    if !id.is_empty()
                        && id.len() <= 12
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) =>
                {
                    Ok(Self::Ephemeral(id.into()))
                }
                _ => Err(format!(
                    "Unknown environment {other:?}: use dev, prod or ephemeral-<id> (id: 1-12 lowercase letters or digits)"
                )
                .into()),
            },
        }
    }
    pub(crate) fn from_args(args: &[String]) -> Result<Self> {
        let value = args
            .windows(2)
            .find(|v| v[0] == "--env")
            .map(|v| v[1].as_str())
            .ok_or("Missing --env dev|prod|ephemeral-<id>")?;
        Self::parse(value)
    }
    pub(crate) fn name(&self) -> String {
        match self {
            Self::Dev => "dev".into(),
            Self::Prod => "prod".into(),
            Self::Ephemeral(id) => format!("ephemeral-{id}"),
        }
    }
    pub(crate) fn is_prod(&self) -> bool {
        *self == Self::Prod
    }
    /// Local state of an ephemeral env (lock, generated secrets); ignored by Git.
    pub(crate) fn state_dir(&self) -> PathBuf {
        PathBuf::from(".local/infra").join(self.name())
    }
    pub(crate) fn lock_path(&self) -> PathBuf {
        match self {
            Self::Ephemeral(_) => self.state_dir().join("lock.json"),
            _ => PathBuf::from(SPEC_DIR).join(format!("{}.lock.json", self.name())),
        }
    }
}
