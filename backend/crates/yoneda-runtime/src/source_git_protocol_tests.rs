use crate::source_git_protocol::{advertisement_head, command_prefix, successful_report};
fn pkt(bytes: &[u8]) -> Vec<u8> {
    let mut result = format!("{:04x}", bytes.len() + 4).into_bytes();
    result.extend(bytes);
    result
}

#[test]
fn discovery_requires_exact_main_sha1_and_report_status_capability() {
    let id = "1".repeat(40);
    let mut bytes = pkt(b"# service=git-receive-pack\n");
    bytes.extend(b"0000");
    bytes.extend(pkt(format!(
        "{id} refs/heads/main\0report-status delete-refs object-format=sha1\n"
    )
    .as_bytes()));
    bytes.extend(b"0000");
    assert_eq!(advertisement_head(&bytes).unwrap(), id);
    for invalid in [
        bytes[..bytes.len() - 2].to_vec(),
        pkt(format!("{id} refs/heads/other\0report-status\n").as_bytes()),
        pkt(format!("{id} refs/heads/main\0report-status object-format=sha256\n").as_bytes()),
        pkt(format!("{id} refs/heads/main\0delete-refs\n").as_bytes()),
    ] {
        assert!(advertisement_head(&invalid).is_err());
    }
}

#[test]
fn request_has_frozen_old_revision_and_success_requires_real_unpack_and_ref_ack() {
    let old = "1".repeat(40);
    let new = "2".repeat(40);
    let line = format!("{old} {new} refs/heads/main\0report-status\n");
    let mut expected = pkt(line.as_bytes());
    expected.extend(b"0000");
    assert_eq!(command_prefix(&old, &new).unwrap(), expected);
    let report = [
        pkt(b"unpack ok\n"),
        pkt(b"ok refs/heads/main\n"),
        b"0000".to_vec(),
    ]
    .concat();
    assert!(successful_report(&report).is_ok());
    for invalid in [
        vec![],
        b"HTTP 200".to_vec(),
        [
            pkt(b"unpack error\n"),
            pkt(b"ok refs/heads/main\n"),
            b"0000".to_vec(),
        ]
        .concat(),
        [
            pkt(b"unpack ok\n"),
            pkt(b"ng refs/heads/main missing object\n"),
            b"0000".to_vec(),
        ]
        .concat(),
        [
            pkt(b"unpack ok\n"),
            pkt(b"ok refs/heads/other\n"),
            b"0000".to_vec(),
        ]
        .concat(),
    ] {
        assert!(successful_report(&invalid).is_err());
    }
    assert!(command_prefix(&"1".repeat(64), &new).is_err());
}
