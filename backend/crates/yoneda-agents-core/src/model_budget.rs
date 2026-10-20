//! Owner-approved limits use integer microdollars and conservative token ceilings.
use crate::{Error, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const MAX_SAFE_BUDGET_INTEGER: i64 = 9_007_199_254_740_991;
pub const MAX_MODEL_INPUT_BYTES: i64 = 256 * 1024;
/// Owner-approved wall time per execution; queued jobs have a separate wait window.
pub const MAX_MODEL_EXECUTION_MS: i64 = 1_800_000;
const TOKEN_OVERHEAD: i64 = 8192;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConservativePricing {
    pub input_microusd_per_million: i64,
    pub output_microusd_per_million: i64,
    pub source: PricingSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub enum PricingSource {
    #[serde(rename = "owner-approved conservative rates")]
    OwnerApproved,
}

/// Configuration freezes at run creation; ledger counters are shared by model group.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ModelBudget {
    pub provider: String,
    pub model: String,
    /// None means no request cap; provider quotas and execution limits still apply.
    pub max_requests: Option<i64>,
    pub max_output_tokens: i64,
    pub max_execution_ms: i64,
    pub spend_limit_microusd: Option<i64>,
    pub pricing: Option<ConservativePricing>,
    #[serde(default)]
    pub requests: i64,
    #[serde(default)]
    pub charged_microusd: i64,
}
impl ModelBudget {
    pub fn validate_configuration(&self) -> Result<()> {
        let valid_rate = |rate| (0..=MAX_SAFE_BUDGET_INTEGER).contains(&rate);
        if crate::providers::validate_model(&self.provider, &self.model).is_err()
            || self.model.is_empty()
            || self.model.len() > 128
            || !self
                .model
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._/".contains(&b))
            || self
                .max_requests
                .is_some_and(|limit| !(1..=MAX_SAFE_BUDGET_INTEGER).contains(&limit))
            || !(256..=4096).contains(&self.max_output_tokens)
            || !(60_000..=MAX_MODEL_EXECUTION_MS).contains(&self.max_execution_ms)
            || self
                .spend_limit_microusd
                .is_some_and(|limit| !(1..=MAX_SAFE_BUDGET_INTEGER).contains(&limit))
            || self.spend_limit_microusd.is_some() && self.pricing.is_none()
            || self.pricing.as_ref().is_some_and(|p| {
                !valid_rate(p.input_microusd_per_million)
                    || !valid_rate(p.output_microusd_per_million)
            })
            || self.requests != 0
            || self.charged_microusd != 0
        {
            return Err(Error::new(
                "INVALID_INPUT",
                "Invalid model budget, conservative pricing or nonzero initial usage",
            ));
        }
        Ok(())
    }

    /// Ceil once after summing both token categories, with checked integer arithmetic.
    pub fn charge(&self, input_tokens: i64, output_tokens: i64) -> Result<i64> {
        if !(0..=MAX_SAFE_BUDGET_INTEGER).contains(&input_tokens)
            || !(0..=MAX_SAFE_BUDGET_INTEGER).contains(&output_tokens)
        {
            return Err(Error::new(
                "INVALID_INPUT",
                "Invalid model usage token counts",
            ));
        }
        let Some(pricing) = &self.pricing else {
            return Ok(0);
        };
        let value = i128::from(input_tokens)
            .checked_mul(i128::from(pricing.input_microusd_per_million))
            .and_then(|input| {
                i128::from(output_tokens)
                    .checked_mul(i128::from(pricing.output_microusd_per_million))
                    .and_then(|output| input.checked_add(output))
            })
            .and_then(|cost| cost.checked_add(999_999))
            .ok_or_else(|| Error::new("RESOURCE_LIMIT", "Model price calculation overflow"))?
            / 1_000_000;
        let charge = i64::try_from(value)
            .ok()
            .filter(|v| (0..=MAX_SAFE_BUDGET_INTEGER).contains(v))
            .ok_or_else(|| {
                Error::new(
                    "RESOURCE_LIMIT",
                    "Model price exceeds supported integer range",
                )
            })?;
        Ok(charge)
    }

    /// Text input reserves one token per UTF-8 byte plus fixed protocol overhead.
    pub fn reserve_charge(
        &self,
        input_bytes: i64,
        output_tokens: i64,
        count_only: bool,
    ) -> Result<(i64, i64)> {
        if !(0..=MAX_MODEL_INPUT_BYTES).contains(&input_bytes)
            || (count_only && output_tokens != 0)
            || (!count_only && !(1..=self.max_output_tokens).contains(&output_tokens))
        {
            return Err(Error::new(
                "INVALID_INPUT",
                "Model request exceeds its approved input or output limits",
            ));
        }
        if count_only {
            return Ok((0, 0));
        }
        let input_tokens = input_bytes + TOKEN_OVERHEAD;
        Ok((self.charge(input_tokens, output_tokens)?, input_tokens))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn model_budget_fixed_point_zero_rates_and_overflow_fail_closed() {
        let mut budget: ModelBudget =
            serde_json::from_value(json!({"provider":"mimo","model":"flash",
            "max_requests":40,"max_output_tokens":4096,"max_execution_ms":600000,
            "spend_limit_microusd":null,"pricing":{"input_microusd_per_million":1,
            "output_microusd_per_million":1,"source":"owner-approved conservative rates"}}))
            .unwrap();
        assert_eq!(budget.charge(1, 1).unwrap(), 1);
        budget.pricing.as_mut().unwrap().input_microusd_per_million = 0;
        budget.pricing.as_mut().unwrap().output_microusd_per_million = 0;
        assert_eq!(budget.reserve_charge(262144, 4096, false).unwrap().0, 0);
        budget.pricing.as_mut().unwrap().input_microusd_per_million = MAX_SAFE_BUDGET_INTEGER;
        assert_eq!(
            budget.charge(MAX_SAFE_BUDGET_INTEGER, 1).unwrap_err().code,
            "RESOURCE_LIMIT"
        );
    }
}
