//! Webhook targets (SSRF): only `https` URLs naming a public host. IP literals in private,
//! loopback, link-local, shared, reserved or multicast ranges are refused, as are IPv6
//! literals, local-only names (`localhost`, `.local`, `.internal`, `.arpa`), numeric
//! spellings of addresses, credentials in the URL and this account's own `workers.dev`
//! Workers. A Worker's fetch cannot reach private networks anyway; DNS answers are therefore
//! not re-checked here.
use std::net::Ipv4Addr;
use yoneda_core::{Error, Result};

const MAX_URL: usize = 2048;

fn refused(why: &str) -> Error {
    Error::new("INVALID_INPUT", format!("Hook URL refused: {why}"))
}

/// The URL as stored (host lowercased), or why it is refused. `account_subdomain` is this
/// account's `workers.dev` subdomain; without it every `workers.dev` host is refused.
pub fn validate(url: &str, account_subdomain: Option<&str>) -> Result<String> {
    if url.len() > MAX_URL || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(refused("too long or contains whitespace"));
    }
    let rest = url
        .get(..8)
        .filter(|scheme| scheme.eq_ignore_ascii_case("https://"))
        .map(|_| &url[8..])
        .ok_or_else(|| refused("only https URLs are allowed"))?;
    if rest.contains('#') {
        return Err(refused("fragments are not allowed"));
    }
    let end = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, path) = rest.split_at(end);
    if authority.contains('@') {
        return Err(refused("credentials are not allowed in the URL"));
    }
    if authority.starts_with('[') {
        return Err(refused("IPv6 literals are not allowed; use a hostname"));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => {
            let valid = port.len() <= 5
                && port.bytes().all(|b| b.is_ascii_digit())
                && port.parse::<u16>().is_ok_and(|p| p > 0);
            if !valid {
                return Err(refused("invalid port"));
            }
            (host, Some(port))
        }
        None => (authority, None),
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    public_host(&host, account_subdomain)?;
    let port = port.map(|p| format!(":{p}")).unwrap_or_default();
    Ok(format!("https://{host}{port}{path}"))
}

fn public_host(host: &str, account_subdomain: Option<&str>) -> Result<()> {
    let labels: Vec<&str> = host.split('.').collect();
    let label_ok = |l: &&str| {
        (1..=63).contains(&l.len())
            && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !l.starts_with('-')
            && !l.ends_with('-')
    };
    if host.is_empty() || host.len() > 253 || !labels.iter().all(label_ok) {
        return Err(refused("invalid host"));
    }
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return if public_ipv4(ip) {
            Ok(())
        } else {
            Err(refused("private, loopback, link-local or reserved address"))
        };
    }
    // A real name ends in an alphabetic (or IDNA) top-level label; this also refuses the
    // numeric spellings of addresses (`2130706433`, `0x7f.1`).
    let tld = labels[labels.len() - 1];
    let alphabetic = tld.len() >= 2 && tld.bytes().all(|b| b.is_ascii_lowercase());
    if labels.len() < 2 || !(alphabetic || tld.starts_with("xn--")) {
        return Err(refused("the host must be a public domain name"));
    }
    if matches!(
        tld,
        "localhost" | "local" | "internal" | "arpa" | "test" | "invalid"
    ) {
        return Err(refused("local-only host"));
    }
    if host == "workers.dev" || host.ends_with(".workers.dev") {
        let own = account_subdomain.is_none_or(|s| {
            let s = s.to_ascii_lowercase();
            host == format!("{s}.workers.dev") || host.ends_with(&format!(".{s}.workers.dev"))
        });
        if own {
            return Err(refused("this account's own Workers cannot be hook targets"));
        }
    }
    Ok(())
}

fn public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || a == 0
        || a >= 240
        || (a == 100 && (64..128).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (18..20).contains(&b)))
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn only_public_https_hosts_are_hook_targets() {
        let own = Some("mlong-f01");
        assert_eq!(
            validate("https://CI.Example.com:8443/hooks?x=1", own).unwrap(),
            "https://ci.example.com:8443/hooks?x=1"
        );
        assert!(validate("https://8.8.8.8/x", own).is_ok());
        assert!(validate("https://other-account.workers.dev/x", own).is_ok());
        for url in [
            "http://example.com/",
            "ftp://example.com/",
            "https://user:pw@example.com/",
            "https://localhost/",
            "https://api.localhost/",
            "https://printer.local/",
            "https://metadata.internal/",
            "https://127.0.0.1/",
            "https://10.1.2.3/",
            "https://172.16.0.1/",
            "https://192.168.1.1/",
            "https://169.254.169.254/latest",
            "https://100.64.0.1/",
            "https://0.0.0.0/",
            "https://224.0.0.1/",
            "https://[::1]/",
            "https://[fe80::1]/",
            "https://2130706433/",
            "https://0x7f.0.0.1/",
            "https://example/",
            "https://example.com:0/",
            "https://example.com:99999/",
            "https://example.com/#frag",
            "https://exa mple.com/",
            "https://mlong-f01.workers.dev/",
            "https://bench.mlong-f01.workers.dev/hooks",
            "https://BENCH.MLONG-F01.workers.dev./hooks",
        ] {
            assert!(validate(url, own).is_err(), "{url}");
        }
        // Without the account's subdomain every workers.dev host is refused (fail closed).
        assert!(validate("https://other-account.workers.dev/x", None).is_err());
    }
}
