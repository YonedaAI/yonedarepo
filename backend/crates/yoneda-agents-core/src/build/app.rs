//! Versioned owner-approved application execution and additive SQLite migrations.
use crate::{Error, Result, validate_path};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AppManifest {
    pub version: u32,
    /// Compiled ES module; sibling modules are captured from the same directory.
    pub entrypoint: String,
    pub export_name: String,
    pub migrations: Vec<AppMigration>,
    /// Initial seed is installed only once, in a fresh candidate or published DB.
    #[serde(default)]
    pub seed: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AppMigration {
    pub version: u32,
    pub sql: Vec<String>,
}
impl AppManifest {
    pub fn validate(&self) -> Result<()> {
        validate_path(&self.entrypoint)?;
        if self.version != 1
            || !["js", "mjs"].contains(&self.entrypoint.rsplit('.').next().unwrap_or(""))
            || self.export_name.is_empty()
            || self.export_name.len() > 64
            || !self
                .export_name
                .bytes()
                .enumerate()
                .all(|(i, b)| b.is_ascii_alphabetic() || b == b'_' || (i > 0 && b.is_ascii_digit()))
            || self.migrations.is_empty()
            || self.migrations.len() > 32
            || self.seed.len() > 128
        {
            return Err(Error::new("INVALID_INPUT", "Invalid application manifest"));
        }
        for (index, migration) in self.migrations.iter().enumerate() {
            if usize::try_from(migration.version).ok() != Some(index + 1)
                || migration.sql.is_empty()
                || migration.sql.len() > 32
                || migration.sql.iter().any(|sql| !additive_sql(sql))
            {
                return Err(Error::new(
                    "INVALID_INPUT",
                    "App migrations must be ordered and additive",
                ));
            }
        }
        if self.seed.iter().any(|sql| {
            !single_statement(sql) || !sql.trim().to_ascii_uppercase().starts_with("INSERT INTO ")
        }) {
            return Err(Error::new("INVALID_INPUT", "Invalid application seed"));
        }
        Ok(())
    }
}
fn single_statement(sql: &str) -> bool {
    !sql.is_empty()
        && sql.len() <= 16_384
        && !sql.contains(['\0', ';'])
        && !sql.contains("--")
        && !sql.contains("/*")
        && !sql.to_ascii_lowercase().contains("_yoneda_")
}
fn additive_sql(sql: &str) -> bool {
    if !single_statement(sql) {
        return false;
    }
    let words: Vec<_> = sql
        .split_ascii_whitespace()
        .map(str::to_ascii_uppercase)
        .collect();
    matches!(words.as_slice(), [a, b, ..] if a == "CREATE" && (b == "TABLE" || b == "INDEX"))
        || matches!(words.as_slice(), [a,b,c,..] if a=="CREATE" && b=="UNIQUE" && c=="INDEX")
        || matches!(words.as_slice(), [a,b,_,d,e,..] if a=="ALTER" && b=="TABLE" && d=="ADD" && e=="COLUMN")
}
