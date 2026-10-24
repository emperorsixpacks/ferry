//! Several swaps at once (docs/API.md, "Capacity"; docs/THREAT-MODEL.md, "Several swaps at
//! once"). Shared by both daemon types; the daemons supply the counts and the balances.
//!
//! - **The cap** (`--max-swaps`, `FERRY_MAX_SWAPS`): how many swaps a node runs at once, as maker
//!   or taker. Every unfinished swap counts, except a *late* one (below).
//! - **Free funds.** Every live swap reserves what it will still spend: its lock amount plus the
//!   lock's fees, until the lock is out (and on EVM, the gas of the calls still to come). A new
//!   swap, a withdrawal and the advertised liquidity use what is free: the spendable balance
//!   less those reservations (crate::withdraw::Hold). They are worked out from the swap records
//!   each time, so after a restart they are what the persisted swaps say.
//! - **Busy.** A Propose or a start the node can't take now is refused with 409 and
//!   `"code": "busy"`: the cap is reached, or the funds (or, for ZEC, the notes) a new swap
//!   needs are held by swaps in progress. The UI shows it as "partner busy".
//! - **Late swaps** (the guard against walking away). A swap whose counterparty has locked
//!   nothing by the negotiation timeout (`--negotiation-timeout-secs`) stops counting against
//!   the cap. If nothing is locked at all the swap is aborted then anyway; if we locked first (a
//!   B whose Z never locks ZEC) it only waits for its deadline and refund, its funds still
//!   held, and it no longer keeps a real user out. At most `--max-swaps` late swaps are kept on
//!   top of the cap, so the node never runs more than twice the cap.

use ferry_core::ZecNotes;
use serde::Serialize;

use crate::daemon::ApiError;

/// The `code` of a busy refusal.
pub const BUSY: &str = "busy";
/// [`ApiError`] carries a status and a message only; a busy message starts with this.
const BUSY_PREFIX: &str = "Busy: ";

/// Default cap on a main network: real funds, so a small blast radius while the concurrent code
/// is new; one slot stays open while one swap runs long, and late swaps don't take slots.
pub const MAINNET_MAX_SWAPS: u32 = 2;
/// Default cap on a test network (regtest, testnet, signet, the EVM test chains): a demo with a
/// few visitors at once. The demo's own hourly limits bound the total.
pub const TEST_MAX_SWAPS: u32 = 4;
/// The most `--max-swaps` may be: every live swap costs each tick several node calls.
pub const MAX_SWAPS_LIMIT: u32 = 64;

impl ApiError {
    /// 409 with `"code": "busy"`: try again once a swap finishes (or has locked).
    pub fn busy(msg: impl std::fmt::Display) -> ApiError {
        ApiError(409, format!("{BUSY_PREFIX}{msg}"))
    }

    pub fn is_busy(&self) -> bool {
        self.0 == 409 && self.1.starts_with(BUSY_PREFIX)
    }
}

/// `--max-swaps` as given, or the default for the network.
pub fn max_swaps(flag: Option<u32>, mainnet: bool) -> u32 {
    flag.unwrap_or(if mainnet {
        MAINNET_MAX_SWAPS
    } else {
        TEST_MAX_SWAPS
    })
}

/// `--max-swaps`: 1 to [`MAX_SWAPS_LIMIT`].
pub fn parse_max_swaps(s: &str) -> Result<u32, String> {
    let n: u32 = s.parse().map_err(|e| format!("{s}: {e}"))?;
    if !(1..=MAX_SWAPS_LIMIT).contains(&n) {
        return Err(format!("must be 1 to {MAX_SWAPS_LIMIT}"));
    }
    Ok(n)
}

/// What the count needs to know of one swap.
#[derive(Clone, Copy, Debug)]
pub struct Load {
    pub finished: bool,
    /// The counterparty has locked: B's coins are seen on chain (we are Z), or Z's ZEC lock note
    /// is (we are B).
    pub partner_locked: bool,
    /// Unix ms the swap was created (0: unknown, never late).
    pub created_ms: u64,
}

