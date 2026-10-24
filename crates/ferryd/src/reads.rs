//! What the read endpoints serve (`GET /api/status`, `/api/swaps`, `/api/swaps/:id`, the start of
//! `/api/events`, `GET /peer/offer`): the views as last published, so a read never waits for a
//! daemon round, which holds the swaps' state across node calls (with a slow node, for minutes).
//! Swaps are published after every round's deadline pass, after each swap's slow work, and after
//! every request that changes one, so a read is at most a few seconds behind. Anything that
//! decides (a funds check, the cap, a deadline) still reads the state itself.

use std::collections::BTreeMap;
use std::sync::RwLock;

pub struct Reads<S> {
    inner: RwLock<Inner<S>>,
}

struct Inner<S> {
    status: Option<S>,
    /// Swap views as JSON, by id.
    swaps: BTreeMap<String, String>,
    /// As maker: how many more swaps we take now (crate::capacity).
    free_slots: Option<u32>,
}

impl<S> Default for Reads<S> {
    fn default() -> Self {
        Reads {
            inner: RwLock::new(Inner {
                status: None,
                swaps: BTreeMap::new(),
                free_slots: None,
            }),
        }
    }
}

impl<S: Clone> Reads<S> {
    pub fn status(&self) -> Option<S> {
        self.inner.read().expect("not poisoned").status.clone()
    }

    pub fn set_status(&self, status: S) {
        self.inner.write().expect("not poisoned").status = Some(status);
    }

    /// One swap's view, as JSON.
    pub fn swap(&self, id: &str) -> Option<String> {
        self.inner
            .read()
            .expect("not poisoned")
            .swaps
            .get(id)
            .cloned()
    }

    /// Every swap's view, as JSON, in id order.
    pub fn swaps(&self) -> Vec<String> {
        self.inner
            .read()
            .expect("not poisoned")
            .swaps
            .values()
            .cloned()
            .collect()
    }

    /// Every swap's view, as one JSON array, in id order.
    pub fn swaps_json(&self) -> String {
        format!("[{}]", self.swaps().join(","))
    }

    pub fn set_swap(&self, id: &str, json: String) {
        self.inner
            .write()
            .expect("not poisoned")
            .swaps
            .insert(id.to_string(), json);
    }

    pub fn free_slots(&self) -> Option<u32> {
        self.inner.read().expect("not poisoned").free_slots
    }

    pub fn set_free_slots(&self, n: u32) {
        self.inner.write().expect("not poisoned").free_slots = Some(n);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_keep_the_last_published_views() {
        let r: Reads<u8> = Reads::default();
        assert_eq!(
            (r.status(), r.swap("a"), r.free_slots()),
            (None, None, None)
        );
        assert_eq!(r.swaps_json(), "[]");
        r.set_status(7);
        r.set_swap("b", r#"{"id":"b"}"#.into());
        r.set_swap("a", r#"{"id":"a"}"#.into());
        r.set_swap("b", r#"{"id":"b","x":1}"#.into());
        r.set_free_slots(3);
        assert_eq!(r.status(), Some(7));
        assert_eq!(r.swaps_json(), r#"[{"id":"a"},{"id":"b","x":1}]"#);
        assert_eq!(r.swap("b").as_deref(), Some(r#"{"id":"b","x":1}"#));
        assert_eq!(r.free_slots(), Some(3));
    }
}
