//! The account's container registry and Docker: what the container apps run now, the record
//! tags (deploy_image), the local amd64 build, and the push. Registry credentials are
//! short-lived (`wrangler containers registries credentials`), captured from wrangler's
//! stdout and used only in request headers; nothing here prints them.
use crate::deploy_image::{self, ImageFacts, RegistryImage};
use crate::deploy_prebuilt::REGISTRY;
use crate::infra::inventory::{self, Deployable};
use crate::infra::spec::Spec;
use crate::infra::wrangler;
use crate::process::{Result, run};
use serde_json::Value;
use std::collections::BTreeMap;
use std::process::Command;
use std::time::Duration;

const MANIFEST_TYPES: &str = "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json";

/// Each container application the Workers declare -> the image it runs now.
pub(crate) fn deployed_images(
    spec: &Spec,
    workers: &[Deployable],
) -> Result<BTreeMap<String, Option<String>>> {
    let listing: Value = serde_json::from_slice(&wrangler::output(
        &spec.account_id,
        &["containers", "list", "--json", "--per-page", "100"],
    )?)?;
    let live: BTreeMap<&str, &str> = listing
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| Some((a["name"].as_str()?, a["image"].as_str()?)))
        .collect();
    Ok(workers
        .iter()
        .flat_map(|w| inventory::containers(&w.config).into_keys())
        .map(|app| {
            let image = live.get(app.as_str()).map(|i| (*i).to_owned());
            (app, image)
        })
        .collect())
}

/// Every tag of one registry repository. wrangler's `--filter` regex is not matched against
/// the bare name (an anchored `^name$` lists nothing), so it only narrows the listing and the
/// exact name is compared here.
pub(crate) fn tags(spec: &Spec, repo: &str) -> Result<Vec<String>> {
    let listing: Value = serde_json::from_slice(&wrangler::output(
        &spec.account_id,
        &["containers", "images", "list", "--json", "--filter", repo],
    )?)?;
    Ok(listing
        .as_array()
        .into_iter()
        .flatten()
        .filter(|image| image["name"] == repo)
        .flat_map(|image| image["tags"].as_array().cloned().unwrap_or_default())
        .filter_map(|tag| tag.as_str().map(str::to_owned))
        .collect())
}

/// Gathers [`ImageFacts`]: HEAD's inputs, the deployed images and their records.
pub(crate) fn facts(spec: &Spec, workers: &[Deployable], inputs: String) -> Result<ImageFacts> {
    let deployed = deployed_images(spec, workers)?;
    let mut records = BTreeMap::new();
    let mut listed: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for image in deployed.values().flatten() {
        let Some(RegistryImage { repo, tag }) = deploy_image::parse_image(image, &spec.account_id)
        else {
            records.insert(image.clone(), Default::default());
            continue;
        };
        if !listed.contains_key(&repo) {
            listed.insert(repo.clone(), tags(spec, &repo)?);
        }
        let repo_tags = listed.get(&repo).map(Vec::as_slice).unwrap_or_default();
        records.insert(
            image.clone(),
            deploy_image::recorded_inputs(repo_tags, &tag),
        );
    }
    Ok(ImageFacts {
        inputs,
        deployed,
        records,
    })
}

/// Short-lived registry credentials. `Debug` hides the password.
struct Registry {
    account: String,
    username: String,
    password: String,
    client: reqwest::Client,
}

impl std::fmt::Debug for Registry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Registry({}, <redacted>)", self.account)
    }
}

