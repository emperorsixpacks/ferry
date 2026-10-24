//! Route legs (docs/API.md, "Routes"): what `POST /api/swaps` may add when `ferry-route` starts
//! one leg of a route (coin A → shielded ZEC → coin C), and the checks both daemon types run on
//! it. The contract is `crates/ferry-route/src/legs.rs`.
//!
//! - `route`: an opaque label (`[a-z0-9/-]`, 1 to 80 characters) stored in the swap record
//!   before its first save and shown as `SwapView.route`. One label, one swap: a label already
//!   carried by a swap, or by a start still in progress, is refused with 409 and
//!   `"code": "route_label_in_use"`, so a router that re-sends a start whose answer it lost
//!   never gets a second swap.
//! - `sweep_to` (role B): the shielded address B's sweep pays instead of our own wallet,
//!   checked by the Zcash backend before the maker is contacted. Never part of the peer
//!   protocol: the maker never sees it.
//! - `max_counter` (role B) / `min_counter` (role Z): refuse to start when the maker's rate
//!   means paying more / receiving fewer counter units for `zec_zat` than this.
//!
//! An error status means no swap was created; `201 {id}` means one was.

use std::sync::Mutex;

use ferry_core::Role;
use serde::Deserialize;

use crate::daemon::ApiError;

/// What `GET /api/status` lists in `features`. The router starts a leg only on a daemon that
/// lists `route` (an older ferryd would silently ignore the fields above).
pub const FEATURES: &[&str] = &["route"];

/// The `code` of a 409 whose route label is already taken (by a swap, or a start in progress).
pub const LABEL_IN_USE: &str = "route_label_in_use";
/// [`ApiError`] carries a status and a message only; a label-in-use message starts with this.
const LABEL_IN_USE_PREFIX: &str = "Route label in use: ";

/// Longest `route` label.
pub const MAX_LABEL: usize = 80;
/// Longest `sweep_to`: unified addresses are a few hundred characters at most.
const MAX_ADDRESS: usize = 512;

/// The route fields of `POST /api/swaps` (both daemon types).
#[derive(Clone, Debug, Default, Deserialize)]
pub struct RouteArgs {
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub sweep_to: Option<String>,
    #[serde(default)]
    pub max_counter: Option<u64>,
    #[serde(default)]
    pub min_counter: Option<u64>,
}

impl RouteArgs {
    /// The checks that need nothing but the request and our role (before anything else).
    pub fn check(&self, role: Role) -> Result<(), ApiError> {
        let bad = |m: String| Err(ApiError(400, m));
        if let Some(label) = &self.route {
            check_label(label).or_else(bad)?;
        }
        if let Some(to) = &self.sweep_to {
            if role != Role::B {
                return bad(
                    "sweep_to is for role B only: it says where B's sweep pays the ZEC it buys"
                        .into(),
                );
            }
            // The backend checks the address itself; this keeps anything that is not an
            // address (an option, a path, a huge string) away from it.
            if to.is_empty()
                || to.len() > MAX_ADDRESS
                || !to
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            {
                return bad(
                    "sweep_to must be a shielded address (lowercase letters and digits)".into(),
                );
            }
        }
        if self.max_counter.is_some() && role != Role::B {
            return bad(
                "max_counter is for role B only (the most it pays); role Z sets min_counter".into(),
            );
        }
        if self.min_counter.is_some() && role != Role::Z {
            return bad(
                "min_counter is for role Z only (the least it receives); role B sets max_counter"
                    .into(),
            );
        }
        Ok(())
    }

    /// The maker's price for `zec` (in words) is `units` counter units: within our limit?
    /// `show` writes an amount of the counter coin.
    pub fn check_price(
        &self,
        role: Role,
        units: u64,
        zec: &str,
        show: impl Fn(u64) -> String,
    ) -> Result<(), ApiError> {
        match role {
            Role::B => match self.max_counter {
                Some(max) if units > max => Err(ApiError(
                    400,
                    format!(
                        "The maker asks {} for {zec}, above your limit of {} (max_counter)",
                        show(units),
                        show(max)
                    ),
                )),
                _ => Ok(()),
            },
            Role::Z => match self.min_counter {
                Some(min) if units < min => Err(ApiError(
                    400,
                    format!(
                        "The maker pays {} for {zec}, below your minimum of {} (min_counter)",
                        show(units),
                        show(min)
                    ),
                )),
                _ => Ok(()),
            },
        }
    }
}

