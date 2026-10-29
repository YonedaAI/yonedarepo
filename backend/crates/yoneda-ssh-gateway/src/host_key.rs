//! Host keys from the environment: an OpenSSH private key file, as is or base64-encoded on
//! one line (one-line secret stores: `base64 < ssh_host_ecdsa_key`).
//!
//! OpenSSH writes an ECDSA private scalar as an `mpint`, which drops leading zero bytes: about
//! one P-256 key in 256 stores a 31-byte scalar. ssh-key 0.7 refuses any scalar under 32 bytes
//! ("Length"), so a gateway given such a key refused its own host key at start, which takes
//! SSH down on a deploy (seen in 2 of 1,000 keys from `ssh-keygen -t ecdsa`). Such a key is
//! re-encoded with its scalar padded to the curve's size before it is parsed; nothing else
//! about it changes.
use crate::config::ConfigError;
use base64::{Engine, engine::general_purpose::STANDARD};
use russh::keys::{Algorithm, PrivateKey};

const BEGIN: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";
const END: &str = "-----END OPENSSH PRIVATE KEY-----";
const MAGIC: &[u8] = b"openssh-key-v1\0";

/// The host key `name` holds (`text`: a key file or base64 of one), of an `expected`
/// algorithm and unencrypted. Errors never echo the key.
pub fn parse(
    name: &'static str,
    text: &str,
    expected: impl Fn(&Algorithm) -> bool,
) -> Result<PrivateKey, ConfigError> {
    let decoded;
    let pem = match text.trim() {
        armored if armored.starts_with("-----BEGIN") => armored,
        encoded => {
            decoded = STANDARD
                .decode(encoded)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .ok_or_else(|| {
                    ConfigError::Invalid(name, "neither a key file nor base64 of one".into())
                })?;
            decoded.trim()
        }
    };
    let key = PrivateKey::from_openssh(pem)
        .or_else(|first| {
            padded_ecdsa_scalar(pem)
                .and_then(|fixed| PrivateKey::from_openssh(fixed).ok())
                .ok_or(first)
        })
        .map_err(|_| ConfigError::Invalid(name, "not an OpenSSH private key".into()))?;
    if key.is_encrypted() || !expected(&key.algorithm()) {
        return Err(ConfigError::Invalid(
            name,
            "wrong algorithm, or passphrase-protected".into(),
        ));
    }
    Ok(key)
}

/// Reads SSH wire strings (`u32` length, then bytes) from a byte slice.
struct Wire<'a>(&'a [u8]);

impl<'a> Wire<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let (head, rest) = (self.0.get(..n)?, self.0.get(n..)?);
        self.0 = rest;
        Some(head)
    }
    fn u32(&mut self) -> Option<u32> {
        self.take(4)
            .and_then(|b| b.try_into().ok())
            .map(u32::from_be_bytes)
    }
    fn string(&mut self) -> Option<&'a [u8]> {
        let n = usize::try_from(self.u32()?).ok()?;
        self.take(n)
    }
}

fn put(out: &mut Vec<u8>, field: &[u8]) -> Option<()> {
    out.extend_from_slice(&u32::try_from(field.len()).ok()?.to_be_bytes());
    out.extend_from_slice(field);
    Some(())
}