/// Live swaps, and how many of them are late.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Count {
    pub live: u32,
    pub late: u32,
}

impl Count {
    /// The swaps that count against the cap.
    pub fn counted(&self) -> u32 {
        self.live.saturating_sub(self.late)
    }
}

pub fn count(loads: impl IntoIterator<Item = Load>, now_ms: u64, grace_ms: u64) -> Count {
    let mut c = Count::default();
    for l in loads.into_iter().filter(|l| !l.finished) {
        c.live += 1;
        if !l.partner_locked && l.created_ms != 0 && now_ms >= l.created_ms.saturating_add(grace_ms)
        {
            c.late += 1;
        }
    }
    c
}

/// How many more swaps the node takes now: what the cap leaves, and never past twice the cap
/// in all.
pub fn free_slots(max: u32, c: Count) -> u32 {
    let by_cap = max.saturating_sub(c.counted());
    let by_ceiling = max.saturating_mul(2).saturating_sub(c.live);
    by_cap.min(by_ceiling)
}

/// One more swap, or busy.
pub fn admit(max: u32, c: Count) -> Result<(), ApiError> {
    if free_slots(max, c) > 0 {
        return Ok(());
    }
    if c.counted() >= max {
        return Err(ApiError::busy(format!(
            "this node is running {} swaps, as many as it takes at once (--max-swaps {max}); \
             try again once one of them finishes",
            c.counted()
        )));
    }
    Err(ApiError::busy(format!(
        "this node holds {} swaps, {} of them waiting out partners who never locked; it takes \
         no more until some of them end",
        c.live, c.late
    )))
}

/// A maker's refusal of our Propose that means busy: 409 with `"code": "busy"`, an older
/// maker's 409 "A swap is already in progress", or its proposal rate limit (429). The maker's
/// reason, if so.
pub fn peer_busy(status: u16, body: &serde_json::Value) -> Option<String> {
    let msg = body["error"].as_str().unwrap_or("").trim();
    let busy = status == 429
        || (status == 409 && (body["code"] == BUSY || msg == "A swap is already in progress"));
    busy.then(|| match msg.strip_prefix(BUSY_PREFIX).unwrap_or(msg) {
        "" => "it is busy".to_string(),
        m => m.to_string(),
    })
}

/// `capacity` in `GET /api/status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct CapacityView {
    /// `--max-swaps`.
    pub max_swaps: u32,
    /// Swaps not finished yet.
    pub live: u32,
    /// Of those, the ones whose counterparty never locked and that no longer count.
    pub late: u32,
    /// How many more swaps the node takes now.
    pub free_slots: u32,
}

impl CapacityView {
    pub fn of(max: u32, c: Count) -> CapacityView {
        CapacityView {
            max_swaps: max,
            live: c.live,
            late: c.late,
            free_slots: free_slots(max, c),
        }
    }
}

// ---------------------------------------------------------------------- ZEC notes

/// ZIP-317's marginal fee: a Zcash transaction pays it for every note it spends, two at least.
pub const ZEC_FEE_PER_NOTE: u64 = 5_000;

