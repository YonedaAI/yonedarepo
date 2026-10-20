//! Root-owned lifecycle for API source mounts; callers stop/reap model children before sealing.
use crate::{
    source_client::{SOURCE_CACHE_MAX, SourceCancellation, failure},
    source_client_api::ApiSourceClient,
    source_fs::SourceMount,
    source_workspace::SourceWorkspace,
    source_workspace_job::{self, SourceMountSpec},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use yoneda_agents_core::{Result, source_workspace::SourceAccess};

struct Mounted {
    spec: SourceMountSpec,
    client: Arc<ApiSourceClient>,
    mount: SourceMount,
}
pub struct SourceSession {
    root: PathBuf,
    mounts: BTreeMap<String, Mounted>,
    scratch: Vec<crate::source_workspace_scratch::GeneratedScratch>,
    evaluation: bool,
}
impl SourceSession {
    /// Mounts are root/alias. Harness cwd is working_directory(); no Git clone or source walk.
    pub fn prepare(job: &Value, root: &Path) -> Result<Self> {
        Self::prepare_specs(root, source_workspace_job::mounts(job)?, false)
    }
    pub fn prepare_evaluation(job: &Value, root: &Path) -> Result<Self> {
        Self::prepare_specs(root, source_workspace_job::evaluation_mounts(job)?, true)
    }
    fn prepare_specs(root: &Path, specs: Vec<SourceMountSpec>, evaluation: bool) -> Result<Self> {
        let mut clients = Vec::new();
        // Check every frozen view before mounting any view or launching a paid model.
        for spec in specs {
            let supervisor = std::env::var("SUPERVISOR_TOKEN")
                .map_err(|_| failure("FORBIDDEN", "Root source authorization missing"))?;
            let client = ApiSourceClient::root(
                &spec.path,
                &spec.workspace_id,
                &spec.view_digest,
                spec.access == SourceAccess::ReadOnly,
                &supervisor,
            )?;
            let status = client.status()?;
            if status["scratch_paths"]
                != serde_json::to_value(&spec.scratch_paths)
                    .map_err(|_| failure("SOURCE_SCOPE", "Invalid scratch metadata"))?
            {
                return Err(failure(
                    "SOURCE_FENCED",
                    "Frozen scratch proof differs from source binding",
                ));
            }
            if status["base"]
                != serde_json::to_value(&spec.base)
                    .map_err(|_| failure("SOURCE_SCOPE", "Invalid source base"))?
            {
                return Err(failure("SOURCE_FENCED", "Source base identity changed"));
            }
            clients.push((spec, client));
        }
        let mut session = Self {
            root: root.into(),
            mounts: BTreeMap::new(),
            scratch: Vec::new(),
            evaluation,
        };
        for (spec, client) in clients {
            let path = root.join(&spec.path);
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => return Err(failure("SOURCE_MOUNT", "Invalid source mountpoint")),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    std::fs::create_dir(&path).map_err(|_| {
                        failure("SOURCE_MOUNT", "Source mount directory unavailable")
                    })?
                }
                Err(_) => return Err(failure("SOURCE_MOUNT", "Source mountpoint unavailable")),
            }

            let backend: Arc<dyn crate::source_client::SourceBackend> = if evaluation {
                crate::source_workspace_eval::EvaluationSource::new(client.clone())?
            } else {
                client.clone()
            };
            let source = Arc::new(SourceWorkspace::new(
                backend,
                !evaluation && spec.access == SourceAccess::ReadOnly,
                true,
                Arc::new(SourceCancellation::default()),
                SOURCE_CACHE_MAX,
            )?);
            let mount = SourceMount::mount(source, &path)?;
            let alias = spec.path.clone();
            let scratch = spec.scratch_paths.clone();
            session.mounts.insert(
                spec.path.clone(),
                Mounted {
                    spec,
                    client,
                    mount,
                },
            );
            if !scratch.is_empty() {
                session.attach_scratch(&alias, &scratch)?;
            }
        }
        Ok(session)
    }
    pub fn register(
        &self,
        job: &Value,
    ) -> Result<crate::source_workspace_registry::SourceRegistration> {
        let targets = self
            .mounts
            .iter()
            .map(|(alias, mounted)| {
                let invalidator = mounted.mount.invalidator();
                let target: crate::source_workspace_registry::InvalidationTarget =
                    Arc::new(move |paths| invalidator.invalidate(paths));
                (alias.clone(), target)
            })
            .collect();
        crate::source_workspace_registry::register(job, targets)
    }
    pub fn working_directory(&self) -> PathBuf {
        if self.mounts.contains_key("repo") {
            self.root.join("repo")
        } else {
            self.root.clone()
        }
    }
    /// approved is computed server-side from the frozen merged baseline, never from model fields.
    pub fn attach_scratch(&mut self, alias: &str, approved: &[String]) -> Result<()> {
        let mounted = self
            .mounts
            .get(alias)
            .ok_or_else(|| failure("SOURCE_SCOPE", "Unknown source mount"))?;
        if approved != mounted.spec.scratch_paths {
            return Err(failure(
                "SOURCE_SCOPE",
                "Scratch paths differ from the frozen binding",
            ));
        }
        if !self.evaluation && mounted.spec.access == SourceAccess::ReadOnly {
            return Err(failure(
                "SOURCE_READ_ONLY",
                "Readonly agents cannot attach writable scratch",
            ));
        }
        self.scratch
            .push(crate::source_workspace_scratch::GeneratedScratch::mount(
                &self.root.join(alias),
                approved,
            )?);
        Ok(())
    }
    fn close_scratch(&mut self) -> Result<()> {
        while let Some(scratch) = self.scratch.pop() {
            scratch.close()?;
        }
        Ok(())
    }
    /// Call after checker process reaped. All evaluation edits/tombstones are discarded, never sealed.
    pub fn close_evaluation(mut self) -> Result<()> {
        if !self.evaluation {
            return Err(failure("SOURCE_SCOPE", "Not an evaluation mount"));
        }
        self.close_scratch()?;
        for (_, mounted) in std::mem::take(&mut self.mounts) {
            mounted.mount.close()?;
        }
        Ok(())
    }
    /// MCP and CLI share the same API authority; invalidate kernel data before exposing API writes.
    pub fn invalidate(&self, alias: &str, paths: &[String]) -> Result<()> {
        self.mounts
            .get(alias)
            .ok_or_else(|| failure("SOURCE_SCOPE", "Unknown source mount"))?
            .mount
            .invalidate(paths)
    }
    /// Supervisor capability stays solely in this root call; output is private completion metadata.
    pub fn finish(mut self, request_id: &str, supervisor: &str) -> Result<Value> {
        if self.evaluation {
            return Err(failure("SOURCE_SCOPE", "Evaluation cannot seal source"));
        }
        self.close_scratch()?;
        let mut results = serde_json::Map::new();
        // Closing the sessions flushes no independent overlay: every FS write already committed.
        // Stop all FUSE request threads BEFORE checkpoint/seal, so no late child write races it.
        let mut closed = Vec::new();
        for (alias, mounted) in std::mem::take(&mut self.mounts) {
            let Mounted {
                spec,
                client,
                mount,
            } = mounted;
            mount.close()?;
            closed.push((alias, spec, client));
        }
        for (alias, spec, client) in closed {
            let receipt = if spec.access == SourceAccess::ReadWrite {
                client.seal(&format!("{request_id}-{alias}"), supervisor)?
            } else {
                let status = client.status()?;
                if status["workspace_version"] != 0 {
                    return Err(failure("SOURCE_FENCED", "Readonly source changed"));
                }
                json!({"source_unchanged":true,"workspace_id":spec.workspace_id,"view_digest":spec.view_digest})
            };
            results.insert(alias, receipt);
        }
        Ok(json!({"transport":"api-source-v1","mounts":results,"checked":false,"published":false}))
    }
}

impl Drop for SourceSession {
    fn drop(&mut self) {
        let _ = self.close_scratch();
        self.mounts.clear();
    }
}