/// `pem` re-encoded with its ECDSA private scalar padded to the curve size, when it is an
/// unencrypted single ECDSA key whose scalar OpenSSH wrote shorter; `None` otherwise.
fn padded_ecdsa_scalar(pem: &str) -> Option<String> {
    let body: String = pem
        .strip_prefix(BEGIN)?
        .trim()
        .strip_suffix(END)?
        .split_whitespace()
        .collect();
    let blob = STANDARD.decode(body).ok()?;
    let mut wire = Wire(blob.strip_prefix(MAGIC)?);
    let (cipher, kdf, options) = (wire.string()?, wire.string()?, wire.string()?);
    if cipher != b"none" || wire.u32()? != 1 {
        return None;
    }
    let public = wire.string()?;
    let mut private = Wire(wire.string()?);
    let checks = private.take(8)?;
    let (kind, curve, point) = (private.string()?, private.string()?, private.string()?);
    let size = match curve {
        b"nistp256" => 32,
        b"nistp384" => 48,
        b"nistp521" => 66,
        _ => return None,
    };
    let scalar = private.string()?;
    if !kind.starts_with(b"ecdsa-sha2-") || scalar.is_empty() || scalar.len() >= size {
        return None;
    }
    let comment = private.string()?;
    let mut padded = vec![0u8; size - scalar.len()];
    padded.extend_from_slice(scalar);
    let mut block = checks.to_vec();
    for field in [kind, curve, point, &padded[..], comment] {
        put(&mut block, field)?;
    }
    // Unencrypted blocks pad to 8 bytes with 1, 2, 3, ...
    for pad in 1u8..=8 {
        if block.len() % 8 == 0 {
            break;
        }
        block.push(pad);
    }
    let mut out = MAGIC.to_vec();
    for field in [cipher, kdf, options] {
        put(&mut out, field)?;
    }
    out.extend_from_slice(&1u32.to_be_bytes());
    put(&mut out, public)?;
    put(&mut out, &block)?;
    let encoded = STANDARD.encode(out);
    let lines: Vec<&str> = encoded
        .as_bytes()
        .chunks(70)
        .filter_map(|c| std::str::from_utf8(c).ok())
        .collect();
    Some(format!("{BEGIN}\n{}\n{END}\n", lines.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::LineEnding;
    use russh::keys::ssh_key::private::{EcdsaKeypair, KeypairData};

    /// A synthetic P-256 key (fixed scalar, not a real key) whose scalar starts with a zero
    /// byte, written the way OpenSSH writes it: the scalar's mpint without that byte (31).
    fn openssh_short_scalar_key() -> (String, [u8; 32]) {
        let mut scalar = [0x5au8; 32];
        scalar[0] = 0;
        scalar[1] = 0x76;
        let secret = p256::SecretKey::from_bytes(&scalar.into())
            .unwrap_or_else(|_| unreachable!("a valid scalar"));
        let pair = EcdsaKeypair::NistP256 {
            public: secret.public_key().into(),
            private: secret.into(),
        };
        let key = PrivateKey::new(KeypairData::Ecdsa(pair), "")
            .unwrap_or_else(|_| unreachable!("a valid key"));
        let full = key
            .to_openssh(LineEnding::LF)
            .unwrap_or_else(|_| unreachable!("encodable"))
            .to_string();
        // ssh-key writes the 32-byte scalar; rewrite it as OpenSSH does (31 bytes, re-padded).
        let body: String = full
            .trim()
            .strip_prefix(BEGIN)
            .and_then(|b| b.strip_suffix(END))
            .unwrap_or_default()
            .split_whitespace()
            .collect();
        let blob = STANDARD.decode(body).unwrap_or_default();
        let mut wire = Wire(&blob[MAGIC.len()..]);
        let fields: Vec<&[u8]> = (0..3).filter_map(|_| wire.string()).collect();
        wire.u32();
        let public = wire.string().unwrap_or_default();
        let mut private = Wire(wire.string().unwrap_or_default());
        let checks = private.take(8).unwrap_or_default();
        let (kind, curve, point) = (
            private.string().unwrap_or_default(),
            private.string().unwrap_or_default(),
            private.string().unwrap_or_default(),
        );
        let stored = private.string().unwrap_or_default();
        assert_eq!(stored.len(), 32, "ssh-key stores the full scalar");
        let comment = private.string().unwrap_or_default();
        let mut block = checks.to_vec();
        for field in [kind, curve, point, &stored[1..], comment] {
            put(&mut block, field);
        }
        let mut pad = 1u8;
        while block.len() % 8 != 0 {
            block.push(pad);
            pad += 1;
        }
        let mut out = MAGIC.to_vec();
        for field in fields {
            put(&mut out, field);
        }
        out.extend_from_slice(&1u32.to_be_bytes());
        put(&mut out, public);
        put(&mut out, &block);
        let encoded = STANDARD.encode(out);
        let lines: Vec<&str> = encoded
            .as_bytes()
            .chunks(70)
            .filter_map(|c| std::str::from_utf8(c).ok())
            .collect();
        (format!("{BEGIN}\n{}\n{END}\n", lines.join("\n")), scalar)
    }

    #[test]
    fn an_ecdsa_key_whose_scalar_openssh_shortened_still_loads() {
        let (pem, scalar) = openssh_short_scalar_key();
        // The shape ssh-key alone refuses (the gateway's start failure).
        assert!(PrivateKey::from_openssh(&pem).is_err());
        // Loaded as a file and as the deploy's base64 of one, with the same scalar.
        let ecdsa = |a: &Algorithm| matches!(a, Algorithm::Ecdsa { .. });
        for text in [pem.clone(), STANDARD.encode(&pem)] {
            let key = parse("SSH_HOST_ECDSA_KEY", &text, ecdsa)
                .unwrap_or_else(|_| unreachable!("the key loads"));
            let KeypairData::Ecdsa(EcdsaKeypair::NistP256 { private, .. }) = key.key_data() else {
                unreachable!("a P-256 key");
            };
            assert_eq!(private.as_slice(), &scalar);
        }
    }

    #[test]
    fn other_keys_are_left_as_they_are() {
        let ecdsa = |a: &Algorithm| matches!(a, Algorithm::Ecdsa { .. });
        assert!(padded_ecdsa_scalar("not a key").is_none());
        assert!(parse("SSH_HOST_ECDSA_KEY", "bm90IGEga2V5", ecdsa).is_err());
        let ed = PrivateKey::from(russh::keys::ssh_key::private::Ed25519Keypair::from_seed(
            &[7; 32],
        ))
        .to_openssh(LineEnding::LF)
        .unwrap_or_else(|_| unreachable!("encodable"))
        .to_string();
        assert!(padded_ecdsa_scalar(&ed).is_none());
        assert!(parse("SSH_HOST_ED25519_KEY", &ed, |a| *a == Algorithm::Ed25519).is_ok());
    }
}
