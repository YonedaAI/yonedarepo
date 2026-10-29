//! In-process request coalescing: while one caller fetches an object, another caller of
//! the same client that wants it waits for that answer instead of asking the platform again.
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

/// What a fetch of one object came to: the served object, `None` when the platform lacks
/// it, or the failure (as text) of the request that was fetching it.
pub type Outcome = Result<Option<Arc<Value>>, String>;

type Slot = watch::Receiver<Option<Outcome>>;

/// Objects being fetched through one client, by key (kind, id and form).
#[derive(Default)]
pub struct Coalesce {
    inflight: Mutex<HashMap<String, Slot>>,
}

/// The keys a caller fetches itself. Each is published when finished; any left unfinished
/// when this is dropped (a failed or cancelled fetch) is released, and its waiters fail.
pub struct Lead<'a> {
    owner: &'a Coalesce,
    senders: HashMap<String, watch::Sender<Option<Outcome>>>,
}

/// A key another caller is fetching.
pub struct Wait(Slot);

impl Coalesce {
    /// Splits `keys` (duplicates ignored) into those this caller must fetch, now marked in
    /// flight, and those another caller is already fetching.
    pub fn claim(&self, keys: &[String]) -> (Lead<'_>, Vec<(String, Wait)>) {
        let mut lead = Lead {
            owner: self,
            senders: HashMap::new(),
        };
        let mut waits = Vec::new();
        // A poisoned map (a panicking caller) only costs coalescing, never correctness.
        let Ok(mut inflight) = self.inflight.lock() else {
            for key in keys {
                lead.senders
                    .entry(key.clone())
                    .or_insert_with(|| watch::channel(None).0);
            }
            return (lead, waits);
        };
        for key in keys {
            if lead.senders.contains_key(key) || waits.iter().any(|(k, _)| k == key) {
                continue;
            }
            match inflight.get(key) {
                Some(slot) => waits.push((key.clone(), Wait(slot.clone()))),
                None => {
                    let (sender, slot) = watch::channel(None);
                    inflight.insert(key.clone(), slot);
                    lead.senders.insert(key.clone(), sender);
                }
            }
        }
        (lead, waits)
    }

    fn release(&self, key: &str) {
        if let Ok(mut inflight) = self.inflight.lock() {
            inflight.remove(key);
        }
    }
}

impl Lead<'_> {
    /// The keys this caller fetches.
    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.senders.keys()
    }

    /// Publishes `key`'s outcome to its waiters; a later caller fetches it anew.
    pub fn finish(&mut self, key: &str, outcome: Outcome) {
        if let Some(sender) = self.senders.remove(key) {
            // Released first: no waiter can join after the value is sent.
            self.owner.release(key);
            if sender.receiver_count() > 0 {
                let _ = sender.send(Some(outcome));
            }
        }
    }
}

impl Drop for Lead<'_> {
    fn drop(&mut self) {
        for key in self.senders.keys() {
            self.owner.release(key);
        }
    }
}

impl Wait {
    /// The outcome the fetching caller published.
    pub async fn outcome(mut self) -> Outcome {
        match self.0.wait_for(Option::is_some).await {
            Ok(value) => value.clone().unwrap_or_else(|| Err("no outcome".into())),
            Err(_) => Err("the request fetching it was abandoned".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_second_claim_waits_for_the_first() {
        let coalesce = Coalesce::default();
        let keys = vec!["a".to_owned(), "b".to_owned(), "a".to_owned()];
        let (mut first, waits) = coalesce.claim(&keys);
        assert!(waits.is_empty());
        assert_eq!(first.keys().count(), 2);
        let (second, waits) = coalesce.claim(&["b".to_owned(), "c".to_owned()]);
        assert_eq!(second.keys().collect::<Vec<_>>(), vec!["c"]);
        assert_eq!(waits.len(), 1);
        first.finish("b", Ok(Some(Arc::new(Value::from(7)))));
        let Some((_, wait)) = waits.into_iter().next() else {
            panic!("no wait")
        };
        assert_eq!(wait.outcome().await, Ok(Some(Arc::new(Value::from(7)))));
        // Finished keys are fetched anew; a dropped lead releases what it held.
        drop(first);
        let (third, waits) = coalesce.claim(&["a".to_owned(), "b".to_owned()]);
        assert!(waits.is_empty());
        assert_eq!(third.keys().count(), 2);
    }

    #[tokio::test]
    async fn an_abandoned_fetch_fails_its_waiters() {
        let coalesce = Coalesce::default();
        let (first, _) = coalesce.claim(&["a".to_owned()]);
        let (_, waits) = coalesce.claim(&["a".to_owned()]);
        drop(first);
        for (_, wait) in waits {
            assert!(wait.outcome().await.is_err());
        }
    }
}
