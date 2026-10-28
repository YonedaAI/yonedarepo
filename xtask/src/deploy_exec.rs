//! Executes a deploy plan (deploy_env::steps) step by step, timing each one.
use crate::deploy_env::Step;
use crate::deploy_guard::{self as guard, Options};
use crate::deploy_prebuilt::{Prebuilt, prebuilt};
use crate::infra::inventory::Deployable;
use crate::infra::retired::Kind;
use crate::infra::spec::{Env, Spec};
use crate::infra::wrangler::{self, table};
use crate::process::Result;
use std::collections::BTreeMap;
use std::time::Instant;

pub(crate) struct Run<'a> {
    pub env: &'a Env,
    pub spec: &'a Spec,
    pub workers: &'a [Deployable],
    pub options: &'a Options,
    pub head: &'a str,
    pub prebuilt: Option<&'a Prebuilt>,
    /// The registry image container Workers deploy (`None`: wrangler builds the Dockerfile).
    /// A local build sets it once the image is pushed.
    pub image: Option<String>,
    /// The runtime inputs hash at HEAD, when already computed.
    pub inputs: Option<String>,
    /// API token for host moves (`infra up` only); never printed.
    pub host_token: Option<&'a str>,
    pub timings: Timings,
}

impl Run<'_> {
    /// Executes the plan in order; the first failure stops it. `summary` keeps what ran.
    pub(crate) async fn execute(
        &mut self,
        plan: Vec<Step>,
        summary: &mut BTreeMap<usize, Vec<String>>,
    ) -> Result<()> {
        for step in plan {
            let label = self.label(&step);
            let started = Instant::now();
            let outcome = self.step(step, summary).await;
            self.timings.record(&label, started, outcome.is_ok());
            outcome?;
        }
        Ok(())
    }

    fn label(&self, step: &Step) -> String {
        let name = |worker: &usize| self.workers[*worker].name.as_str();
        match step {
            Step::BuildWasm => "build Wasm (worker-build --release)".into(),
            Step::BuildFrontend => "build frontend".into(),
            Step::InstallPrebuilt => "install CI outputs".into(),
            Step::BuildImage => "build runtime image (linux/amd64)".into(),
            Step::PushImage => "push runtime image".into(),
            Step::RecordImage => "record runtime inputs".into(),
            Step::Migrate { database, .. } => format!("D1 migrations {database}"),
            Step::ActiveGate { worker } => format!("busy containers {}", name(worker)),
            Step::RetiredGate => "busy containers of retired Workers".into(),
            Step::RolloutGate => "rollout gate (busy containers)".into(),
            Step::MoveHosts { worker } => format!("move hosts to {}", name(worker)),
            Step::DetachConsumers { worker, .. } => {
                format!("stale queue consumers {}", name(worker))
            }
            Step::Deploy { worker, dry_run } => {
                format!(
                    "deploy {}{}",
                    name(worker),
                    if *dry_run { " (dry run)" } else { "" }
                )
            }
            Step::Secrets { worker } => format!("secrets {}", name(worker)),
            Step::Health { worker } => format!("/health {}", name(worker)),
            Step::Smoke => "smoke".into(),
        }
    }

    async fn step(&mut self, step: Step, summary: &mut BTreeMap<usize, Vec<String>>) -> Result<()> {
        let (env, spec, workers, options, head) =
            (self.env, self.spec, self.workers, self.options, self.head);
        match step {
            Step::BuildWasm => crate::commands::build_wasm()?,
            Step::BuildFrontend => frontend_build()?,
            Step::InstallPrebuilt => prebuilt(self.prebuilt)?.install(spec)?,
            Step::BuildImage => {
                let id = crate::deploy_registry::build_local(spec)?;
                let tag = crate::deploy_prebuilt::runtime_tag(&spec.prefix, &id)?;
                self.image = Some(crate::deploy_prebuilt::registry_ref(spec, &tag));
            }
            Step::PushImage => match self.prebuilt {
                Some(p) => p.push(spec)?,
                None => {
                    let image = self.image.as_deref().ok_or("No image was built to push")?;
                    let local = image.rsplit('/').next().unwrap_or(image);
                    crate::deploy_registry::push(spec, local)?;
                }
            },
            // Best effort: a missing record only means the next workstation deploy rebuilds.
            Step::RecordImage => match self.record().await {
                Ok(record) => println!("Recorded runtime inputs: {record}"),
                Err(error) => println!("WARNING: runtime inputs not recorded ({error})."),
            },
            Step::Migrate { database, config } => wrangler::run(
                &spec.account_id,
                &[
                    "d1",
                    "migrations",
                    "apply",
                    &database,
                    "--remote",
                    "--config",
                    &config,
                ],
            )?,
            Step::ActiveGate { worker } => {
                let active = crate::deploy_live::active_instances(
                    &spec.account_id,
                    &workers[worker].config,
                )?;
                guard::active_gate(env, &workers[worker].name, active, options)?;
            }
            Step::RetiredGate => {
                let retired = &spec.retired;
                if !retired.is_empty() {
                    let busy = crate::deploy_live::busy_apps(&spec.account_id, |name| {
                        retired.matches(Kind::Container, name)
                    })?;
                    let active = busy.iter().map(|(_, count)| count).sum();
                    guard::active_gate(env, "the cutover (retired Workers)", active, options)?;
                }
            }
            Step::MoveHosts { worker } => {
                let token = self.host_token.ok_or("Host moves need an API token")?;
                let moves = crate::infra::hosts::detach(spec, token, &workers[worker]).await?;
                if moves.is_empty() {
                    println!("Host moves: none for {}.", workers[worker].name);
                }
            }
            Step::DetachConsumers { worker, dry_run } => {
                let token = self
                    .host_token
                    .map(str::to_owned)
                    .or_else(crate::deploy_credentials::current);
                let Some(token) = token else {
                    println!(
                        "WARNING: no API token, so stale queue consumers of {} were not checked. If the deploy fails with code 11001, run `wrangler queues consumer remove <queue> {}`.",
                        workers[worker].name, workers[worker].name
                    );
                    return Ok(());
                };
                let stale =
                    crate::infra::consumers::detach(spec, &token, &workers[worker], dry_run)
                        .await?;
                if stale.is_empty() {
                    println!("Queue consumers: none stale for {}.", workers[worker].name);
                }
            }
            Step::RolloutGate => {
                let mut busy = Vec::new();
                for worker in workers.iter().filter(|w| w.has_containers) {
                    busy.extend(crate::deploy_live::busy_instances(
                        &spec.account_id,
                        &worker.config,
                    )?);
                }
                guard::rollout_gate(&busy, options)?;
            }
            Step::Deploy { worker, dry_run } => {
                let w = &workers[worker];
                let revision = format!("BUILD_REVISION:{head}");
                // With a registry image, containers deploy it from a config copy.
                let copy = crate::deploy_prebuilt::ConfigCopy::write(self.image.as_deref(), w)?;
                let config = copy.as_ref().map_or(w.config_path.as_str(), |c| c.path());
                let mut deploy = vec!["deploy", "--config", config, "--var", &revision];
                if dry_run {
                    deploy.push("--dry-run");
                }
                wrangler::run(&spec.account_id, &deploy)?;
                let state = if dry_run { "dry run" } else { "deployed" };
                summary.insert(worker, row(w, state, "-"));
            }
            Step::Secrets { worker } => crate::deploy_secrets::ensure(spec, &workers[worker])?,
            Step::Health { worker } => {
                let w = &workers[worker];
                let live = crate::deploy_live::wait_for_revision(w, head).await;
                if let Some(row) = summary.get_mut(&worker) {
                    row[3] = live.clone().unwrap_or_else(|| "unreachable".into());
                }
                guard::revision_gate(&w.name, head, live.as_deref())?;
            }
            Step::Smoke => {
                crate::infra::smoke::run(&["--env".to_owned(), env.name()]).await?;
            }
        }
        Ok(())
    }

    async fn record(&mut self) -> Result<String> {
        let image = self.image.clone().ok_or("no registry image")?;
        let inputs = match &self.inputs {
            Some(inputs) => inputs.clone(),
            None => crate::deploy_inputs::inputs_hash(self.head)?,
        };
        crate::deploy_registry::record(self.spec, &image, &inputs).await
    }
}

fn row(w: &Deployable, state: &str, revision: &str) -> Vec<String> {
    vec![
        w.name.clone(),
        w.config_path.clone(),
        state.into(),
        revision.into(),
    ]
}

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

/// Builds the frontend without pnpm (worktrees symlink node_modules).
pub(crate) fn frontend_build() -> Result<()> {
    for (program, args) in [
        ("node_modules/.bin/tsc", vec!["-b"]),
        ("node_modules/.bin/vite", vec!["build"]),
    ] {
        let status = std::process::Command::new(program)
            .args(&args)
            .current_dir(crate::layout::FRONTEND)
            .status()
            .map_err(|error| format!("Cannot start frontend {program}: {error}"))?;
        if !status.success() {
            return Err(format!("Frontend {program} failed ({status})").into());
        }
    }
    Ok(())
}
