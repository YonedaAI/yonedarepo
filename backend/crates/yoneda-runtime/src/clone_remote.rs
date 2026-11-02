//! What a clone may reach. Its instance is the one kind of check container with the internet
//! (`cloneRepository` in repo-clone.ts), so the address is held to a rule here as
//! well as by the Worker: https, a public host, nothing that could be taken for an option. A
//! name is resolved first and every answer held to the same rule, and Git follows no redirect
//! (`clone_git`), so a public name can not lead to the instance's own network.
use crate::check_runner::invalid;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use yoneda_core::Result;

const SCHEME: &str = "https://";
/// Names that only ever mean something on a private network.
const PRIVATE_SUFFIXES: [&str; 3] = [".internal", ".local", ".localhost"];

/// The host of a remote address the instance may reach, or why not.
pub(crate) fn check_url(url: &str) -> Result<String> {
    let refused = || invalid("A remote must be a public https address");
    let rest = url.strip_prefix(SCHEME).ok_or_else(refused)?;
    let (host, path) = rest.split_once('/').ok_or_else(refused)?;
    let plain = |c: char| c.is_ascii_alphanumeric() || "-._/".contains(c);
    if host.is_empty() || !path.chars().all(plain) {
        return Err(refused());
    }
    let host = host.to_ascii_lowercase();
    // A bare IP is held to the address rule; anything else must read as a name. A name made of
    // numbers alone is an address some resolvers would take in another spelling.
    if let Some(ip) = literal(&host) {
        return if refused_address(ip) {
            Err(refused())
        } else {
            Ok(host)
        };
    }
    let name = host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-.".contains(c));
    let dotted = host.contains('.');
    let numeric = host.rsplit('.').next().is_none_or(looks_numeric);
    let private = host == "localhost" || PRIVATE_SUFFIXES.iter().any(|s| host.ends_with(s));
    if !name || !dotted || numeric || private {
        return Err(refused());
    }
    Ok(host)
}

/// `host` as an address, bracketed or not.
fn literal(host: &str) -> Option<IpAddr> {
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
        .parse()
        .ok()
}

/// Whether a host's last label is a number: a public name's never is.
fn looks_numeric(label: &str) -> bool {
    label.chars().all(|c| c.is_ascii_digit()) || label.starts_with("0x")
}

/// Whether an address is one a clone must not reach.
pub(crate) fn refused_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => refused_v4(ip),
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map_or_else(|| refused_v6(ip), refused_v4),
    }
}

fn refused_v4(ip: Ipv4Addr) -> bool {
    let [first, second, ..] = ip.octets();
    let shared = first == 100 && (64..128).contains(&second);
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || shared
}

fn refused_v6(ip: Ipv6Addr) -> bool {
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
}

/// Refuses a host any of whose addresses is one a clone must not reach.
pub(crate) async fn check_resolved(host: &str) -> Result<()> {
    let found = tokio::net::lookup_host((host.trim_matches(['[', ']']), 443))
        .await
        .map_err(|e| invalid(format!("Cannot resolve {host}: {e}")))?;
    let mut any = false;
    for address in found {
        any = true;
        if refused_address(address.ip()) {
            return Err(invalid("A remote must be a public https address"));
        }
    }
    if !any {
        return Err(invalid(format!("Cannot resolve {host}")));
    }
    Ok(())
}
