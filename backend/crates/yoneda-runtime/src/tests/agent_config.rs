use super::*;
use serde_json::json;

#[test]
fn reasoning_effort_selected_settings_reach_codex_config_and_claude_native_arguments() {
    assert!(
        codex_configuration("gpt-5.6-luna", &json!({"reasoning_effort":"high"}))
            .contains("model_reasoning_effort = \"high\"")
    );
    for (provider, model) in [
        ("claude", "claude-haiku-5-5"),
        ("claude", "claude-sonnet-5-5"),
        ("claude", "claude-opus-5-5"),
        ("zai", "glm-5.3-flash"),
    ] {
        let args = claude_arguments(
            &json!({"harness":"claude","provider":provider,"reasoning_effort":"max"}),
            true,
            model,
        );
        assert!(args.windows(2).any(|pair| pair == ["--effort", "max"]));
    }
}

#[test]
fn reasoning_effort_auto_preserves_codex_low_and_claude_native_default() {
    assert!(
        codex_configuration("gpt-5.6-luna", &json!({}))
            .contains("model_reasoning_effort = \"low\"")
    );
    assert!(
        !claude_arguments(
            &json!({"provider":"claude","harness":"claude"}),
            true,
            "claude-sonnet-5-5"
        )
        .contains(&"--effort")
    );
}

#[test]
fn reasoning_effort_runtime_fences_unsupported_or_substituted_frozen_settings() {
    let agent = json!({"connection":"seed","provider":"codex","model":"gpt-5.6-luna","reasoning_effort":"high"});
    let mut job = json!({"model":"gpt-5.6-luna","payload":{"run":{"adaptive_team":{"version":1},"agents":[agent]},"execution":agent}});
    job["payload"]["execution"]["harness"] = json!("codex");
    job["payload"]["execution"]["agent_index"] = json!(0);
    validate_reasoning_job(&job).unwrap();
    for (scope, field, value) in [
        ("execution", "reasoning_effort", json!("max")),
        ("execution", "harness", json!("claude")),
        ("execution", "agent_index", json!(1)),
    ] {
        let mut forged = job.clone();
        forged["payload"][scope][field] = value;
        assert_eq!(validate_reasoning_job(&forged).unwrap_err().code, "FENCED");
    }
    job["model"] = json!("gpt-6-luna");
    assert_eq!(validate_reasoning_job(&job).unwrap_err().code, "FENCED");
}

#[test]
fn harness_budget_actual_anthropic_and_legacy_claude_keep_one_dollar_allowance() {
    for execution in [
        json!({"harness":"claude","provider":"claude"}),
        json!({"harness":"claude"}),
    ] {
        let args = claude_arguments(&execution, false, "claude-sonnet-4-6");
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--max-budget-usd", "1.00"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--model", "claude-sonnet-4-6"])
        );
    }
}

#[test]
fn harness_budget_third_party_models_do_not_use_anthropic_dollar_estimates() {
    for (provider, model) in [("mimo", "mimo-v2.6-flash"), ("zai", "glm-4.7-flash")] {
        let args = claude_arguments(
            &json!({"harness":"claude","provider":provider}),
            false,
            model,
        );
        assert!(!args.contains(&"--max-budget-usd"));
        assert!(args.windows(2).any(|pair| pair == ["--model", model]));
        assert!(args.contains(&"--strict-mcp-config"));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--mcp-config", "/home/agent/mcp.json"])
        );
    }
}

#[test]
fn model_budgets_approved_anthropic_run_uses_owner_allowance_without_hidden_cli_cap() {
    let args = claude_arguments(
        &json!({"harness":"claude","provider":"claude"}),
        true,
        "claude-sonnet-4-6",
    );
    assert!(!args.contains(&"--max-budget-usd"));
    assert!(
        args.windows(2)
            .any(|pair| pair == ["--model", "claude-sonnet-4-6"])
    );
}

#[test]
fn claude_harness_cannot_park_itself_after_its_turn_ends() {
    // A live coordinator finished in 100 s, scheduled a wakeup and held the process until timeout.
    let args = claude_arguments(
        &json!({"harness":"claude","provider":"zai"}),
        true,
        "glm-5.3-flash",
    );
    let position = args
        .iter()
        .position(|arg| *arg == "--disallowedTools")
        .expect("scheduling tools must be disallowed");
    let blocked = args[position + 1];
    for tool in ["ScheduleWakeup", "CronCreate", "Monitor", "RemoteTrigger"] {
        assert!(
            blocked.split(',').any(|name| name == tool),
            "{tool} must be blocked"
        );
    }
}

