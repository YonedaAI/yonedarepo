use super::*;
use std::cell::RefCell;

const TRANSIENT: &str = "\x1b[31m[ERROR]\x1b[0m A request to the Cloudflare API failed.\n  Pipeline binding error. Please try again later or contact support. [code: 10021]\n";

fn failed(output: &str) -> Result<Attempt> {
    Ok(Attempt {
        success: false,
        failure: "wrangler deploy failed (exit status: 1)".into(),
        stdout: vec![],
        stderr: output.as_bytes().to_vec(),
    })
}
fn success() -> Result<Attempt> {
    Ok(Attempt {
        success: true,
        failure: String::new(),
        stdout: vec![],
        stderr: vec![],
    })
}

#[test]
fn actual_pipeline_failure_retries_same_step_then_succeeds() {
    let events = RefCell::new(Vec::new());
    let mut calls = 0;
    let result = retry(
        false,
        || {
            events.borrow_mut().push("guard");
            Ok(())
        },
        || {
            events.borrow_mut().push("run");
            calls += 1;
            if calls == 1 {
                failed(TRANSIENT)
            } else {
                success()
            }
        },
        |delay| {
            assert_eq!(delay, Duration::from_secs(2));
            events.borrow_mut().push("sleep");
        },
    );
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(*events.borrow(), ["guard", "run", "sleep", "guard", "run"]);
}

#[test]
fn unrelated_validation_auth_and_config_errors_do_not_retry() {
    for output in [
        "Invalid binding type. [code: 10021]",
        "Authentication error [code: 10000]",
        "Invalid configuration",
        "Pipeline binding error. Please try again later or contact support. [code: 10000]",
        "Pipeline binding error. Please try again later or contact support.\nUnrelated validation [code: 10021]",
        "Pipeline binding error. Please try again later or contact support. [code: 100210]",
    ] {
        let mut calls = 0;
        let result = retry(
            false,
            || Ok(()),
            || {
                calls += 1;
                failed(output)
            },
            |_| panic!("must not sleep"),
        );
        assert!(result.is_err());
        assert_eq!(calls, 1, "{output}");
    }
}

#[test]
fn dry_run_never_retries_even_the_exact_transient_error() {
    let mut calls = 0;
    let result = retry(
        true,
        || Ok(()),
        || {
            calls += 1;
            failed(TRANSIENT)
        },
        |_| panic!("must not sleep"),
    );
    assert!(result.is_err());
    assert_eq!(calls, 1);
}

#[test]
fn exhausted_retry_preserves_failure_and_bounds_delays() {
    let mut calls = 0;
    let mut guards = 0;
    let mut delays = Vec::new();
    let result = retry(
        false,
        || {
            guards += 1;
            Ok(())
        },
        || {
            calls += 1;
            failed(TRANSIENT)
        },
        |delay| delays.push(delay.as_secs()),
    );
    assert_eq!(
        result.unwrap_err().to_string(),
        "wrangler deploy failed (exit status: 1)"
    );
    assert_eq!(calls, 4);
    assert_eq!(guards, 4);
    assert_eq!(delays, [2, 5, 10]);
}

#[test]
fn spawn_or_wait_failure_is_not_retried() {
    let mut calls = 0;
    let result = retry(
        false,
        || Ok(()),
        || {
            calls += 1;
            Err("Cannot start wrangler".into())
        },
        |_| panic!("must not sleep"),
    );
    assert_eq!(result.unwrap_err().to_string(), "Cannot start wrangler");
    assert_eq!(calls, 1);
}

#[test]
fn source_changed_during_delay_stops_before_another_deploy() {
    let changed = std::cell::Cell::new(false);
    let mut calls = 0;
    let result = retry(
        false,
        || {
            if changed.get() {
                Err("Captured deploy source changed".into())
            } else {
                Ok(())
            }
        },
        || {
            calls += 1;
            failed(TRANSIENT)
        },
        |_| changed.set(true),
    );
    assert_eq!(
        result.unwrap_err().to_string(),
        "Captured deploy source changed"
    );
    assert_eq!(calls, 1);
}

#[test]
fn initial_source_failure_never_starts_wrangler() {
    let result = retry(
        false,
        || Err("source changed".into()),
        || panic!("must not start"),
        |_| panic!("must not sleep"),
    );
    assert_eq!(result.unwrap_err().to_string(), "source changed");
}

#[test]
fn successful_deploy_does_not_retry_stale_error_text() {
    let result = retry(
        false,
        || Ok(()),
        || {
            let mut out = failed(TRANSIENT)?;
            out.success = true;
            Ok(out)
        },
        |_| panic!("must not sleep"),
    );
    assert!(result.is_ok());
}

#[test]
fn transient_in_stdout_is_recognized_too() {
    let mut calls = 0;
    let result = retry(
        false,
        || Ok(()),
        || {
            calls += 1;
            if calls == 1 {
                let mut out = failed(TRANSIENT)?;
                std::mem::swap(&mut out.stdout, &mut out.stderr);
                Ok(out)
            } else {
                success()
            }
        },
        |_| {},
    );
    assert!(result.is_ok());
    assert_eq!(calls, 2);
}

#[test]
fn non_deploy_operations_cannot_enter_retry_adapter() {
    for command in ["secret", "d1", "delete", "versions"] {
        let result = run("unused", &[command], "unused", false);
        assert_eq!(
            result.unwrap_err().to_string(),
            "Deploy retry adapter only accepts wrangler deploy"
        );
    }
}

#[test]
fn tee_preserves_raw_bytes_and_visible_output() {
    let input = b"progress\n\xff\x1b[31merror\x1b[0m";
    let mut output = Vec::new();
    assert_eq!(tee(input.as_slice(), &mut output).unwrap(), input);
    assert_eq!(output, input);
}

#[test]
fn a_different_failure_on_retry_stops_and_reports_that_failure() {
    let mut calls = 0;
    let mut delays = Vec::new();
    let result = retry(
        false,
        || Ok(()),
        || {
            calls += 1;
            if calls == 1 {
                failed(TRANSIENT)
            } else {
                let mut out = failed("Invalid binding [code: 10021]")?;
                out.failure = "second deploy failed".into();
                Ok(out)
            }
        },
        |delay| delays.push(delay.as_secs()),
    );
    assert_eq!(result.unwrap_err().to_string(), "second deploy failed");
    assert_eq!(calls, 2);
    assert_eq!(delays, [2]);
}
