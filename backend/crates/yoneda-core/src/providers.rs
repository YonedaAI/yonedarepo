//! Public provider descriptors shared with browser and egress adapters. Never contains credentials.
use crate::{Error, Result};
use serde::Deserialize;
use std::sync::OnceLock;

pub const MANIFEST: &str = include_str!("providers.json");

#[derive(Debug, Deserialize)]
pub struct ProviderDefinition {
    pub id: String,
    pub harness: String,
    pub default_model: String,
    pub allow_custom_model: bool,
    pub models: Vec<ModelDefinition>,
}

#[derive(Debug, Deserialize)]
pub struct ModelDefinition {
    pub id: String,
}

/// Parse once without panics; a corrupt built-in catalog fails closed.
pub fn provider(id: &str) -> Result<&'static ProviderDefinition> {
    static REGISTRY: OnceLock<Result<Vec<ProviderDefinition>>> = OnceLock::new();
    let registry = REGISTRY.get_or_init(|| {
        serde_json::from_str(MANIFEST).map_err(|e| Error::new("PROVIDER_REGISTRY", e.to_string()))
    });
    registry
        .as_ref()
        .map_err(Clone::clone)?
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| Error::new("INVALID_INPUT", "Unknown provider"))
}

pub fn validate_model(id: &str, model: &str) -> Result<()> {
    let definition = provider(id)?;
    if !definition.allow_custom_model && !definition.models.iter().any(|m| m.id == model) {
        return Err(Error::new(
            "INVALID_INPUT",
            "Model is not permitted for this provider",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    #[test]
    fn registry_is_unique_has_valid_defaults_and_pins_protocols() {
        let values: Vec<serde_json::Value> = serde_json::from_str(MANIFEST).unwrap();
        let mut ids = BTreeSet::new();
        for value in values {
            let id = value["id"].as_str().unwrap();
            assert!(ids.insert(id.to_owned()));
            let entry = provider(id).unwrap();
            assert!(entry.models.iter().any(|m| m.id == entry.default_model));
            assert!(["claude", "codex", "gemini"].contains(&entry.harness.as_str()));
            assert!(value["api_base"].as_str().unwrap().starts_with("https://"));
            assert_eq!(
                value["api_base"].as_str().unwrap().matches("://").count(),
                1
            );
            let expected = match entry.harness.as_str() {
                "claude" => "anthropic_messages",
                "codex" => "openai_responses",
                _ => "gemini_generate_content",
            };
            assert_eq!(value["protocol"], expected);
        }
        assert!(validate_model("claude", "claude-opus-4-6").is_err());
        assert!(provider("unknown").is_err());
    }
}
