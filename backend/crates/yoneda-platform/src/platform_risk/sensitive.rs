//! Paths that steer the build, access or data, by what they do. Matched on whole path
//! segments and words, so `author.rs` is not auth and `block.rs` is not a lockfile.
use crate::platform_instructions::is_instructions;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Sensitive {
    Policy,
    Workflows,
    Auth,
    Migrations,
    Lockfiles,
}

impl Sensitive {
    pub fn points(self) -> u32 {
        match self {
            Self::Policy | Self::Workflows | Self::Auth => 20,
            Self::Migrations => 15,
            Self::Lockfiles => 10,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Policy => "Policy",
            Self::Workflows => "Workflows",
            Self::Auth => "Auth",
            Self::Migrations => "Migrations",
            Self::Lockfiles => "Lockfiles",
        }
    }
}

const LOCKFILES: [&str; 15] = [
    "bun.lock",
    "bun.lockb",
    "cargo.lock",
    "composer.lock",
    "flake.lock",
    "gemfile.lock",
    "go.sum",
    "mix.lock",
    "package-lock.json",
    "pipfile.lock",
    "pnpm-lock.yaml",
    "podfile.lock",
    "poetry.lock",
    "uv.lock",
    "yarn.lock",
];

/// Repository-root prefixes of continuous integration and delivery.
const WORKFLOW_ROOTS: [&str; 5] = [
    ".buildkite/",
    ".circleci/",
    ".github/actions/",
    ".github/workflows/",
    ".gitlab-ci",
];
const WORKFLOW_FILES: [&str; 3] = ["azure-pipelines.yml", "jenkinsfile", ".travis.yml"];

const POLICY_FILES: [&str; 5] = [
    "codeowners",
    "policy.json",
    "policy.toml",
    "policy.yaml",
    "policy.yml",
];

const MIGRATION_DIRECTORIES: [&str; 3] = ["alembic", "migrate", "migrations"];

/// Words of a path that name access control. Not `token` or `session`: lexers and shells
/// use both for something else.
const AUTH_WORDS: [&str; 19] = [
    "acl",
    "auth",
    "authn",
    "authz",
    "authenticate",
    "authentication",
    "authorization",
    "authorize",
    "credential",
    "credentials",
    "jwt",
    "login",
    "oauth",
    "oauth2",
    "oidc",
    "password",
    "permissions",
    "rbac",
    "secrets",
];

/// The path's words: split at anything not alphanumeric and at a lower-to-upper step
/// (`useAuth` is `use`, `auth`), lower-cased.
fn words(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut lower = false;
    for c in path.chars() {
        if (!c.is_alphanumeric() || (lower && c.is_uppercase())) && !word.is_empty() {
            out.push(std::mem::take(&mut word));
        }
        lower = c.is_lowercase() || c.is_ascii_digit();
        if c.is_alphanumeric() {
            word.extend(c.to_lowercase());
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// What a path is, if it is sensitive. A path is one kind, the first that fits.
pub fn kind(path: &str) -> Option<Sensitive> {
    let lower = path.to_ascii_lowercase();
    let (directories, name) = lower.rsplit_once('/').unwrap_or(("", lower.as_str()));
    if is_instructions(path) || POLICY_FILES.contains(&name) || name.ends_with(".rego") {
        return Some(Sensitive::Policy);
    }
    if WORKFLOW_ROOTS.iter().any(|root| lower.starts_with(root)) || WORKFLOW_FILES.contains(&name) {
        return Some(Sensitive::Workflows);
    }
    if LOCKFILES.contains(&name) {
        return Some(Sensitive::Lockfiles);
    }
    if directories
        .split('/')
        .any(|d| MIGRATION_DIRECTORIES.contains(&d))
    {
        return Some(Sensitive::Migrations);
    }
    words(path)
        .iter()
        .any(|w| AUTH_WORDS.contains(&w.as_str()))
        .then_some(Sensitive::Auth)
}