#[test]
fn read_only_coordinator_has_no_shell_to_sleep_in() {
    // A live GLM coordinator submitted its repair, then ran `sleep 120/180/240` until the
    // execution limit despite the prompt forbidding polling. It inspects with Read/Grep/Glob.
    let blocked = |execution: serde_json::Value| {
        let args = claude_arguments(&execution, true, "glm-5.3-flash");
        let position = args
            .iter()
            .position(|arg| *arg == "--disallowedTools")
            .unwrap();
        args[position + 1].split(',').any(|name| name == "Bash")
    };
    assert!(blocked(
        json!({"harness":"claude","provider":"zai","team_role":"coordinator"})
    ));
    assert!(!blocked(
        json!({"harness":"claude","provider":"zai","team_role":"worker"})
    ));
    assert!(!blocked(
        json!({"harness":"claude","provider":"zai","team_role":"integrator"})
    ));
}

#[tokio::test]
async fn model_budgets_runtime_uses_frozen_output_and_execution_limits() {
    let entry = json!({"provider":"mimo","model":"flash","max_requests":40,"max_output_tokens":512,
        "max_execution_ms":60000,"spend_limit_microusd":null,"pricing":null});
    let mut job = json!({"kind":"agent","payload":{"run":{"model_budgets":[entry]},
        "execution":{"provider":"mimo","model":"flash","budget":{"provider":"mimo","model":"flash"}}}});
    let budget = crate::execution_limits::model_budget(&job)
        .unwrap()
        .unwrap();
    assert_eq!(crate::execution_limits::timeout_ms(&job).unwrap(), 50000);
    let mut command = Command::new("/bin/sh");
    untrusted(&mut command, std::path::Path::new("/tmp"));
    configure_output_limit(&mut command, Some(&budget));
    command.args(["-c", "printf '%s' \"$CLAUDE_CODE_MAX_OUTPUT_TOKENS\""]);
    let output = command.output().await.unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), "512");
    job["payload"]["run"]["model_budgets"][0]["max_execution_ms"] = json!(1_800_000);
    assert_eq!(
        crate::execution_limits::timeout_ms(&job).unwrap(),
        1_790_000
    );
    job["payload"]["execution"]["budget"]["model"] = json!("another-model");
    assert_eq!(
        crate::execution_limits::model_budget(&job)
            .unwrap_err()
            .code,
        "FENCED"
    );
    assert_eq!(
        crate::execution_limits::timeout_ms(&json!({"kind":"agent","payload":{}})).unwrap(),
        570000
    );
}

#[test]
fn gemini_turn_budget_uses_approved_request_allowance_and_preserves_legacy_default() {
    let mcp = json!({"mcpServers":{"yonedarepo":{"command":"/usr/local/bin/yoneda-runtime","args":["mcp"]}}});
    let budget: yoneda_agents_core::model_budget::ModelBudget = serde_json::from_value(json!({
        "provider":"gemini","model":"gemini-3.8-flash","max_requests":48,"max_output_tokens":4096,
        "max_execution_ms":600000,"spend_limit_microusd":null,"pricing":null}))
    .unwrap();
    let legacy = gemini_settings("gemini-3.8-flash", &mcp, None);
    let configured = gemini_settings("gemini-3.8-flash", &mcp, Some(&budget));
    assert_eq!(legacy["model"]["maxSessionTurns"], 24);
    assert_eq!(configured["model"]["maxSessionTurns"], 48);
    assert_eq!(configured["model"]["name"], "gemini-3.8-flash");
    assert_eq!(configured["mcp"]["allowed"], json!(["yonedarepo"]));
    assert_eq!(configured["mcpServers"], mcp["mcpServers"]);
    let mut uncapped = budget;
    uncapped.max_requests = None;
    assert_eq!(
        gemini_settings("gemini-3.8-flash", &mcp, Some(&uncapped))["model"]["maxSessionTurns"],
        -1
    );
}

