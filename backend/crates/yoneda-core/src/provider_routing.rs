//! Fixed provider products and regions; connection metadata never supplies an arbitrary URL.
use crate::{Error, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "plan", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProviderRouting {
    ApiCredits,
    TokenPlan { region: MiMoRegion },
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MiMoRegion {
    Cn,
    Sgp,
    Ams,
}

impl ProviderRouting {
    pub fn validate(&self, provider: &str) -> Result<()> {
        if provider != "mimo" {
            return Err(Error::new(
                "INVALID_INPUT",
                "Plan routing is only available for MiMo",
            ));
        }
        Ok(())
    }
}
