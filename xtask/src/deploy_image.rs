//! Which runtime image a deploy gives the container apps.
//!
//! The image is named by its content (`<prefix>-runtime:<image id>`, see deploy_prebuilt), so
//! an unchanged image keeps its reference and rolls nothing out. A workstation deploy of dev
//! reuses the deployed image when the runtime's inputs are unchanged: every push (CI's
//! `--prebuilt` and a local build) records the inputs hash as a second registry tag on the
//! same manifest, `<image tag>--inputs-<hash>`. The record is bound to the exact deployed tag,
//! so a rollback or a deploy from elsewhere can never pair an image with the wrong sources.
//!
//! The inputs hash comes from deploy_inputs.
use crate::deploy_guard::short;
use crate::infra::inventory::Deployable;
use crate::infra::spec::{Env, Spec};
use crate::process::Result;
use std::collections::{BTreeMap, BTreeSet};

/// Hex digits of the inputs hash kept in a record tag.
const RECORD_HEX: usize = 16;
const RECORD_MARK: &str = "--inputs-";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RegistryImage {
    pub repo: String,
    pub tag: String,
}

/// `None` for digest references (`repo@sha256:..`), other registries or other accounts.
pub(crate) fn parse_image(image: &str, account_id: &str) -> Option<RegistryImage> {
    let rest = image
        .strip_prefix(crate::deploy_prebuilt::REGISTRY)?
        .strip_prefix('/')?
        .strip_prefix(account_id)?
        .strip_prefix('/')?;
    let (repo, tag) = rest.split_once(':')?;
    let valid = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    };
    (valid(repo) && valid(tag) && !repo.contains('@')).then(|| RegistryImage {
        repo: repo.into(),
        tag: tag.into(),
    })
}

/// The record tag saying `tag` was built from `inputs`.
pub(crate) fn record_tag(tag: &str, inputs: &str) -> String {
    format!(
        "{tag}{RECORD_MARK}{}",
        inputs.get(..RECORD_HEX).unwrap_or(inputs)
    )
}

/// The inputs hashes (shortened) recorded for `tag` among a repository's tags.
pub(crate) fn recorded_inputs(tags: &[String], tag: &str) -> BTreeSet<String> {
    let prefix = format!("{tag}{RECORD_MARK}");
    tags.iter()
        .filter_map(|t| t.strip_prefix(&prefix).map(str::to_owned))
        .collect()
}

/// What the image decision is made from.
#[derive(Clone, Debug, Default)]
pub(crate) struct ImageFacts {
    /// The runtime inputs hash at HEAD.
    pub inputs: String,
    /// Each container application the env deploys -> its current image (`None`: not created).
    pub deployed: BTreeMap<String, Option<String>>,
    /// Each deployed image -> the inputs hashes recorded for it (empty: no record).
    pub records: BTreeMap<String, BTreeSet<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ImagePlan {
    /// Point the container apps at `image`; only `rollouts` change image (and restart).
    Reuse {
        image: String,
        rollouts: Vec<String>,
    },
    /// Build and push a new image; every app in `rollouts` restarts on it.
    Build {
        reason: String,
        rollouts: Vec<String>,
    },
}

impl ImagePlan {
    pub(crate) fn rollouts(&self) -> &[String] {
        match self {
            Self::Reuse { rollouts, .. } | Self::Build { rollouts, .. } => rollouts,
        }
    }
}

/// Reuse a deployed image recorded with HEAD's inputs; otherwise build.
pub(crate) fn decide(facts: &ImageFacts) -> ImagePlan {
    let short = facts.inputs.get(..RECORD_HEX).unwrap_or(&facts.inputs);
    let images: BTreeSet<&String> = facts.deployed.values().flatten().collect();
    let reusable = images.iter().find(|image| {
        facts
            .records
            .get(image.as_str())
            .is_some_and(|r| r.contains(short))
    });
    if let Some(image) = reusable {
        let rollouts = facts
            .deployed
            .iter()
            .filter(|(_, current)| current.as_ref() != Some(*image))
            .map(|(app, _)| app.clone())
            .collect();
        return ImagePlan::Reuse {
            image: (*image).clone(),
            rollouts,
        };
    }
    let recorded: Vec<String> = images
        .iter()
        .filter_map(|image| {
            let r = facts.records.get(image.as_str())?;
            (!r.is_empty())
                .then(|| format!("{image} from inputs {}", join(r.iter().map(String::as_str))))
        })
        .collect();
    let reason = if images.is_empty() {
        "no container app runs an image yet".to_owned()
    } else if recorded.is_empty() {
        format!(
            "no inputs record for the deployed image ({})",
            join(images.iter().map(|i| i.as_str()))
        )
    } else {
        format!(
            "runtime inputs changed: HEAD has {short}, deployed {}",
            recorded.join("; ")
        )
    };
    ImagePlan::Build {
        reason,
        rollouts: facts.deployed.keys().cloned().collect(),
    }
}

/// The workstation deploy's image: loads the dev token, hashes the runtime inputs at HEAD and
/// decides between reusing the deployed image and building one. Returns the plan, the image
/// to deploy now (a dry run of a build shows the deployed image as a stand-in) and the hash.
pub(crate) fn local_image(
    env: &Env,
    spec: &Spec,
    workers: &[Deployable],
    head: &str,
) -> Result<(ImagePlan, Option<String>, String)> {
    crate::deploy_credentials::load(&env.name(), &spec.account_id)?;
    let inputs = crate::deploy_inputs::inputs_hash(head)?;
    let facts = crate::deploy_registry::facts(spec, workers, inputs.clone())?;
    let plan = decide(&facts);
    let image = match &plan {
        ImagePlan::Reuse { image, rollouts } => {
            println!(
                "Runtime image: REUSE {image} (runtime inputs {} unchanged; no image build).",
                short(&inputs)
            );
            if !rollouts.is_empty() {
                println!(
                    "WARNING: {} will switch to it: a container rollout stops their running checks.",
                    rollouts.join(", ")
                );
            }
            Some(image.clone())
        }
        ImagePlan::Build { reason, rollouts } => {
            println!(
                "Runtime image: BUILD for linux/amd64 ({reason}). Slow on an arm64 Mac (emulated Rust build)."
            );
            println!(
                "WARNING: a container rollout will stop running checks on {}.",
                rollouts.join(", ")
            );
            facts.deployed.values().flatten().next().cloned()
        }
    };
    Ok((plan, image, inputs))
}

fn join<'a>(items: impl IntoIterator<Item = &'a str>) -> String {
    items.into_iter().collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
#[path = "deploy_image/tests.rs"]
mod tests;
