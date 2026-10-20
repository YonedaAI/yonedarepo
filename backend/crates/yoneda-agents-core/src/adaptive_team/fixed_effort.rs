use super::*;

pub(super) fn validate(run: &Value, execution: &Value, effort: Option<&str>) -> Result<()> {
    let Some(agents) = run["agents"].as_array() else {
        return if effort.is_none() {
            Ok(())
        } else {
            Err(Error::new(
                "FORBIDDEN",
                "Explicit reasoning requires the original approved agents",
            ))
        };
    };
    if execution["agent_index"].is_null() && effort.is_none() {
        if agents
            .iter()
            .any(|a| matches(a, execution) && !a["reasoning_effort"].is_null())
        {
            return Err(Error::new(
                "FENCED",
                "Original explicit reasoning effort was dropped",
            ));
        }
        return Ok(());
    }
    if let Some(approved) = run["autonomy_approval"]["agents"].as_array()
        && approved != agents
    {
        return Err(Error::new(
            "FENCED",
            "Original fixed agent approval changed",
        ));
    }
    let index = execution["agent_index"]
        .as_u64()
        .and_then(|i| usize::try_from(i).ok())
        .ok_or_else(|| Error::new("FENCED", "Fixed execution has no approved agent slot"))?;
    let agent = agents
        .get(index)
        .ok_or_else(|| Error::new("FENCED", "Fixed execution agent slot changed"))?;
    if !matches(agent, execution) || execution["reasoning_effort"] != agent["reasoning_effort"] {
        return Err(Error::new(
            "FENCED",
            "Fixed execution differs from the original approved model, connection or reasoning effort",
        ));
    }
    Ok(())
}

fn matches(agent: &Value, execution: &Value) -> bool {
    agent["provider"] == execution["provider"]
        && agent["model"] == execution["model"]
        && agent
            .get("connection")
            .filter(|v| !v.is_null())
            .unwrap_or(&agent["provider"])
            == &execution["connection"]
}
