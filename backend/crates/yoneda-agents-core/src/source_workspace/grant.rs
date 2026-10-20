use super::*;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceRole {
    Builder,
    Specialist,
    Integrator,
    Repair,
    Reviewer,
    Planner,
    Coordinator,
    Evaluator,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceAccess {
    ReadOnly,
    ReadWrite,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ActorPurpose {
    Source,
    Supervisor,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceBinding {
    pub version: u32,
    pub transport: String,
    pub workspace_id: String,
    pub repo_id: String,
    pub run_id: String,
    pub job_id: String,
    pub epoch: i64,
    pub execution_id: String,
    pub role: SourceRole,
    pub access: SourceAccess,
    pub view_digest: String,
    pub baseline_overrides_digest: String,
    pub base: SourceRevision,
    pub parents: Vec<String>,
    pub policy_digest: String,
    pub intent_digest: String,
    pub write_paths: Vec<String>,
    pub protected_paths: Vec<String>,
    #[serde(default)]
    pub scratch_paths: Vec<String>,
    pub inputs: Vec<SourceRevision>,
    pub repo_base_version: i64,
    pub working_branch_id: Option<String>,
    pub working_branch_version: Option<i64>,
}
impl SourceBinding {
    pub fn digest(&self) -> Result<String> {
        crate::fingerprint(
            &serde_json::to_value(self).map_err(|_| invalid("Invalid source binding"))?,
        )
    }
    pub fn validate(&self) -> Result<()> {
        if self.version != 1
            || self.transport != TRANSPORT
            || self.repo_base_version < 0
            || self.working_branch_version.is_some_and(|v| v < 0)
            || self.workspace_id
                != workspace_id(&self.repo_id, &self.job_id, self.epoch, &self.view_digest)?
        {
            return Err(invalid("Source binding identity differs"));
        }
        validate_id(&self.run_id)?;
        validate_id(&self.execution_id)?;
        self.base.validate()?;
        validate_hash(&self.policy_digest, &[64])?;
        validate_hash(&self.intent_digest, &[64])?;
        validate_hash(&self.baseline_overrides_digest, &[64])?;
        if self.parents.is_empty()
            || self.parents.len() > 2
            || self.parents[0] != self.base.commit
            || self.inputs.is_empty()
            || self.inputs.len() > 20
            || !self.inputs.contains(&self.base)
        {
            return Err(invalid("Source binding parents or inputs differ"));
        }
        for parent in &self.parents {
            validate_hash(parent, &[40, 64])?;
        }
        for input in &self.inputs {
            input.validate()?;
        }
        if self.access == SourceAccess::ReadOnly && !self.write_paths.is_empty()
            || matches!(
                self.role,
                SourceRole::Reviewer
                    | SourceRole::Planner
                    | SourceRole::Coordinator
                    | SourceRole::Evaluator
            ) && self.access != SourceAccess::ReadOnly
        {
            return Err(invalid(
                "Read-only roles cannot receive source write scopes",
            ));
        }
        let scratch = self
            .scratch_paths
            .iter()
            .collect::<std::collections::BTreeSet<_>>();
        if scratch.len() != self.scratch_paths.len()
            || self
                .scratch_paths
                .iter()
                .any(|p| !SCRATCH_PREFIXES.contains(&p.as_str()))
            || matches!(
                self.role,
                SourceRole::Reviewer | SourceRole::Planner | SourceRole::Coordinator
            ) && !scratch.is_empty()
        {
            return Err(invalid("Invalid frozen source scratch prefixes"));
        }
        if self.write_paths.len() > 64 || self.protected_paths.len() > 128 {
            return Err(invalid("Source scopes exceed bounds"));
        }
        for scope in self.write_paths.iter().chain(&self.protected_paths) {
            if scope != "**" {
                crate::validate_path(scope.trim_end_matches('/'))?;
            }
        }
        Ok(())
    }
    pub fn authorize_path(&self, path: &str) -> Result<()> {
        crate::validate_path(path)?;
        if self
            .scratch_paths
            .iter()
            .any(|p| path == p.trim_end_matches('/') || path.starts_with(p))
        {
            return Err(Error::new(
                "SCRATCH_PATH",
                "Generated local build scratch cannot be staged as source",
            ));
        }
        let allowed = self
            .write_paths
            .iter()
            .any(|p| p == "**" || p == path || p.ends_with('/') && path.starts_with(p));
        let protected = self.protected_paths.iter().any(|p| {
            p == "**"
                || path == p.trim_end_matches('/')
                || path.starts_with(&format!("{}/", p.trim_end_matches('/')))
                || p.starts_with(&format!("{path}/"))
        });
        if self.access != SourceAccess::ReadWrite || !allowed || protected {
            return Err(Error::new(
                "FORBIDDEN",
                "Source path is outside frozen writable scope",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ActorClaims {
    pub version: u32,
    pub workspace_id: String,
    pub binding_digest: String,
    pub repo_id: String,
    pub run_id: String,
    pub job_id: String,
    pub epoch: i64,
    pub execution_id: String,
    pub view_digest: String,
    pub role: SourceRole,
    pub access: SourceAccess,
    pub purpose: ActorPurpose,
    pub expires_at: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ActorGrant {
    pub claims: ActorClaims,
    pub signature: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GcClaims {
    pub version: u32,
    pub workspace_id: String,
    pub binding_digest: String,
    pub repo_id: String,
    pub expires_at: i64,
    pub purpose: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GcGrant {
    pub claims: GcClaims,
    pub signature: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SealClaims {
    pub version: u32,
    pub workspace_id: String,
    pub binding_digest: String,
    pub seal_id: String,
    pub checkpoint_id: String,
    pub changeset_digest: String,
    pub workspace_version: i64,
    pub job_id: String,
    pub epoch: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SealAttestation {
    pub claims: SealClaims,
    pub signature: String,
}
/// Read-only sealed metadata capability for a current trusted capture attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CaptureClaims {
    pub version: u32,
    pub workspace_id: String,
    pub binding_digest: String,
    pub seal_id: String,
    pub checkpoint_id: String,
    pub changeset_digest: String,
    pub capture_job_id: String,
    pub capture_epoch: i64,
    pub expires_at: i64,
    pub purpose: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CaptureGrant {
    pub claims: CaptureClaims,
    pub signature: String,
}