/// `[a-z0-9/-]`, 1 to [`MAX_LABEL`] characters.
pub fn check_label(label: &str) -> Result<(), String> {
    if label.is_empty() || label.len() > MAX_LABEL {
        return Err(format!("route must be 1 to {MAX_LABEL} characters"));
    }
    if !label
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'/' || b == b'-')
    {
        return Err("route may hold only a-z, 0-9, '/' and '-'".into());
    }
    Ok(())
}

impl ApiError {
    fn label_in_use(msg: String) -> ApiError {
        ApiError(409, format!("{LABEL_IN_USE_PREFIX}{msg}"))
    }

    /// A machine-readable `code` for the error body, where callers must tell errors apart.
    pub fn code(&self) -> Option<&'static str> {
        (self.0 == 409 && self.1.starts_with(LABEL_IN_USE_PREFIX)).then_some(LABEL_IN_USE)
    }
}

/// What [`Starts::begin`] needs to know of each swap the daemon holds.
pub struct Held<'a> {
    pub id: &'a str,
    pub route: Option<&'a str>,
    pub finished: bool,
}

/// The swap a `POST /api/swaps` is starting, if any: one at a time, like the swaps themselves.
/// Starting takes a while (the maker is asked, our wallet is checked), and until the record is
/// in memory nothing else shows that a swap is on its way.
#[derive(Default)]
pub struct Starts {
    /// `Some(label)` while a start runs (`Some(None)`: one without a route label).
    slot: Mutex<Option<Option<String>>>,
}

impl Starts {
    /// Claim the slot for a start with `label`. Called with the daemon's state locked, `held`
    /// being every swap in it. 409 when the label is taken (by a swap or by the start in
    /// progress), when another start is in progress, or when a swap is running.
    pub fn begin<'s, 'a>(
        &'s self,
        label: Option<&str>,
        held: impl IntoIterator<Item = Held<'a>>,
    ) -> Result<StartGuard<'s>, ApiError> {
        let held: Vec<Held> = held.into_iter().collect();
        let mut slot = self.slot.lock().expect("not poisoned");
        if let Some(label) = label {
            if let Some(h) = held.iter().find(|h| h.route == Some(label)) {
                return Err(ApiError::label_in_use(format!(
                    "swap {} already carries the route label {label}",
                    h.id
                )));
            }
            if slot.as_ref().is_some_and(|s| s.as_deref() == Some(label)) {
                return Err(ApiError::label_in_use(format!(
                    "a swap with the route label {label} is being started"
                )));
            }
        }
        if slot.is_some() {
            return Err(ApiError(409, "Another swap is being started".into()));
        }
        if held.iter().any(|h| !h.finished) {
            return Err(ApiError(409, "A swap is already in progress".into()));
        }
        *slot = Some(label.map(str::to_string));
        Ok(StartGuard(self))
    }

    /// A start is in progress (a maker must not take a proposal meanwhile).
    pub fn busy(&self) -> bool {
        self.slot.lock().expect("not poisoned").is_some()
    }
}

/// Frees the slot when the start ends, however it ends (an error, or the request dropped).
pub struct StartGuard<'s>(&'s Starts);

impl Drop for StartGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.0.slot.lock() {
            *slot = None;
        }
    }
}

/// The timeline line of a swap started as a route leg, if it is one.
pub fn leg_note(route: Option<&str>, sweep_to: Option<&str>) -> Option<String> {
    match (route, sweep_to) {
        (None, None) => None,
        (Some(label), None) => Some(format!("Started as one leg of a route ({label})")),
        (label, Some(to)) => Some(format!(
            "{}B's sweep will pay {}, the shielded address given for this swap, instead of B's own wallet",
            label.map_or(String::new(), |l| format!("Started as one leg of a route ({l}). ")),
            short_address(to)
        )),
    }
}

