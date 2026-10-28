//! Who a connection is. The identity comes only from a key whose signature russh verified
//! (`auth_publickey`): a key merely offered, or offered earlier in the same connection,
//! never decides it (the CVE-2024-45337 class of bug). Only the user `git` is served, and a
//! lookup that fails for any reason refuses.
use crate::platform::{Identity, Platform, PlatformError};
use russh::keys::{HashAlg, PublicKey};
use std::future::Future;
use std::sync::Arc;

/// Where verified keys are looked up (the platform, or a test double).
pub trait Directory: Send + Sync + 'static {
    fn lookup(
        &self,
        fingerprint: &str,
    ) -> impl Future<Output = Result<Option<Identity>, PlatformError>> + Send;
}

impl Directory for Platform {
    fn lookup(
        &self,
        fingerprint: &str,
    ) -> impl Future<Output = Result<Option<Identity>, PlatformError>> + Send {
        Platform::lookup(self, fingerprint)
    }
}

impl<D: Directory> Directory for Arc<D> {
    fn lookup(
        &self,
        fingerprint: &str,
    ) -> impl Future<Output = Result<Option<Identity>, PlatformError>> + Send {
        D::lookup(self, fingerprint)
    }
}

/// The SSH user every client connects as (`git@host`).
pub const USER: &str = "git";

/// `SHA256:<base64>`, as `ssh-keygen -l` prints it and the platform stores it.
pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

pub struct Authenticator<D> {
    directory: D,
    identity: Option<Identity>,
}

impl<D: Directory> Authenticator<D> {
    pub fn new(directory: D) -> Self {
        Authenticator {
            directory,
            identity: None,
        }
    }

    /// A key offered without a signature: worth a signature only for user `git`. It
    /// decides nothing.
    pub fn offered(&self, user: &str) -> bool {
        user == USER
    }

    /// A key whose signature verified: the connection's identity when the platform knows it.
    pub async fn verified(&mut self, user: &str, key: &PublicKey) -> bool {
        if user != USER || self.identity.is_some() {
            return false;
        }
        let fingerprint = fingerprint(key);
        match self.directory.lookup(&fingerprint).await {
            Ok(Some(identity)) => {
                tracing::info!(account = %identity.account, key_id = %identity.key_id, %fingerprint, "ssh.authenticated");
                self.identity = Some(identity);
                true
            }
            Ok(None) => false,
            Err(e) => {
                tracing::warn!(error = %e, "ssh.lookup_failed");
                false
            }
        }
    }

    pub fn identity(&self) -> Option<&Identity> {
        self.identity.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Fake {
        known: HashMap<String, Identity>,
        asked: Mutex<Vec<String>>,
        down: bool,
    }
    impl Directory for Fake {
        fn lookup(
            &self,
            fingerprint: &str,
        ) -> impl Future<Output = Result<Option<Identity>, PlatformError>> + Send {
            self.asked.lock().unwrap().push(fingerprint.to_owned());
            let answer = if self.down {
                Err(PlatformError::Refused {
                    status: 503,
                    message: "down".into(),
                })
            } else {
                Ok(self.known.get(fingerprint).cloned())
            };
            async move { answer }
        }
    }

    /// Distinct test keys (public halves only).
    const KEYS: [&str; 3] = [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPABZXfg3RaL8nBzQXBqjmhNRoourGMePyLCIP1iMDqH",
        "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBLsUCMLZxezVKY0se9x00MY5l5i9wk6Lee8mWXzj/N2IgwcI4tpUDnRZmGMGmAB1IFLCf0vnBiGU/mZRGxn10KA=",
        "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDAuGDSee/mFhh398iBiTOQTUTd97iYPv0M5tva2II+o5ozgmyHAo1l8AOOfoDJ2APjYOjf28VslO0k16oTD4RF4XY8rZ5O0mMNag8SFoy99QdDLfdi9cCzwSnbNDFyO3Xp4JOzYJw8TDFepyEyrvvYqjBhc0i+d5NP4PIeOC2sPOO68Df45Veu4Kwhr6p/5tTIX2WV51Tt+m8KgSkrBVPtg/V+vaq1KtE4j7Q29LMXiW1zdOwP+WEQpzpQd8SZeRKVYMPK2OYaRDfvzfzUnJc6N3AJ0y8mHs3/ImJgaHdX6VvY1j6nTv/xOy7orcN7OKAc9FWC74VyejR0zfG3gVzR",
    ];
    fn keys() -> [PublicKey; 3] {
        KEYS.map(|k| PublicKey::from_openssh(k).unwrap())
    }
    fn identity(account: &str, key: &PublicKey) -> Identity {
        Identity {
            account: account.into(),
            key_id: format!("ssh_{account:0>16}"),
            fingerprint: fingerprint(key),
        }
    }
    fn directory(known: &[(&str, &PublicKey)]) -> Fake {
        Fake {
            known: known
                .iter()
                .map(|(account, key)| (fingerprint(key), identity(account, key)))
                .collect(),
            ..Fake::default()
        }
    }

    #[tokio::test]
    async fn identity_is_the_key_that_signed_not_one_offered_before_it() {
        let [alice, mallory, _] = keys();
        // Alice's key is known; the client offers it, then signs with another key.
        let mut auth = Authenticator::new(directory(&[("alice", &alice)]));
        assert!(auth.offered(USER));
        assert!(!auth.verified(USER, &mallory).await);
        assert_eq!(auth.identity(), None);
        assert_eq!(
            *auth.directory.asked.lock().unwrap(),
            vec![fingerprint(&mallory)]
        );
    }

    #[tokio::test]
    async fn a_client_with_two_keys_is_the_first_known_key_that_signs() {
        let [unknown, bob, carol] = keys();
        let mut auth = Authenticator::new(directory(&[("bob", &bob)]));
        assert!(auth.offered(USER) && auth.offered(USER));
        assert!(!auth.verified(USER, &unknown).await);
        assert!(auth.verified(USER, &bob).await);
        assert_eq!(auth.identity().unwrap().account, "bob");
        // Once decided, a later signature cannot change it.
        let mut both = Authenticator::new(directory(&[("bob", &bob), ("carol", &carol)]));
        assert!(both.verified(USER, &bob).await);
        assert!(!both.verified(USER, &carol).await);
        assert_eq!(both.identity().unwrap().account, "bob");
    }

    #[tokio::test]
    async fn other_users_and_lookup_failures_refuse() {
        let [bob, ..] = keys();
        let mut auth = Authenticator::new(directory(&[("bob", &bob)]));
        assert!(!auth.offered("root"));
        assert!(!auth.verified("root", &bob).await);
        assert!(auth.directory.asked.lock().unwrap().is_empty());
        let mut down = Authenticator::new(Fake {
            down: true,
            ..directory(&[("bob", &bob)])
        });
        assert!(!down.verified(USER, &bob).await);
        assert_eq!(down.identity(), None);
    }
}