/// Whether our notes fund every lock in `needs` at once, however the wallet picks them. Each
/// need is a lock's amount plus a fee reserve of at least two notes' fee (the caller passes
/// the backend's reserve, 50000 zat for devtool).
/// - The wallet picks whole notes until they cover a lock and its fee, so a lock can take up to
///   one note more than it needs, and the extra notes of different locks are different notes:
///   the n−1 largest notes cover that (the last lock built needs only what it needs).
/// - The fee grows by [`ZEC_FEE_PER_NOTE`] with every note a lock spends, so a lock spending
///   more notes than its reserve covers pays more than its hold. Every note any lock can spend
///   is one of ours, so that fee per note we hold covers all of it.
///
/// `notes`: our largest notes (at least `needs.len() - 1` of them, when there are that many) and
/// how many there are; empty when the balance isn't made of notes (the mock), where only the
/// value counts. Change waits for confirmations, so it is not in `spendable` and never counted.
pub fn zec_locks_fit(spendable: u64, notes: &ZecNotes, needs: &[u64]) -> bool {
    let need: u128 = needs.iter().map(|&n| u128::from(n)).sum();
    let extra: u128 = notes
        .largest
        .iter()
        .take(needs.len().saturating_sub(1))
        .map(|&n| u128::from(n))
        .sum();
    need + extra + per_note_fees(notes) <= u128::from(spendable)
}

fn per_note_fees(notes: &ZecNotes) -> u128 {
    u128::from(notes.count) * u128::from(ZEC_FEE_PER_NOTE)
}

