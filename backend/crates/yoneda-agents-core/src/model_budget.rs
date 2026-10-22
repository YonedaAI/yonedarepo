//! Owner-approved limits use integer microdollars and conservative token ceilings.
use crate::{Error, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const MAX_SAFE_BUDGET_INTEGER: i64 = 9_007_199_254_740_991;
pub const MAX_MODEL_INPUT_BYTES: i64 = 256 * 1024;
/// Platform wall-clock safety ceiling per agent attempt; queued jobs have a separate wait window.
/// A progressing attempt is never stopped before this ceiling.
pub const MAX_MODEL_EXECUTION_MS: i64 = 1_800_000;
/// Default no-progress window. An attempt is stopped only after this long without a model
/// response, tool call, file write or in-flight provider request.
pub const DEFAULT_IDLE_TIMEOUT_MS: i64 = 300_000;
/// Smallest output allowance a request may be shrunk to before it is refused.
pub const MIN_MODEL_OUTPUT_TOKENS: i64 = 256;
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
    /// Legacy owner time field. The attempt ceiling is now [`MAX_MODEL_EXECUTION_MS`];
    /// progress, not wall time, decides when an attempt stops.
    pub max_execution_ms: i64,
    /// Optional no-progress window; [`DEFAULT_IDLE_TIMEOUT_MS`] applies when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_timeout_ms: Option<i64>,
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
                .idle_timeout_ms
                .is_some_and(|idle| !(60_000..=MAX_MODEL_EXECUTION_MS).contains(&idle))
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

    /// Wall-clock safety ceiling for one attempt of this model group.
    pub fn attempt_ceiling_ms(&self) -> i64 {
        MAX_MODEL_EXECUTION_MS
    }

    /// No-progress window for one attempt, never longer than the ceiling.
    pub fn idle_timeout_ms(&self) -> i64 {
        self.idle_timeout_ms
            .unwrap_or(DEFAULT_IDLE_TIMEOUT_MS)
            .clamp(60_000, self.attempt_ceiling_ms())
    }

    /// Largest output allowance whose worst-case reservation fits the remaining approved spend.
    /// `None` means not even [`MIN_MODEL_OUTPUT_TOKENS`] fits, so the request must be refused.
    /// The provider enforces the returned output cap, so actual spend can never exceed the limit.
    pub fn fit_output_tokens(&self, input_bytes: i64, requested: i64) -> Result<Option<i64>> {
        let (amount, _) = self.reserve_charge(input_bytes, requested, false)?;
        let Some(limit) = self.spend_limit_microusd else {
            return Ok(Some(requested));
        };
        let remaining = limit.saturating_sub(self.charged_microusd);
        if amount <= remaining {
            return Ok(Some(requested));
        }
        let (mut low, mut high) = (
            MIN_MODEL_OUTPUT_TOKENS,
            requested.min(self.max_output_tokens),
        );
        if low > high || self.reserve_charge(input_bytes, low, false)?.0 > remaining {
            return Ok(None);
        }
        while low < high {
            let middle = low + (high - low + 1) / 2;
            if self.reserve_charge(input_bytes, middle, false)?.0 <= remaining {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        Ok(Some(low))
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

    fn priced(limit: Option<i64>, charged: i64) -> ModelBudget {
        let mut budget: ModelBudget = serde_json::from_value(json!({"provider":"zai",
            "model":"glm-5.3-flash","max_requests":null,"max_output_tokens":4096,
            "max_execution_ms":600000,"spend_limit_microusd":limit,"pricing":{
            "input_microusd_per_million":1_000_000,"output_microusd_per_million":4_000_000,
            "source":"owner-approved conservative rates"}}))
        .unwrap();
        budget.charged_microusd = charged;
        budget
    }

    #[test]
    fn idle_window_defaults_to_five_minutes_under_the_thirty_minute_ceiling() {
        let mut budget = priced(None, 0);
        assert_eq!(budget.attempt_ceiling_ms(), 1_800_000);
        assert_eq!(budget.idle_timeout_ms(), 300_000);
        budget.idle_timeout_ms = Some(120_000);
        assert_eq!(budget.idle_timeout_ms(), 120_000);
        budget.validate_configuration().unwrap();
        budget.idle_timeout_ms = Some(10_000);
        assert_eq!(
            budget.validate_configuration().unwrap_err().code,
            "INVALID_INPUT"
        );
        // Absent idle windows are not serialized, so older runtimes read new budgets unchanged.
        budget.idle_timeout_ms = None;
        assert!(
            serde_json::to_value(&budget)
                .unwrap()
                .get("idle_timeout_ms")
                .is_none()
        );
    }

    #[test]
    fn output_fit_shrinks_the_request_instead_of_refusing_when_actual_spend_leaves_room() {
        // 1 µ$/input token, 4 µ$/output token; 1000 input bytes reserve 9192 input tokens.
        let unlimited = priced(None, 0);
        assert_eq!(unlimited.fit_output_tokens(1000, 4096).unwrap(), Some(4096));
        let full = priced(Some(1_000_000), 0);
        assert_eq!(full.fit_output_tokens(1000, 4096).unwrap(), Some(4096));
        // Remaining 13_192 µ$: worst case 9192 + 4096*4 = 25_576 does not fit, 1000 tokens do.
        let tight = priced(Some(20_000), 20_000 - 13_192);
        let fitted = tight.fit_output_tokens(1000, 4096).unwrap().unwrap();
        assert_eq!(fitted, 1000);
        assert!(tight.reserve_charge(1000, fitted, false).unwrap().0 <= 13_192);
        assert!(tight.reserve_charge(1000, fitted + 1, false).unwrap().0 > 13_192);
        // Below the minimum useful output the request is still refused: no real overspend.
        let exhausted = priced(Some(20_000), 20_000 - 9192 - 256 * 4 + 1);
        assert_eq!(exhausted.fit_output_tokens(1000, 4096).unwrap(), None);
    }
}