fn prompt_job(role: &str, harness: &str) -> Value {
    json!({"kind":"agent","payload":{"workspace_transport":"api-source-v1","team_planning":role=="planner"||role=="coordinator",
        "execution":{"id":"execution","harness":harness,"provider":"codex","model":"gpt-5.6-luna","role":"coding","team_role":role,"strategy":"Approved strategy","task":"Approved task","team_task":if role=="worker"||role=="integrator" {json!("task")} else {Value::Null},"budget":{"provider":"codex","model":"gpt-5.6-luna"}},
        "run":{"id":"run","intent":"Preserve booking integrity","criteria":["Exact independently checked integration"],"agents":[{"provider":"codex","model":"gpt-5.6-luna"}],"autonomy_policy":{"version":1,"enabled":true,"max_repair_rounds":2},"intent_clarifications":[{"answer":"Retain the original contract"}],"team_plan":{"contract":"Original contract"},"model_budgets":[{"provider":"codex","model":"gpt-5.6-luna","max_requests":24,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":null,"pricing":null,"requests":4,"charged_microusd":0}]},
        "policy":{"build":{"static_dir":"public"}}}})
}

#[test]
fn read_only_prompt_never_directs_commit_or_push() {
    for role in ["planner", "coordinator"] {
        for harness in ["codex", "claude", "gemini"] {
            let job = prompt_job(role, harness);
            let text = agent_prompt(&job).unwrap();
            assert!(text.contains("read-only"), "{role}: {text}");
            assert!(
                !text.contains("Commit your completed changes"),
                "{role}: read-only role received source commit instructions"
            );
            assert!(
                !text.contains("push them to origin"),
                "{role}: read-only role received source push instructions"
            );
            assert!(text.contains("Retain the original contract"));
        }
    }
}

#[test]
fn codex_read_only_prompt_discovers_and_calls_platform_before_workspace_analysis() {
    for role in ["planner", "coordinator"] {
        let job = prompt_job(role, "codex");
        let before = job.clone();
        let text = agent_prompt(&job).unwrap();
        let discovery = text
            .find("ALL_TOOLS")
            .expect("Codex must discover deferred tools");
        let analysis = if role == "planner" {
            "Inspect the current checkout"
        } else {
            "Read AGENTS.md"
        };
        assert!(discovery < text.find(analysis).unwrap());
        for call in [
            "functions.exec",
            "mcp__yonedarepo__team_context({})",
            "mcp__yonedarepo__peer_status({})",
            "mcp__yonedarepo__peer_inbox({})",
            "platform receipts",
        ] {
            assert!(text.contains(call), "{role}: missing {call}");
        }
        assert_eq!(job, before, "Prompt construction cannot amend approval");
        assert!(text.contains("Preserve booking integrity"));
        assert!(text.contains("gpt-5.6-luna"));
        assert!(text.contains("24"));
        let other = agent_prompt(&prompt_job(role, "claude")).unwrap();
        assert!(!other.contains("ALL_TOOLS"));
    }
}

#[test]
fn coding_source_prompt_forbids_clone_commit_and_push() {
    for role in ["worker", "integrator"] {
        let job = prompt_job(role, "codex");
        let text = agent_prompt(&job).unwrap();
        assert!(text.contains("Workspace transport: api-source-v1"));
        assert!(text.contains("Do not clone, Git commit, push or publish"));
        assert!(!text.contains("ALL_TOOLS"));
    }
}

#[test]
fn comparison_reviewer_prompt_requires_captured_reads_and_submit_without_coding_completion() {
    let mut job = prompt_job("worker", "codex");
    job["payload"]["review_only"] = json!(true);
    job["payload"]["comparison_review"] = json!(true);
    job["payload"]["execution"]["role"] = json!("reviewer");
    job["payload"]["comparison_manifest"] = json!({"version":1,"manifest_digest":"a".repeat(64),"manifest":{"intent":"Preserve booking integrity","criteria":["Exact independently checked integration"],"alternatives":[]}});
    let prompt = agent_prompt(&job).unwrap();
    assert!(prompt.contains("comparison_context"));
    assert!(prompt.contains("comparison_submit"));
    assert!(prompt.contains("read-only"));
    assert!(!prompt.contains("execution_complete"));
    assert!(!prompt.contains("Commit your completed changes"));
    assert!(!prompt.contains("push them to origin"));
}
