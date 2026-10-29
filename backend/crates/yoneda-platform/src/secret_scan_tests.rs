//! Every token here is assembled at runtime from split prefixes and generated bodies, so
//! this source never holds anything shaped like a real credential.
use super::*;

/// `n` characters cycling through `alphabet` (mixed case and digits by default).
fn body(n: usize) -> String {
    cycle(n, "aB3dE5gH7jK9mN1pQ")
}
fn cycle(n: usize, alphabet: &str) -> String {
    alphabet.chars().cycle().take(n).collect()
}
fn token(prefix: &[&str], n: usize) -> String {
    prefix.concat() + &body(n)
}

fn rule(text: &str) -> Option<&'static str> {
    find(text.as_bytes(), &|_| false).map(|(rule, _)| rule)
}

fn shapes() -> Vec<(&'static str, String)> {
    let aws_id = ["AK", "IA"].concat() + &cycle(16, "Q7R2S9T4U6V8W3X5");
    let aws_secret = cycle(40, "wJalrXUtnF3MI/K7MDENG+bPxRfiCY9z");
    let pem = ["-----BEGIN ", "RSA PRIVATE", " KEY-----\n"].concat()
        + &cycle(64, "MIIEowIBAAKCAQEA7x")
        + "\n";
    vec![
        ("github-token", token(&["gh", "p_"], 36)),
        ("github-token", token(&["gh", "s_"], 36)),
        ("github-pat", token(&["github", "_pat_"], 82)),
        ("anthropic-key", token(&["sk-", "ant-api03-"], 93)),
        ("openai-key", token(&["sk-", "proj-"], 64)),
        ("openai-key", token(&["sk", "-"], 48)),
        (
            "slack-token",
            ["xo", "xb-"].concat() + "1234567890-1234567890123-" + &body(24),
        ),
        ("stripe-live-key", token(&["sk", "_live_"], 24)),
        ("private-key", pem),
        ("yonedarepo-token", token(&["yr", "p_"], 43)),
        ("yonedarepo-pat", token(&["yp", "at_"], 43)),
        ("mimo-key", token(&["t", "p-"], 48)),
        (
            "aws-access-key",
            format!("aws_access_key_id = {aws_id}\naws_secret_access_key = {aws_secret}\n"),
        ),
    ]
}

#[test]
fn finds_each_token_shape_in_context() {
    for (expected, secret) in shapes() {
        let text = format!("const config = {{\n  key: \"{secret}\",\n}};\n");
        assert_eq!(rule(&text), Some(expected), "{expected}");
        let refused = scan("src/config.ts", text.as_bytes(), &[]).unwrap_err();
        assert_eq!(refused.code, "SECRET_DETECTED");
        assert!(refused.message.contains("src/config.ts"));
        assert!(refused.message.contains("line 2"), "{}", refused.message);
        assert!(refused.message.contains(expected));
        // The refusal never repeats the secret, nor a fragment long enough to use.
        assert!(!refused.message.contains(&secret[secret.len() - 12..]));
    }
}

#[test]
fn prefixes_and_lookalikes_are_not_secrets() {
    let aws_id = ["AK", "IA"].concat() + &cycle(16, "Q7R2S9T4U6V8W3X5");
    let examples = [
        // Prefixes alone, short bodies, or a token shape inside a longer word.
        "Tokens start with ghp_ or github_pat_; keys with sk-ant- or sk-proj-.".to_owned(),
        token(&["gh", "p_"], 20),
        token(&["gh", "p_"], 40),
        format!("x{}", token(&["gh", "p_"], 36)),
        "let task-scheduler = desk-lamp; the sk-learn docs".to_owned(),
        token(&["sk", "-"], 20),
        format!("sk-{}", cycle(40, "abcdefgh")),
        token(&["yr", "p_"], 10),
        // Lockfile checksums and content hashes.
        format!("checksum = \"{}\"", cycle(64, "0123456789abcdef")),
        // A PEM header in prose, without key material.
        ["Look for -----BEGIN ", "PRIVATE KEY----- in the file."].concat(),
        ["-----BEGIN ", "PUBLIC KEY-----\n"].concat() + &cycle(64, "MIIBIjANBgkqhkiG9w0B"),
        // An AWS key id alone, or AWS's documented example pair.
        format!("aws_access_key_id = {aws_id}\n"),
        format!(
            "{}\n{}\n",
            ["AK", "IAIOSFODNN7", "EXAMPLE"].concat(),
            cycle(40, "wJalrXUtnF3MI/K7MDENG+bPxRfiCY9z")
        ),
    ];
    for text in examples {
        assert_eq!(rule(&text), None, "{text}");
    }
}