/// The largest lock amount (its fee reserve set aside) that still fits next to `needs` by
/// [`zec_locks_fit`]: `notes.largest` must hold at least `needs.len()` notes when there are that
/// many.
pub fn zec_room(spendable: u64, notes: &ZecNotes, needs: &[u64], fee_reserve: u64) -> u64 {
    let used: u128 = needs
        .iter()
        .chain(notes.largest.iter().take(needs.len()))
        .map(|&n| u128::from(n))
        .sum::<u128>()
        + u128::from(fee_reserve)
        + per_note_fees(notes);
    u64::try_from(u128::from(spendable).saturating_sub(used)).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load(finished: bool, partner_locked: bool, created_ms: u64) -> Load {
        Load {
            finished,
            partner_locked,
            created_ms,
        }
    }

    /// Finished swaps don't count; a swap whose partner never locked stops counting once the
    /// negotiation timeout has passed; one whose partner locked always counts.
    #[test]
    fn counting_live_and_late_swaps() {
        let grace = 1_800_000;
        let now = 10_000_000;
        let c = count(
            [
                load(true, false, 1),                // finished
                load(false, true, 1),                // partner locked long ago: counts
                load(false, false, now - grace),     // just late
                load(false, false, now - grace + 1), // not yet
                load(false, false, 0),               // unknown age: never late
            ],
            now,
            grace,
        );
        assert_eq!(c, Count { live: 4, late: 1 });
        assert_eq!(c.counted(), 3);
        assert_eq!(count([], now, grace), Count::default());
    }

    /// The cap and the ceiling: late swaps free their slot, up to twice the cap in all.
    #[test]
    fn the_cap_and_late_swaps() {
        let max = 4;
        assert_eq!(free_slots(max, Count { live: 0, late: 0 }), 4);
        assert_eq!(free_slots(max, Count { live: 3, late: 0 }), 1);
        assert!(admit(max, Count { live: 3, late: 0 }).is_ok());
        let full = admit(max, Count { live: 4, late: 0 }).unwrap_err();
        assert_eq!(full.0, 409);
        assert!(full.is_busy());
        assert_eq!(full.code(), Some(BUSY));
        assert!(full.1.contains("--max-swaps 4"), "{}", full.1);
        // Two of the four are late: two slots again.
        assert_eq!(free_slots(max, Count { live: 4, late: 2 }), 2);
        // Never more than 8 in all.
        assert_eq!(free_slots(max, Count { live: 7, late: 4 }), 1);
        assert_eq!(free_slots(max, Count { live: 8, late: 6 }), 0);
        let ceiling = admit(max, Count { live: 8, late: 6 }).unwrap_err();
        assert!(ceiling.is_busy());
        assert!(ceiling.1.contains("never locked"), "{}", ceiling.1);
        // A cap of one.
        assert_eq!(free_slots(1, Count { live: 1, late: 0 }), 0);
        assert_eq!(free_slots(1, Count { live: 1, late: 1 }), 1);
        assert_eq!(free_slots(1, Count { live: 2, late: 1 }), 0);
        let v = CapacityView::of(max, Count { live: 5, late: 2 });
        assert_eq!(
            serde_json::to_value(v).unwrap(),
            serde_json::json!({"max_swaps": 4, "live": 5, "late": 2, "free_slots": 1})
        );
    }

    #[test]
    fn defaults_and_limits() {
        assert_eq!(max_swaps(None, true), MAINNET_MAX_SWAPS);
        assert_eq!(max_swaps(None, false), TEST_MAX_SWAPS);
        assert_eq!(max_swaps(Some(7), true), 7);
        assert_eq!(parse_max_swaps("3"), Ok(3));
        for bad in ["0", "65", "-1", "x", ""] {
            assert!(parse_max_swaps(bad).is_err(), "{bad}");
        }
        let other = ApiError(409, "Another thing".into());
        assert!(!other.is_busy() && other.code().is_none());
    }

    /// What a taker reads as a busy maker: the busy code, an older maker's one-at-a-time
    /// refusal, a rate limit. Nothing else.
    #[test]
    fn busy_makers() {
        use serde_json::json;
        let full = admit(1, Count { live: 1, late: 0 }).unwrap_err();
        let body = json!({"error": full.1, "code": full.code()});
        let why = peer_busy(409, &body).unwrap();
        assert!(why.starts_with("this node is running 1 swaps"), "{why}");
        assert_eq!(
            peer_busy(409, &json!({"error": "A swap is already in progress"})).as_deref(),
            Some("A swap is already in progress")
        );
        assert_eq!(
            peer_busy(
                429,
                &json!({"error": "Too many proposals; try again in a minute"})
            )
            .as_deref(),
            Some("Too many proposals; try again in a minute")
        );
        assert_eq!(peer_busy(429, &json!({})).as_deref(), Some("it is busy"));
        for (status, body) in [
            (409, json!({"error": "swap id in use"})),
            (
                409,
                json!({"error": "Route label in use: x", "code": "route_label_in_use"}),
            ),
            (400, json!({"error": "Busy: no", "code": "busy"})),
            (502, json!({})),
        ] {
            assert_eq!(peer_busy(status, &body), None, "{status} {body}");
        }
    }

    /// Several locks from whole notes: the value is not enough when the wallet may take a big
    /// note for a small lock.
    #[test]
    fn zec_locks_and_notes() {
        let fee = 50_000;
        let half = 50_000_000 + fee;
        let notes = |largest: &[u64], count: u64| ZecNotes {
            largest: largest.to_vec(),
            count,
        };
        // One 5 ZEC note: one 0.5 ZEC lock fits, a second may find the note gone (its change
        // is unconfirmed), so it does not.
        let one = notes(&[500_000_000], 1);
        assert!(zec_locks_fit(500_000_000, &one, &[half]));
        assert!(!zec_locks_fit(500_000_000, &one, &[half, half]));
        // 5, 1, 1, 1, 1 ZEC: three such locks fit, a fourth does not.
        let five = notes(&[500_000_000, 100_000_000, 100_000_000, 100_000_000], 5);
        let total = 900_000_000;
        assert!(zec_locks_fit(total, &five, &[half, half, half]));
        assert!(!zec_locks_fit(total, &five, &[half, half, half, half]));
        // Without notes (the mock), the value alone.
        let none = ZecNotes::default();
        assert!(zec_locks_fit(2 * half, &none, &[half, half]));
        assert!(!zec_locks_fit(2 * half - 1, &none, &[half, half]));
        assert!(zec_locks_fit(0, &none, &[]));
        // Room for one more lock next to one 0.5 ZEC lock in flight:
        // 9 − 0.5005 − 5 − the fee reserve − 5 notes' fees.
        let room = zec_room(total, &five, &[half], fee);
        assert_eq!(
            room,
            total - half - 500_000_000 - fee - 5 * ZEC_FEE_PER_NOTE
        );
        assert!(zec_locks_fit(total, &five, &[half, room + fee]));
        assert!(!zec_locks_fit(total, &five, &[half, room + fee + 1]));
        // Nothing in flight: the balance less the fee and the notes' fees.
        assert_eq!(
            zec_room(total, &five, &[], fee),
            total - fee - 5 * ZEC_FEE_PER_NOTE
        );
        assert_eq!(zec_room(1, &five, &[half], fee), 0, "no underflow");
    }

    /// Many small notes: a lock that spends more of them than its fee reserve covers pays more
    /// than its hold, and the check counts that (without the fee per note it would admit this).
    #[test]
    fn zec_fees_per_note_count() {
        // 100 notes of 0.01 ZEC (1 ZEC), locks of 0.5 and 0.4855 ZEC with 0.0005 reserves.
        let small = ZecNotes {
            largest: vec![1_000_000; 2],
            count: 100,
        };
        let needs = [50_050_000, 48_600_000];
        let old_bound: u64 = needs.iter().sum::<u64>() + 1_000_000;
        assert!(
            old_bound <= 100_000_000,
            "the bound without fees per note admits it"
        );
        assert!(!zec_locks_fit(100_000_000, &small, &needs));
        assert!(zec_locks_fit(
            100_000_000,
            &small,
            &[50_050_000, 48_400_000]
        ));
    }

    /// The bound against a model of the wallet: notes are picked in some order (oldest first in
    /// the wallet; any order here) until they cover the lock and its fee, 5000 zat per note
    /// spent and two at least; change waits for confirmations. Whenever `zec_locks_fit` admits
    /// a set of locks, every one of them is funded, whatever the order of the notes and of the
    /// locks.
    #[test]
    fn zec_bound_holds_against_the_wallet() {
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut rnd = move |n: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % n
        };
        let reserve = 50_000;
        let mut admitted = 0;
        for _ in 0..20_000 {
            let n_notes = 1 + rnd(40) as usize;
            let scale = [20_000, 1_000_000, 100_000_000][rnd(3) as usize];
            let mut values: Vec<u64> = Vec::new();
            for _ in 0..n_notes {
                // the wallet never spends a note worth no more than its fee
                values.push(ZEC_FEE_PER_NOTE + 1 + rnd(scale));
            }
            // amounts near what the notes hold, so admissions land close to the bound
            let total: u64 = values.iter().sum();
            let n_locks = 1 + rnd(4) as usize;
            let mut amounts: Vec<u64> = Vec::new();
            for _ in 0..n_locks {
                amounts.push(1 + rnd(total / n_locks as u64 + 1));
            }
            let needs: Vec<u64> = amounts.iter().map(|a| a + reserve).collect();
            let mut sorted = values.clone();
            sorted.sort_unstable_by(|a, b| b.cmp(a));
            sorted.truncate(n_locks);
            let notes = ZecNotes {
                largest: sorted,
                count: n_notes as u64,
            };
            if !zec_locks_fit(values.iter().sum(), &notes, &needs) {
                continue;
            }
            admitted += 1;
            for i in (1..values.len()).rev() {
                values.swap(i, rnd(i as u64 + 1) as usize);
            }
            let mut order: Vec<usize> = (0..n_locks).collect();
            for i in (1..order.len()).rev() {
                order.swap(i, rnd(i as u64 + 1) as usize);
            }
            let mut left = values.clone();
            for &l in &order {
                let (mut sum, mut k) = (0u64, 0u64);
                while sum < amounts[l] + ZEC_FEE_PER_NOTE * k.max(2) {
                    assert!(
                        (k as usize) < left.len(),
                        "lock {} of {amounts:?} not funded from {values:?}",
                        amounts[l]
                    );
                    sum += left[k as usize];
                    k += 1;
                }
                left.drain(..k as usize);
            }
        }
        assert!(admitted > 1_000, "only {admitted} cases admitted");
    }
}
