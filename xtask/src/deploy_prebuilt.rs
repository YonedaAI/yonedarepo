//! `deploy --env <env> --prebuilt <dir>`: deploys the outputs CI already built and tested
//! instead of rebuilding them. `<dir>` holds one directory per CI artifact, each with a
//! `REVISION` file naming the commit it was built from:
//!
//! - `worker-wasm/`: `worker-build --release` output, installed at `WORKER_CRATE/build`
//! - `frontend-dist/`: the frontend build, installed at `frontend/dist`
//! - `runtime-image/`: `image.tar.zst` (`docker save`) and `IMAGE_ID`, pushed to the
//!   Cloudflare registry as `<prefix>-runtime:<image id>`
//!
//! Every output must exist and carry HEAD's revision; anything missing or stale refuses the
//! deploy before the first remote change. Containers then deploy from the pushed registry
//! image (a copy of each Worker config with `image` swapped), so wrangler builds nothing.
//! The tag is the image id, so an unchanged image keeps its reference and rolls nothing out.
//! The push also records the image's runtime inputs (deploy_image), so a later workstation
//! deploy can reuse it.
use crate::infra::{inventory::Deployable, jsonc, spec::Spec};
use crate::process::{Result, run};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) const REVISION: &str = "REVISION";
pub(crate) const WASM: &str = "worker-wasm";
pub(crate) const FRONTEND: &str = "frontend-dist";
pub(crate) const IMAGE: &str = "runtime-image";
pub(crate) const IMAGE_ARCHIVE: &str = "image.tar.zst";
pub(crate) const IMAGE_ID: &str = "IMAGE_ID";
pub(crate) const REGISTRY: &str = "registry.cloudflare.com";
/// A file each output must contain, so an empty or wrong artifact is refused.
const WASM_ENTRY: &str = "worker/shim.mjs";
const FRONTEND_ENTRY: &str = "index.html";

/// `--prebuilt <dir>`: `None` without the flag; an error when the flag has no directory.
pub(crate) fn dir_arg(args: &[String]) -> Result<Option<PathBuf>> {
    let Some(at) = args.iter().position(|a| a == "--prebuilt") else {
        return Ok(None);
    };
    match args.get(at + 1) {
        Some(dir) if !dir.starts_with("--") => Ok(Some(PathBuf::from(dir))),
        _ => Err("--prebuilt needs the directory holding the CI build outputs".into()),
    }
}

/// Outputs verified against HEAD by [`check`]; nothing is installed or pushed yet.
#[derive(Clone, Debug)]
pub(crate) struct Prebuilt {
    dir: PathBuf,
    /// `sha256:<64 hex>`, as `docker image inspect` reports it.
    image_id: String,
}

/// Refuses unless every output exists and was built from `head`.
pub(crate) fn check(dir: &Path, head: &str) -> Result<Prebuilt> {
    for (output, entry) in [
        (WASM, WASM_ENTRY),
        (FRONTEND, FRONTEND_ENTRY),
        (IMAGE, IMAGE_ARCHIVE),
    ] {
        let root = dir.join(output);
        let revision = std::fs::read_to_string(root.join(REVISION)).map_err(|error| {
            format!(
                "Refusing: no prebuilt {output} revision at {} ({error}).",
                root.join(REVISION).display()
            )
        })?;
        if revision.trim() != head {
            return Err(format!(
                "Refusing: prebuilt {output} was built from {}, not HEAD {head}.",
                revision.trim()
            )
            .into());
        }
        if !root.join(entry).is_file() {
            return Err(format!("Refusing: prebuilt {output} lacks {entry}.").into());
        }
    }
    let image_id = std::fs::read_to_string(dir.join(IMAGE).join(IMAGE_ID))
        .map_err(|error| format!("Refusing: no prebuilt {IMAGE}/{IMAGE_ID} ({error})."))?
        .trim()
        .to_owned();
    if image_digest(&image_id).is_none() {
        return Err(format!("Refusing: {IMAGE}/{IMAGE_ID} is not a sha256 image id.").into());
    }
    Ok(Prebuilt {
        dir: dir.to_owned(),
        image_id,
    })
}