/// `utest1abcdefgh…` for timelines.
pub fn short_address(a: &str) -> String {
    if a.chars().count() <= 20 {
        a.to_string()
    } else {
        format!("{}…", a.chars().take(20).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: serde_json::Value) -> RouteArgs {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn labels() {
        for ok in ["r0123456789abcdef/1", "r1/2-3", "a", &"x".repeat(80)] {
            assert_eq!(check_label(ok), Ok(()), "{ok}");
        }
        for bad in ["", "R1/1", "r1 1", "r1_1", "r1/1\n", "é", &"x".repeat(81)] {
            assert!(check_label(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn fields_belong_to_their_role() {
        let none = RouteArgs::default();
        assert!(none.check(Role::B).is_ok() && none.check(Role::Z).is_ok());
        let b = args(serde_json::json!({
            "route": "r1/1", "sweep_to": "uregtest1abc", "max_counter": 5
        }));
        assert!(b.check(Role::B).is_ok());
        let err = b.check(Role::Z).unwrap_err();
        assert_eq!(err.0, 400);
        assert!(err.1.contains("sweep_to is for role B only"), "{}", err.1);
        let z = args(serde_json::json!({"route": "r1/2", "min_counter": 5}));
        assert!(z.check(Role::Z).is_ok());
        assert!(z.check(Role::B).unwrap_err().1.contains("min_counter"));
        let max_on_z = args(serde_json::json!({"max_counter": 5}));
        assert!(max_on_z
            .check(Role::Z)
            .unwrap_err()
            .1
            .contains("max_counter"));
        assert!(args(serde_json::json!({"route": "R/1"}))
            .check(Role::B)
            .is_err());
        for bad in ["", "--help", "utest1/../x", "UTEST1ABC", &"u".repeat(513)] {
            let a = args(serde_json::json!({ "sweep_to": bad }));
            assert_eq!(a.check(Role::B).unwrap_err().0, 400, "{bad:?}");
        }
    }

    #[test]
    fn price_limits() {
        let show = |u: u64| format!("{u} sat");
        let b = args(serde_json::json!({"max_counter": 410_000}));
        assert!(b.check_price(Role::B, 410_000, "1.00 ZEC", show).is_ok());
        let err = b
            .check_price(Role::B, 410_001, "1.00 ZEC", show)
            .unwrap_err();
        assert_eq!(err.0, 400);
        assert_eq!(
            err.1,
            "The maker asks 410001 sat for 1.00 ZEC, above your limit of 410000 sat (max_counter)"
        );
        let z = args(serde_json::json!({"min_counter": 39_000_000}));
        assert!(z.check_price(Role::Z, 39_000_000, "1.00 ZEC", show).is_ok());
        assert!(z
            .check_price(Role::Z, 38_999_999, "1.00 ZEC", show)
            .unwrap_err()
            .1
            .contains("below your minimum"));
        // No limit, no refusal.
        let none = RouteArgs::default();
        assert!(none.check_price(Role::B, u64::MAX, "x", show).is_ok());
        assert!(none.check_price(Role::Z, 0, "x", show).is_ok());
    }

    fn held<'a>(id: &'a str, route: Option<&'a str>, finished: bool) -> Held<'a> {
        Held {
            id,
            route,
            finished,
        }
    }

    /// One label, one swap: a label carried by any swap (even a finished one), or by the start
    /// in progress, is a 409 with the label code; so is any other start meanwhile (plainly).
    #[test]
    fn one_start_at_a_time_and_one_swap_per_label() {
        let starts = Starts::default();
        let g = starts.begin(Some("r1/1"), []).unwrap();
        assert!(starts.busy());
        let again = starts.begin(Some("r1/1"), []).err().unwrap();
        assert_eq!((again.0, again.code()), (409, Some(LABEL_IN_USE)));
        let other = starts.begin(Some("r2/1"), []).err().unwrap();
        assert_eq!((other.0, other.code()), (409, None));
        assert!(starts.begin(None, []).is_err());
        drop(g);
        assert!(!starts.busy());

        // The swap now exists (finished or not): its label stays taken.
        for finished in [false, true] {
            let e = starts
                .begin(Some("r1/1"), [held("ab", Some("r1/1"), finished)])
                .err()
                .unwrap();
            assert_eq!(e.code(), Some(LABEL_IN_USE));
            assert!(e.1.contains("swap ab"), "{}", e.1);
        }
        // A running swap without the label: busy, not a label conflict.
        let e = starts
            .begin(Some("r1/2"), [held("ab", Some("r1/1"), false)])
            .err()
            .unwrap();
        assert_eq!((e.0, e.code()), (409, None));
        // Finished swaps with other labels are no obstacle.
        assert!(starts
            .begin(
                Some("r1/2"),
                [held("ab", Some("r1/1"), true), held("cd", None, true)]
            )
            .is_ok());
        assert!(
            !starts.busy(),
            "the guard was dropped at the end of the statement"
        );
        let e = ApiError(409, "A swap is already in progress".into());
        assert_eq!(e.code(), None);
    }
}
