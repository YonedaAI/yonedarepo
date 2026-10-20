use super::*;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
fn key(value: &str) -> Result<Vec<u8>> {
    validate_hash(value, &[64])?;
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| {
            let pair = std::str::from_utf8(c).map_err(|_| bad("Invalid source signing key"))?;
            u8::from_str_radix(pair, 16).map_err(|_| bad("Invalid source signing key"))
        })
        .collect()
}
fn signature<T: serde::Serialize>(claims: &T, domain: &str, secret: &str) -> Result<String> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(&key(secret)?).map_err(|_| bad("Invalid source signer"))?;
    let value = serde_json::to_value(claims).map_err(|_| bad("Invalid grant claims"))?;
    mac.update(domain.as_bytes());
    mac.update(yoneda_agents_core::fingerprint(&value)?.as_bytes());
    Ok(mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
fn verify<T: serde::Serialize>(claims: &T, signed: &str, domain: &str, secret: &str) -> Result<()> {
    let expected = signature(claims, domain, secret)?;
    use subtle::ConstantTimeEq;
    if expected.as_bytes().ct_eq(signed.as_bytes()).unwrap_u8() != 1 {
        return Err(Error::new("FORBIDDEN", "Source grant signature is invalid"));
    }
    Ok(())
}
pub(crate) fn sign_actor(
    binding: &SourceBinding,
    expires_at: i64,
    purpose: ActorPurpose,
    secret: &str,
) -> Result<ActorGrant> {
    binding.validate()?;
    let claims = ActorClaims {
        version: 1,
        workspace_id: binding.workspace_id.clone(),
        binding_digest: binding.digest()?,
        repo_id: binding.repo_id.clone(),
        run_id: binding.run_id.clone(),
        job_id: binding.job_id.clone(),
        epoch: binding.epoch,
        execution_id: binding.execution_id.clone(),
        view_digest: binding.view_digest.clone(),
        role: binding.role,
        access: binding.access,
        purpose,
        expires_at,
    };
    Ok(ActorGrant {
        signature: signature(&claims, "yoneda:source-grant:v1\0", secret)?,
        claims,
    })
}
pub(crate) fn sign_read_actor(
    binding: &SourceBinding,
    expires_at: i64,
    purpose: ActorPurpose,
    secret: &str,
) -> Result<ActorGrant> {
    let mut grant = sign_actor(binding, expires_at, purpose, secret)?;
    grant.claims.access = SourceAccess::ReadOnly;
    grant.signature = signature(&grant.claims, "yoneda:source-grant:v1\0", secret)?;
    Ok(grant)
}
pub(crate) fn actor(c: &Value, binding: &SourceBinding) -> Result<ActorGrant> {
    let grant: ActorGrant = decode(&c["_actor"])?;
    let secret = string(c, "_source_signing_key")?;
    verify(
        &grant.claims,
        &grant.signature,
        "yoneda:source-grant:v1\0",
        &secret,
    )?;
    let expected = if grant.claims.access == SourceAccess::ReadOnly {
        sign_read_actor(
            binding,
            grant.claims.expires_at,
            grant.claims.purpose,
            &secret,
        )?
    } else {
        sign_actor(
            binding,
            grant.claims.expires_at,
            grant.claims.purpose,
            &secret,
        )?
    };
    if grant != expected || number(c, "now")? >= grant.claims.expires_at {
        return Err(Error::new(
            "FENCED",
            "Source grant expired or differs from frozen binding",
        ));
    }
    Ok(grant)
}
pub(crate) fn sign_gc(binding: &SourceBinding, expires_at: i64, secret: &str) -> Result<GcGrant> {
    let claims = GcClaims {
        version: 1,
        workspace_id: binding.workspace_id.clone(),
        binding_digest: binding.digest()?,
        repo_id: binding.repo_id.clone(),
        expires_at,
        purpose: "gc".into(),
    };
    Ok(GcGrant {
        signature: signature(&claims, "yoneda:source-gc:v1\0", secret)?,
        claims,
    })
}
pub(super) fn gc(c: &Value, binding: &SourceBinding) -> Result<()> {
    let grant: GcGrant = decode(&c["_gc_grant"])?;
    let expected = sign_gc(
        binding,
        grant.claims.expires_at,
        &string(c, "_source_signing_key")?,
    )?;
    if grant != expected || number(c, "now")? >= grant.claims.expires_at {
        return Err(Error::new(
            "FORBIDDEN",
            "Invalid or expired source GC grant",
        ));
    }
    Ok(())
}
pub(super) fn seal(claims: SealClaims, secret: &str) -> Result<SealAttestation> {
    Ok(SealAttestation {
        signature: signature(&claims, "yoneda:source-seal:v1\0", secret)?,
        claims,
    })
}
pub(crate) fn verify_seal(
    attestation: &SealAttestation,
    binding: &SourceBinding,
    secret: &str,
) -> Result<()> {
    verify(
        &attestation.claims,
        &attestation.signature,
        "yoneda:source-seal:v1\0",
        secret,
    )?;
    let c = &attestation.claims;
    if c.version != 1
        || c.workspace_id != binding.workspace_id
        || c.binding_digest != binding.digest()?
        || c.job_id != binding.job_id
        || c.epoch != binding.epoch
    {
        return Err(Error::new("FENCED", "Seal attestation producer differs"));
    }
    Ok(())
}
pub(crate) fn sign_capture(claims: CaptureClaims, secret: &str) -> Result<CaptureGrant> {
    Ok(CaptureGrant {
        signature: signature(&claims, "yoneda:source-capture:v1\0", secret)?,
        claims,
    })
}
pub(super) fn capture(c: &Value, binding: &SourceBinding, state: &Value) -> Result<()> {
    let grant: CaptureGrant = decode(&c["_capture_grant"])?;
    let claims = &grant.claims;
    let expected = sign_capture(claims.clone(), &string(c, "_source_signing_key")?)?;
    if grant != expected
        || claims.version != 1
        || claims.purpose != "read_manifest"
        || claims.capture_epoch < 1
        || claims.expires_at <= number(c, "now")?
        || state["status"] != "sealed"
        || claims.workspace_id != binding.workspace_id
        || claims.binding_digest != binding.digest()?
        || json!(claims.seal_id) != state["seal"]["seal_id"]
        || json!(claims.checkpoint_id) != state["seal"]["checkpoint_id"]
        || json!(claims.changeset_digest) != state["seal"]["changeset_digest"]
        || c["checkpoint_id"] != claims.checkpoint_id
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Capture capability differs from sealed metadata",
        ));
    }
    validate_id(&claims.capture_job_id)?;
    Ok(())
}