/// The 64 hex digits of a `sha256:` image id.
fn image_digest(id: &str) -> Option<&str> {
    id.strip_prefix("sha256:")
        .filter(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The local name an image is pushed under: `<prefix>-runtime:<first 16 hex of its id>`.
pub(crate) fn runtime_tag(prefix: &str, image_id: &str) -> Result<String> {
    let hex =
        image_digest(image_id).ok_or_else(|| format!("{image_id} is not a sha256 image id"))?;
    Ok(format!("{prefix}-runtime:{}", &hex[..16]))
}

/// Where `wrangler containers push <local tag>` puts an image.
pub(crate) fn registry_ref(spec: &Spec, local_tag: &str) -> String {
    format!("{REGISTRY}/{}/{local_tag}", spec.account_id)
}

impl Prebuilt {
    /// The local name pushed as-is ([`runtime_tag`]; `check` validated the id).
    pub(crate) fn local_tag(&self, spec: &Spec) -> String {
        runtime_tag(&spec.prefix, &self.image_id).unwrap_or_default()
    }

    /// Where `wrangler containers push` puts [`Self::local_tag`].
    pub(crate) fn image_ref(&self, spec: &Spec) -> String {
        registry_ref(spec, &self.local_tag(spec))
    }

    /// Refuses a frontend built for another API origin (or none): its Git, CLI and MCP lines
    /// would send people to a host that does not serve them. Vite inlines the origin as a
    /// string literal, so it must appear in one of the built scripts.
    pub(crate) fn check_api_origin(&self, origin: &str) -> Result<()> {
        let assets = self.dir.join(FRONTEND).join("assets");
        let built_for = std::fs::read_dir(&assets)
            .map_err(|error| format!("Refusing: no prebuilt {FRONTEND}/assets ({error})."))?
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|path| path.extension().is_some_and(|ext| ext == "js"))
            .any(|path| std::fs::read_to_string(path).is_ok_and(|js| js.contains(origin)));
        if built_for {
            Ok(())
        } else {
            Err(format!(
                "Refusing: prebuilt {FRONTEND} was not built with {}={origin}.",
                crate::infra::api_origin::FRONTEND_VAR
            )
            .into())
        }
    }

    /// Installs the Wasm and frontend where wrangler bundles them from, loads the image and
    /// confirms the archive holds the recorded image id. Local only.
    pub(crate) fn install(&self, spec: &Spec) -> Result<()> {
        replace_dir(
            &self.dir.join(WASM),
            &Path::new(crate::layout::WORKER_CRATE).join("build"),
        )?;
        replace_dir(
            &self.dir.join(FRONTEND),
            &Path::new(crate::layout::FRONTEND).join("dist"),
        )?;
        let archive = self.dir.join(IMAGE).join(IMAGE_ARCHIVE);
        run(
            "docker",
            &["load", "-i", archive.to_str().ok_or("Invalid image path")?],
        )?;
        let loaded = Command::new("docker")
            .args(["image", "inspect", "--format", "{{.Id}}", &self.image_id])
            .output()?;
        if !loaded.status.success()
            || String::from_utf8_lossy(&loaded.stdout).trim() != self.image_id
        {
            return Err(format!(
                "Refusing: {} does not contain image {}.",
                archive.display(),
                self.image_id
            )
            .into());
        }
        run("docker", &["tag", &self.image_id, &self.local_tag(spec)])
    }

    /// Pushes the loaded image to the account's registry (unchanged layers are skipped).
    pub(crate) fn push(&self, spec: &Spec) -> Result<()> {
        crate::infra::wrangler::run(
            &spec.account_id,
            &["containers", "push", &self.local_tag(spec)],
        )
    }
}

/// `src` copied over a fresh `dest`, without the `REVISION` marker.
fn replace_dir(src: &Path, dest: &Path) -> Result<()> {
    if dest.exists() {
        std::fs::remove_dir_all(dest)?;
    }
    copy_dir(src, dest, true)
}

fn copy_dir(src: &Path, dest: &Path, top: bool) -> Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let (from, to) = (entry.path(), dest.join(entry.file_name()));
        let kind = entry.file_type()?;
        if top && entry.file_name() == REVISION {
            continue;
        } else if kind.is_dir() {
            copy_dir(&from, &to, false)?;
        } else if kind.is_file() {
            std::fs::copy(&from, &to)?;
        } else {
            return Err(format!("Refusing: {} is not a regular file.", from.display()).into());
        }
    }
    Ok(())
}

/// `config` with every runtime container deploying `image` instead of building a Dockerfile.
/// A container with its own image (`inventory::own_image`) keeps its Dockerfile.
pub(crate) fn with_image(mut config: Value, image: &str) -> Value {
    if let Some(containers) = config.get_mut("containers").and_then(Value::as_array_mut) {
        for container in containers
            .iter_mut()
            .filter(|c| !crate::infra::inventory::own_image(c))
            .filter_map(Value::as_object_mut)
        {
            container.insert("image".into(), Value::String(image.into()));
            container.remove("image_build_context");
        }
    }
    config
}

/// The swapped copy sits next to the original (wrangler resolves `main`, assets and
/// migrations relative to the config) under a Git-ignored name.
pub(crate) fn config_copy_path(config_path: &str) -> String {
    match config_path.rsplit_once('/') {
        Some((dir, file)) => format!("{dir}/.prebuilt.{file}"),
        None => format!(".prebuilt.{config_path}"),
    }
}

/// The swapped copy of a container Worker's tracked config, removed when dropped.
pub(crate) struct ConfigCopy(String);

impl ConfigCopy {
    /// `None` without a registry image (wrangler builds the Dockerfile) or for a Worker
    /// without containers.
    pub(crate) fn write(image: Option<&str>, worker: &Deployable) -> Result<Option<Self>> {
        let Some(image) = image.filter(|_| worker.has_containers) else {
            return Ok(None);
        };
        let config = jsonc::read(Path::new(&worker.config_path))?;
        let copy = Self(config_copy_path(&worker.config_path));
        let swapped = with_image(config, image);
        std::fs::write(&copy.0, serde_json::to_string_pretty(&swapped)?)?;
        Ok(Some(copy))
    }

    pub(crate) fn path(&self) -> &str {
        &self.0
    }
}

impl Drop for ConfigCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A prebuilt step needs the outputs `check` verified.
pub(crate) fn prebuilt(prebuilt: Option<&Prebuilt>) -> Result<&Prebuilt> {
    prebuilt.ok_or_else(|| "Internal error: a prebuilt step without --prebuilt".into())
}

#[cfg(test)]
#[path = "deploy_prebuilt/tests.rs"]
mod tests;