impl Registry {
    fn login(spec: &Spec) -> Result<Self> {
        let out = wrangler::output(
            &spec.account_id,
            &[
                "containers",
                "registries",
                "credentials",
                REGISTRY,
                "--push",
                "--pull",
                "--json",
            ],
        )?;
        let value: Value = serde_json::from_slice(&out)
            .map_err(|_| "Unexpected registry credentials output (not JSON)")?;
        let field = |name: &str| {
            value[name]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("Registry credentials lack {name}"))
        };
        Ok(Self {
            account: spec.account_id.clone(),
            username: field("username")?,
            password: field("password")?,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()?,
        })
    }

    fn manifest_url(&self, repo: &str, reference: &str) -> String {
        format!(
            "https://{REGISTRY}/v2/{}/{repo}/manifests/{reference}",
            self.account
        )
    }

    /// Adds tag `to` to the manifest tagged `from` (no layer moves; the manifest is copied).
    async fn retag(&self, repo: &str, from: &str, to: &str) -> Result<()> {
        let got = self
            .client
            .get(self.manifest_url(repo, from))
            .basic_auth(&self.username, Some(&self.password))
            .header("Accept", MANIFEST_TYPES)
            .send()
            .await?;
        if !got.status().is_success() {
            return Err(format!("Registry GET {repo}:{from} returned {}", got.status()).into());
        }
        let media = got
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .ok_or("Registry manifest without a content type")?
            .to_owned();
        let body = got.bytes().await?;
        let put = self
            .client
            .put(self.manifest_url(repo, to))
            .basic_auth(&self.username, Some(&self.password))
            .header("Content-Type", media)
            .body(body)
            .send()
            .await?;
        if !put.status().is_success() {
            return Err(format!("Registry PUT {repo}:{to} returned {}", put.status()).into());
        }
        Ok(())
    }
}

/// Records that `image` (a registry reference of this account) was built from `inputs`.
pub(crate) async fn record(spec: &Spec, image: &str, inputs: &str) -> Result<String> {
    let RegistryImage { repo, tag } = deploy_image::parse_image(image, &spec.account_id)
        .ok_or_else(|| format!("{image} is not a tagged image in this account's registry"))?;
    let record = deploy_image::record_tag(&tag, inputs);
    Registry::login(spec)?.retag(&repo, &tag, &record).await?;
    Ok(format!("{repo}:{record}"))
}

/// `cargo xtask runtime-image record --env <env> --built-from <commit>`: records the inputs
/// of `<commit>` for the image every container app of the env runs now. For an image pushed
/// before pushes recorded their inputs; take the commit from the CI run that pushed it.
pub(crate) async fn record_command(args: &[String]) -> Result<()> {
    use crate::infra::spec::{Env, Lock};
    let env = Env::from_args(args)?;
    let commit = args
        .windows(2)
        .find(|v| v[0] == "--built-from")
        .map(|v| v[1].as_str())
        .ok_or("Usage: cargo xtask runtime-image record --env <env> --built-from <commit>")?;
    let spec = Spec::load(&env)?;
    let workers = inventory::deployables(&spec, &Lock::load(&env)?)?;
    crate::deploy_credentials::load(&env.name(), &spec.account_id)?;
    let inputs = crate::deploy_inputs::inputs_hash(commit)?;
    let deployed = deployed_images(&spec, &workers)?;
    let images: std::collections::BTreeSet<&Option<String>> = deployed.values().collect();
    let image = match images.into_iter().collect::<Vec<_>>().as_slice() {
        [Some(image)] => image.clone(),
        _ => {
            return Err(format!(
                "Refusing: the container apps do not run one common image ({deployed:?})."
            )
            .into());
        }
    };
    let record = record(&spec, &image, &inputs).await?;
    println!("Recorded {image} as built from {commit} (inputs {inputs}): {record}");
    Ok(())
}

/// Builds the runtime image for linux/amd64 (the container platform) with the local
/// builder's layer cache and returns its image id. Slow on arm64: Rust compiles emulated.
pub(crate) fn build_local(spec: &Spec) -> Result<String> {
    let scratch = format!("{}-runtime:local-build", spec.prefix);
    run(
        "docker",
        &[
            "buildx",
            "build",
            "--platform",
            "linux/amd64",
            // The same flags CI and wrangler build with.
            "--provenance=false",
            "--load",
            "--file",
            "cloudflare/containers/Dockerfile",
            "--tag",
            &scratch,
            ".",
        ],
    )?;
    let inspect = Command::new("docker")
        .args(["image", "inspect", "--format", "{{.Id}}", &scratch])
        .output()?;
    if !inspect.status.success() {
        return Err(format!("docker image inspect {scratch} failed").into());
    }
    let id = String::from_utf8(inspect.stdout)?.trim().to_owned();
    let tag = crate::deploy_prebuilt::runtime_tag(&spec.prefix, &id)?;
    run("docker", &["tag", &id, &tag])?;
    Ok(id)
}

/// Pushes a local `<prefix>-runtime:<tag>` (layers the registry has are skipped).
pub(crate) fn push(spec: &Spec, local_tag: &str) -> Result<()> {
    wrangler::run(&spec.account_id, &["containers", "push", local_tag])
}
