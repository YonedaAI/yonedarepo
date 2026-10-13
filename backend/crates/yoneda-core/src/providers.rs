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
    pub label: String,
    #[serde(default)]
    pub reasoning_efforts: Vec<String>,
    pub reasoning_default: Option<String>,
    pub reasoning_control: Option<String>,
    pub reasoning_source_url: Option<String>,
    #[serde(default)]
    pub auto_seed_eligible: bool,
    pub conservative_pricing: Option<crate::model_budget::ConservativePricing>,
    pub pricing_source_url: Option<String>,
    pub pricing_verified_at: Option<String>,
    pub pricing_input_token_ceiling: Option<i64>,
    pub pricing_basis: Option<String>,
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
    #[test]
    fn modern_catalog_has_exact_reasoning_and_cache_safe_prices_without_changing_defaults() {
        let values: Vec<serde_json::Value> = serde_json::from_str(MANIFEST).unwrap();
        let model = |provider: &str, id: &str| {
            values.iter().find(|p| p["id"] == provider).unwrap()["models"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["id"] == id)
                .unwrap()
                .clone()
        };
        let five = serde_json::json!(["low", "medium", "high", "xhigh", "max"]);
        for (id, default) in [
            ("claude-opus-5-5", "medium"),
            ("claude-sonnet-5-5", "high"),
            ("claude-haiku-5-5", "medium"),
        ] {
            let m = model("claude", id);
            assert_eq!(m["reasoning_efforts"], five);
            assert_eq!(m["reasoning_default"], default);
        }
        assert_eq!(model("codex", "gpt-6.1-sol")["reasoning_efforts"], five);
        for id in ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-luna"] {
            assert_eq!(
                model("codex", id)["reasoning_efforts"],
                serde_json::json!(["none", "low", "medium", "high", "xhigh", "max"])
            );
        }
        for id in ["glm-5.3", "glm-5.3-flash"] {
            assert_eq!(
                model("zai", id)["reasoning_efforts"],
                serde_json::json!(["low", "high", "max"])
            );
            assert_eq!(model("zai", id)["reasoning_default"], "max");
        }
        let haiku = model("claude", "claude-haiku-5-5");
        assert_eq!(
            haiku["conservative_pricing"]["input_microusd_per_million"],
            1_000_000
        );
        assert_eq!(
            haiku["conservative_pricing"]["output_microusd_per_million"],
            2_500_000
        );
        for (id, input, output) in [
            ("gpt-6.1-sol", 2_500_000, 10_000_000),
            ("gpt-6-sol", 2_500_000, 10_000_000),
            ("gpt-6-luna", 125_000, 500_000),
        ] {
            let m = model("codex", id);
            assert_eq!(
                m["conservative_pricing"]["input_microusd_per_million"],
                input
            );
            assert_eq!(
                m["conservative_pricing"]["output_microusd_per_million"],
                output
            );
            assert_eq!(m["auto_seed_eligible"], false);
        }
        assert_eq!(provider("codex").unwrap().default_model, "gpt-5.6-luna");
        assert_eq!(provider("zai").unwrap().default_model, "glm-5.3-flash");
    }
    #[test]
    fn labels_are_model_names_and_new_models_require_explicit_compatibility_validation() {
        let values: Vec<serde_json::Value> = serde_json::from_str(MANIFEST).unwrap();
        for p in values {
            for m in p["models"].as_array().unwrap() {
                let label = m["label"].as_str().unwrap();
                assert!(!label.contains('·'));
                assert!(
                    !["default", "funded", "operator", "repair", "legacy"]
                        .iter()
                        .any(|term| label.to_lowercase().contains(term))
                );
                if m["id"] == "claude-haiku-5-5" || m["id"] == "glm-5.3" {
                    assert_eq!(m["auto_seed_eligible"], false);
                }
                if let Some(efforts) = m["reasoning_efforts"].as_array() {
                    if !m["reasoning_default"].is_null() {
                        assert!(efforts.contains(&m["reasoning_default"]));
                    }
                    assert_eq!(
                        efforts
                            .iter()
                            .map(|e| e.as_str().unwrap())
                            .collect::<BTreeSet<_>>()
                            .len(),
                        efforts.len()
                    );
                    assert!(
                        m["reasoning_source_url"]
                            .as_str()
                            .unwrap()
                            .starts_with("https://")
                    );
                }
            }
        }
    }
}