#[test]
fn the_owner_allows_a_rule_for_a_file_or_directory() {
    let text = token(&["sk", "_live_"], 24);
    let allow = |path: &str, rule: &str| SecretAllow {
        path: path.into(),
        rule: rule.into(),
    };
    for allowed in [
        allow("fixtures/stripe.json", "stripe-live-key"),
        allow("fixtures/", "stripe-live-key"),
    ] {
        assert!(scan("fixtures/stripe.json", text.as_bytes(), &[allowed]).is_ok());
    }
    for other in [
        allow("fixtures/stripe.json", "github-token"),
        allow("fixtures/other.json", "stripe-live-key"),
        allow("fixtures", "stripe-live-key"),
    ] {
        assert!(scan("fixtures/stripe.json", text.as_bytes(), &[other]).is_err());
    }
    // An allowed match does not hide a different secret later in the same file.
    let both = format!("{text}\n{}\n", token(&["gh", "p_"], 36));
    let refused = scan(
        "fixtures/stripe.json",
        both.as_bytes(),
        &[allow("fixtures/", "stripe-live-key")],
    )
    .unwrap_err();
    assert!(refused.message.contains("github-token") && refused.message.contains("line 2"));
}

#[test]
fn allow_entries_name_known_rules() {
    assert!(
        validate_allow(&[SecretAllow {
            path: "a/".into(),
            rule: "github-token".into()
        }])
        .is_ok()
    );
    for (path, rule) in [
        ("a", "nope"),
        ("", "github-token"),
        ("/abs", "github-token"),
    ] {
        let entry = SecretAllow {
            path: path.into(),
            rule: rule.into(),
        };
        assert!(validate_allow(&[entry]).is_err(), "{path} {rule}");
    }
}

#[test]
fn scans_a_mebibyte_quickly() {
    let line = "    let value = compute(alpha, beta) + gamma * delta; // sk- ghp_ AKIA -----\n";
    let text = line.repeat(1024 * 1024 / line.len() + 1);
    let started = std::time::Instant::now();
    assert!(scan("big.rs", text.as_bytes(), &[]).is_ok());
    let elapsed = started.elapsed();
    // Debug builds are several times slower than the release Wasm that commits run in.
    assert!(elapsed.as_millis() < 250, "{elapsed:?}");
    eprintln!("scanned {} bytes in {elapsed:?}", text.len());
    // Adversarial content stays linear: a file of AWS key ids, or of token prefixes.
    let id = ["AK", "IA"].concat() + &cycle(16, "Q7R2S9T4U6V8W3X5") + " ";
    for unit in [id, "sk-ghp_xoxb-yrp_ ".to_owned()] {
        let text = unit.repeat(1024 * 1024 / unit.len() + 1);
        let started = std::time::Instant::now();
        assert!(scan("big.txt", text.as_bytes(), &[]).is_ok());
        assert!(
            started.elapsed().as_millis() < 250,
            "{:?}",
            started.elapsed()
        );
    }
}

#[test]
fn redacts_every_credential_whole_and_keeps_the_rest() {
    for (expected, secret) in shapes() {
        let text = format!("before {secret} after\n{secret}");
        let (clean, rules) = redact(&text);
        assert_eq!(rules, [expected, expected], "{expected}");
        assert!(
            scan("t", clean.as_bytes(), &[]).is_ok(),
            "{expected}: {clean}"
        );
        assert!(clean.starts_with("before ") && clean.contains(&format!("[REDACTED:{expected}]")));
        // No fragment of the credential's body survives (AWS: neither the id nor the secret).
        let tail = secret.trim_end();
        assert!(
            !clean.contains(&tail[tail.len() - 12..]),
            "{expected}: {clean}"
        );
        assert!(
            clean.trim_end().ends_with(']')
                || expected == "private-key"
                || expected == "aws-access-key",
            "{expected}: {clean}"
        );
    }
    // A PEM block goes from its header through its footer.
    let pem = ["-----BEGIN ", "EC PRIVATE", " KEY-----\n"].concat()
        + &cycle(64, "MHcCAQEEIAbc0123")
        + "\n"
        + &["-----END ", "EC PRIVATE", " KEY-----"].concat();
    let (clean, rules) = redact(&format!("key:\n{pem}\nnext line"));
    assert_eq!(rules, ["private-key"]);
    assert_eq!(clean, "key:\n[REDACTED:private-key]\nnext line");
    // Text without credentials comes back as it was.
    let plain = "sk-ant- in prose, ghp_short, AKIAEXAMPLE and é";
    assert_eq!(redact(plain), (plain.to_owned(), vec![]));
}

#[test]
fn a_streamed_file_is_scanned_across_pieces_and_judged_by_path() {
    let secret = token(&["gh", "p_"], 36);
    let text = format!(
        "{}line two holds {secret} here\n{}",
        "x\n".repeat(5000),
        "y\n".repeat(5000)
    );
    let bytes = text.as_bytes();
    let line = 5001;
    for piece in [1, 7, 4096, 65_536, bytes.len()] {
        let mut scan = StreamScan::default();
        for part in bytes.chunks(piece) {
            scan.feed(part);
        }
        let hits = scan.finish();
        assert_eq!(hits, vec![("github-token", line)], "pieces of {piece}");
        let refused = refuse("big.txt", &hits, &[]).unwrap_err();
        assert!(
            refused
                .message
                .starts_with(&format!("big.txt line {line} "))
        );
        let allow = [SecretAllow {
            path: "big.txt".into(),
            rule: "github-token".into(),
        }];
        assert!(refuse("big.txt", &hits, &allow).is_ok());
        assert!(refuse("other.txt", &hits, &allow).is_err());
    }
    let mut clean = StreamScan::default();
    clean.feed(&"plain text\n".repeat(1000).into_bytes());
    assert!(clean.finish().is_empty());
}
