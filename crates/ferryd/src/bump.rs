//! When and how much to bump the fee of a presigned Bitcoin spend (pure, so every rule can be
//! tested without a node).
//!
//! A presigned spend carries one fixed fee that nothing can raise. The party that needs it
//! confirmed already owns an output of it (tx_redeem pays Z's wallet address, tx_refund B's,
//! tx_punish Z's), so it raises the effective fee by spending that output in a child that pays
//! more (CPFP, `ferry_btc::child`), and replaces its own child by a better one (RBF of the child,
//! never of the presigned parent) as the deadline nears. tx_cancel is deliberately not bumped.
//!
//! [`decide`] turns a snapshot of the parent, our last child, the node's fee floors and an
//! estimate into one of:
//! * [`BumpDecision::Hold`]: nothing to do now (confirmed, already at the target, rate limited,
//!   waiting for more budget, or a package is needed and the chain takes none);
//! * [`BumpDecision::Bump`]: send, replace or package-submit a child paying exactly
//!   `child_fee`, which is never below what the node will accept and never above the cap;
//! * [`BumpDecision::Exhausted`]: a bump is wanted and no valid one fits what the output can pay.
//!
//! Rules: the package of the parent and its child should reach
//! `want = max(estimate x margin, floor + one increment)`, where the margin grows as the
//! deadline nears and the floor is the node's own, read from it. A fee is never lowered. A
//! replacement adds at least `incremental x its own size` and beats the old child's rate (BIP125
//! rules 3, 4 and 6). The fee is capped at 10% of the payout while more than
//! [`Params::urgent_blocks`] blocks are left and at `payout - dust` after that: losing the swap
//! costs the whole stake, so urgency may pay more than the 5% baseline rule.

use std::fmt;

use ferry_btc::bitcoin::Txid;
use ferry_btc::child::{fee_for, rate_of};
use ferry_btc::rpc::FeeFloors;

/// Blocks assumed left for a spend with no deadline (tx_punish): confirmation is a matter of
/// liveness, never of safety.
pub const LIVENESS_BLOCKS: u32 = 6;
/// Default soft cap: a child may pay this share of the payout while time remains.
pub const DEFAULT_SOFT_CAP_PERCENT: u64 = 10;
/// Default: at or below this many blocks left, the urgent cap applies.
pub const DEFAULT_URGENT_BLOCKS: u32 = 2;
/// Default: at most one replacement per block.
pub const DEFAULT_MIN_INTERVAL_BLOCKS: u64 = 1;
/// A target that rose by this much (per mille of the package's current rate) is worth a
/// replacement within the same block.
const RATE_JUMP_PERMILLE: u64 = 1250;

/// The deadline of the spend being bumped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Deadline {
    /// tx_redeem must confirm before the lock has `t1` confirmations, when tx_cancel can be mined.
    Redeem { t1: u32, lock_confs: u32 },
    /// tx_refund must confirm before the cancel has `t2` confirmations, when tx_punish can be.
    Refund { t2: u32, cancel_confs: u32 },
    /// No deadline (tx_punish): only liveness.
    Liveness,
}

impl Deadline {
    /// Blocks left to confirm, with one block of slack: `t - confs - 1`, so `0` means the next
    /// block is the last that is certainly safe. Never below zero: once the race is on the bump
    /// is all-in, not abandoned.
    pub fn blocks_left(&self) -> u32 {
        match *self {
            Deadline::Redeem { t1, lock_confs } => t1.saturating_sub(lock_confs).saturating_sub(1),
            Deadline::Refund { t2, cancel_confs } => {
                t2.saturating_sub(cancel_confs).saturating_sub(1)
            }
            Deadline::Liveness => LIVENESS_BLOCKS,
        }
    }
}

/// The parent (the presigned spend) as the node sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParentSnapshot {
    /// Its own vsize and fee (known from the template either way).
    pub vsize: u64,
    pub base_fee: u64,
    /// Fee and vsize of the parent with its unconfirmed ancestors, if the node holds it in its
    /// mempool; None if it is evicted, below the floor or was never relayed.
    pub mempool: Option<Ancestry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ancestry {
    pub fee: u64,
    pub vsize: u64,
}

/// A child we sent before.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChildSnapshot {
    pub txid: Txid,
    pub fee: u64,
    pub vsize: u64,
    /// The node holds it now. A child the node dropped is no longer replaced, but its fee is
    /// still the least a new one pays.
    pub in_mempool: bool,
}

/// Settings of one bump (from the daemon's flags and the swap).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Params {
    /// Upper bound on the child's vsize (`ferry_btc::child::vsize_bound`).
    pub child_vsize: u64,
    /// Value of the parent output the child spends.
    pub payout: u64,
    /// Dust threshold of the child's output script: the child may not leave less.
    pub dust: u64,
    pub soft_cap_percent: u64,
    pub urgent_blocks: u32,
    pub min_interval_blocks: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BumpInput {
    pub deadline: Deadline,
    pub parent: ParentSnapshot,
    /// Confirmations of the parent: 0 while unconfirmed.
    pub parent_confirmations: u32,
    pub child: Option<ChildSnapshot>,
    pub params: Params,
    /// The node's floors now.
    pub floors: FeeFloors,
    /// `estimatesmartfee` for `max(1, blocks_left)` blocks, in sat per kvB; None if it has none.
    pub estimate: Option<u64>,
    /// The chain has `submitpackage`.
    pub packages: bool,
    /// Chain tip height now, and the height of our last bump.
    pub tip: u64,
    pub last_bump_height: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoldReason {
    /// The parent is confirmed: nothing left to bump.
    Confirmed,
    /// The package of parent and child already pays the target.
    AtTarget,
    /// A bump was sent this block and the target has not jumped.
    RateLimited,
    /// The soft cap is reached; the urgent cap applies when the deadline is near.
    SoftCap,
    /// The parent is not in the mempool and this chain takes no packages: the parent itself must
    /// be rebroadcast first.
    NeedsPackage,
}

impl fmt::Display for HoldReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            HoldReason::Confirmed => "the spend is confirmed",
            HoldReason::AtTarget => "the package already pays the target rate",
            HoldReason::RateLimited => "already bumped in this block",
            HoldReason::SoftCap => "at the soft fee cap, waiting for the deadline to widen it",
            HoldReason::NeedsPackage => {
                "the spend is not in the mempool and this chain takes no packages"
            }
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExhaustedReason {
    /// No valid child fits within what the output can pay while keeping its output above dust.
    NoRoom,
    /// The parent is not in the mempool and pays less than the node's static `minrelaytxfee`
    /// by itself. A package lifts a parent over the mempool's rising floor, not over this one
    /// (Bitcoin Core 28.1: "min relay fee not met"), so no child can bring it back. Only a
    /// higher presigned fee, fixed at the start of a swap, would have helped.
    ParentBelowMinRelay,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubmitMode {
    /// The parent is in the mempool and has no child: send the child.
    Send,
    /// Replace this child of ours (same input, so a direct conflict).
    Replace(Txid),
    /// The parent is not in the mempool: submit parent and child as one package.
    Package,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BumpPlan {
    /// What the child pays, in satoshis.
    pub child_fee: u64,
    /// The package rate wanted (sat per kvB); the fee is below it only if `capped`.
    pub target_rate: u64,
    pub mode: SubmitMode,
    /// The fee is held down by the cap.
    pub capped: bool,
    pub blocks_left: u32,
    pub urgent: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BumpDecision {
    Hold(HoldReason),
    Bump(BumpPlan),
    Exhausted(ExhaustedReason),
}

/// How much above the estimate to bid: a spike can outrun an estimate, and as time runs out a
/// stuck swap costs the whole stake, so the margin grows (per mille, never falling as the
/// deadline nears).
pub fn margin_permille(blocks_left: u32) -> u64 {
    match blocks_left {
        0..=1 => 2000,
        2..=3 => 1500,
        _ => 1200,
    }
}

/// The package rate wanted (sat per kvB): the estimate (never below the node's floor) times the
/// deadline margin, and at least one increment above the floor so the child also clears it.
pub fn want_rate(estimate: Option<u64>, floor: u64, incremental: u64, blocks_left: u32) -> u64 {
    let base = estimate.unwrap_or(0).max(floor);
    let scaled = u128::from(base) * u128::from(margin_permille(blocks_left)) / 1000;
    u64::try_from(scaled)
        .unwrap_or(u64::MAX)
        .max(floor.saturating_add(incremental))
}

/// The fee cap (satoshis) at this urgency: the soft cap while time remains, and always at most
/// `payout - dust`, so the child's output never falls below dust.
pub fn cap(params: &Params, urgent: bool) -> u64 {
    let room = params.payout.saturating_sub(params.dust);
    if urgent {
        return room;
    }
    let soft = u128::from(params.payout) * u128::from(params.soft_cap_percent) / 100;
    u64::try_from(soft).unwrap_or(u64::MAX).min(room)
}

/// The least a child replacing `old` may pay: BIP125 rule 3 and 4 (the old fee plus the
/// incremental fee for the replacement's own size) and rule 6 (a higher fee rate than the old).
fn min_replacement(old: &ChildSnapshot, vsize: u64, incremental: u64) -> u64 {
    let rule4 = old.fee.saturating_add(fee_for(incremental, vsize));
    let rule6 = if old.vsize == 0 {
        0
    } else {
        // Smallest fee with fee / vsize > old.fee / old.vsize.
        u64::try_from(u128::from(old.fee) * u128::from(vsize) / u128::from(old.vsize) + 1)
            .unwrap_or(u64::MAX)
    };
    rule4.max(rule6)
}

pub fn decide(i: &BumpInput) -> BumpDecision {
    use BumpDecision::*;
    if i.parent_confirmations > 0 {
        return Hold(HoldReason::Confirmed);
    }
    let parent_in_mempool = i.parent.mempool.is_some();
    if !parent_in_mempool && !i.packages {
        return Hold(HoldReason::NeedsPackage);
    }
    if !parent_in_mempool && i.parent.base_fee < fee_for(i.floors.min_relay, i.parent.vsize) {
        return Exhausted(ExhaustedReason::ParentBelowMinRelay);
    }
    let blocks_left = i.deadline.blocks_left();
    let urgent = blocks_left <= i.params.urgent_blocks;
    let floor = i.floors.floor();
    // A node that reports no incremental fee would let a replacement add nothing; one satoshi
    // per kvB keeps the arithmetic strictly increasing.
    let inc = i.floors.incremental.max(1);
    let want = want_rate(i.estimate, floor, inc, blocks_left);

    // The package the child joins: the parent with its unconfirmed ancestors (the parent alone
    // when the node does not hold it: its ancestors are confirmed).
    let base = i.parent.mempool.unwrap_or(Ancestry {
        fee: i.parent.base_fee,
        vsize: i.parent.vsize,
    });
    // Our child counts only while the node holds it, and it can only be held with its parent.
    let live_child = i.child.filter(|c| c.in_mempool && parent_in_mempool);
    let cur_rate = match (parent_in_mempool, live_child) {
        (true, Some(c)) => rate_of(base.fee.saturating_add(c.fee), base.vsize + c.vsize),
        (true, None) => rate_of(base.fee, base.vsize),
        (false, _) => 0,
    };
    if parent_in_mempool && cur_rate >= want {
        return Hold(HoldReason::AtTarget);
    }
    let recent = i
        .last_bump_height
        .is_some_and(|h| i.tip < h.saturating_add(i.params.min_interval_blocks));
    let jumped = u128::from(want) * 1000 >= u128::from(cur_rate) * u128::from(RATE_JUMP_PERMILLE);
    if recent && !urgent && !jumped {
        return Hold(HoldReason::RateLimited);
    }

    let cv = i.params.child_vsize;
    // To lift the package to the target; the child must also pass the mempool floor on its own
    // (a child's acceptance is judged alone when its parent is already held); and it replaces
    // our last child by the BIP125 rules; and a fee is never lowered, even below a child the
    // node has dropped.
    let for_target = fee_for(want, base.vsize + cv).saturating_sub(base.fee);
    let for_floor = fee_for(floor.saturating_add(inc), cv);
    let for_replacement = live_child.map_or(0, |c| min_replacement(&c, cv, inc));
    let history = i.child.map_or(0, |c| c.fee);
    let least = for_floor.max(for_replacement).max(history);
    let mut fee = for_target.max(least);

    let room = i.params.payout.saturating_sub(i.params.dust);
    if least > room {
        return Exhausted(ExhaustedReason::NoRoom);
    }
    let limit = cap(&i.params, urgent);
    let capped = fee > limit;
    if capped {
        if least > limit {
            // More budget comes with the deadline; until then wait.
            return Hold(HoldReason::SoftCap);
        }
        fee = limit;
    }
    let mode = match (parent_in_mempool, live_child) {
        (true, Some(c)) => SubmitMode::Replace(c.txid),
        (true, None) => SubmitMode::Send,
        (false, _) => SubmitMode::Package,
    };
    Bump(BumpPlan {
        child_fee: fee,
        target_rate: want,
        mode,
        capped,
        blocks_left,
        urgent,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferry_btc::bitcoin::hashes::Hash;
    use BumpDecision::*;

    fn txid(n: u8) -> Txid {
        Txid::from_byte_array([n; 32])
    }

    /// A redeem paying 280k sat, in the mempool at its presigned 2000 sat (18 sat/vB), no child
    /// yet, 8 blocks before its deadline, the node's default floors (1 sat/vB). The soft cap is
    /// then 28k sat; tests of the caps use a smaller payout.
    fn base() -> BumpInput {
        BumpInput {
            deadline: Deadline::Redeem {
                t1: 12,
                lock_confs: 3,
            },
            parent: ParentSnapshot {
                vsize: 111,
                base_fee: 2_000,
                mempool: Some(Ancestry {
                    fee: 2_000,
                    vsize: 111,
                }),
            },
            parent_confirmations: 0,
            child: None,
            params: Params {
                child_vsize: 111,
                payout: 280_000,
                dust: 330,
                soft_cap_percent: 10,
                urgent_blocks: 2,
                min_interval_blocks: 1,
            },
            floors: FeeFloors {
                min_relay: 1_000,
                mempool_min: 1_000,
                incremental: 1_000,
            },
            estimate: Some(5_000),
            packages: true,
            tip: 1_000,
            last_bump_height: None,
        }
    }

    fn plan(d: BumpDecision) -> BumpPlan {
        match d {
            Bump(p) => p,
            other => panic!("expected a bump, got {other:?}"),
        }
    }

    #[test]
    fn deadlines() {
        let r = |lock_confs| Deadline::Redeem { t1: 12, lock_confs }.blocks_left();
        assert_eq!(
            [r(0), r(8), r(10), r(11), r(12), r(30)],
            [11, 3, 1, 0, 0, 0]
        );
        let f = |cancel_confs| {
            Deadline::Refund {
                t2: 24,
                cancel_confs,
            }
            .blocks_left()
        };
        assert_eq!([f(1), f(20), f(23), f(24), f(99)], [22, 3, 0, 0, 0]);
        assert_eq!(Deadline::Liveness.blocks_left(), LIVENESS_BLOCKS);
    }

    #[test]
    fn a_confirmed_parent_needs_nothing() {
        let mut i = base();
        i.parent_confirmations = 1;
        i.estimate = Some(900_000);
        assert_eq!(decide(&i), Hold(HoldReason::Confirmed));
    }

    #[test]
    fn a_parent_already_paying_the_target_is_left_alone() {
        // 18 sat/vB against a 5 sat/vB estimate (wanted 6): nothing to pay for.
        assert_eq!(decide(&base()), Hold(HoldReason::AtTarget));
        // Exactly at the target is still enough: the package rate equals the wanted rate.
        let mut i = base();
        i.estimate = Some(15_000);
        // want = 15000 x 1.2 = 18000 sat/kvB; the parent pays 2000/111 = 18018.
        assert_eq!(decide(&i), Hold(HoldReason::AtTarget));
        i.estimate = Some(15_100);
        assert!(matches!(decide(&i), Bump(_)));
    }

    #[test]
    fn a_spike_first_sends_a_child() {
        let mut i = base();
        i.estimate = Some(60_000); // 60 sat/vB
        let p = plan(decide(&i));
        // want = 72 sat/vB over parent + child (222 vB): 15_984 sat, less the parent's 2_000.
        assert_eq!(p.target_rate, 72_000);
        assert_eq!(p.child_fee, 13_984);
        assert_eq!(p.mode, SubmitMode::Send);
        assert!(!p.urgent && !p.capped);
        // The same spike on a payout of 28k: the soft cap (10%) holds the fee at 2_800.
        i.params.payout = 28_000;
        let p = plan(decide(&i));
        assert_eq!((p.child_fee, p.capped), (2_800, true));
    }

    #[test]
    fn the_soft_cap_holds_the_fee_then_the_urgent_cap_widens_it() {
        let mut i = base();
        i.params.payout = 28_000;
        i.estimate = Some(60_000);
        let early = plan(decide(&i));
        assert_eq!(early.child_fee, 2_800);
        assert!(early.capped && !early.urgent);
        // Nothing more to pay for until the deadline widens the cap: the sent child is at the
        // soft cap and the target is still above it.
        i.child = Some(ChildSnapshot {
            txid: txid(1),
            fee: 2_800,
            vsize: 111,
            in_mempool: true,
        });
        i.last_bump_height = Some(1_000);
        i.tip = 1_001;
        assert_eq!(decide(&i), Hold(HoldReason::SoftCap));
        // Two blocks before the deadline the cap is payout - dust, and the margin is higher.
        i.deadline = Deadline::Redeem {
            t1: 12,
            lock_confs: 9,
        };
        let late = plan(decide(&i));
        assert!(late.urgent);
        assert_eq!(late.blocks_left, 2);
        // want = 60 x 1.5 = 90 sat/vB: 90 x 222 = 19_980 - 2_000.
        assert_eq!(late.target_rate, 90_000);
        assert_eq!(late.child_fee, 17_980);
        assert!(!late.capped);
        assert_eq!(late.mode, SubmitMode::Replace(txid(1)));
        // At the deadline with a huge spike the child may take everything but dust.
        i.deadline = Deadline::Redeem {
            t1: 12,
            lock_confs: 11,
        };
        i.estimate = Some(900_000);
        let all_in = plan(decide(&i));
        assert_eq!(all_in.child_fee, 28_000 - 330);
        assert!(all_in.capped && all_in.urgent);
    }

    #[test]
    fn a_replacement_adds_the_incremental_fee_and_beats_the_old_rate() {
        let mut i = base();
        i.estimate = Some(20_000);
        i.deadline = Deadline::Redeem {
            t1: 12,
            lock_confs: 9,
        };
        i.child = Some(ChildSnapshot {
            txid: txid(2),
            fee: 3_000,
            vsize: 111,
            in_mempool: true,
        });
        i.last_bump_height = Some(900);
        // want = 20 x 1.5 = 30 sat/vB over 222 vB = 6_660; the current package pays
        // (2000+3000)/222 = 22 sat/vB, so a bump is due.
        let p = plan(decide(&i));
        assert_eq!(p.child_fee, 4_660);
        assert!(p.child_fee >= 3_000 + 111, "old fee + 1 sat/vB x 111 vB");
        // When the target is barely above the package's rate the replacement still adds the
        // full incremental fee, not the smaller fee that would be refused.
        i.child = Some(ChildSnapshot {
            txid: txid(2),
            fee: 2_990,
            vsize: 111,
            in_mempool: true,
        });
        // package = (2000 + 2990) / 222 = 22_477 sat/kvB; at an estimate of 14_900 the wanted
        // rate is 22_350: already there.
        i.estimate = Some(14_900);
        assert_eq!(decide(&i), Hold(HoldReason::AtTarget));
        // At 15_000 the wanted rate is 22_500 > 22_477. The target alone needs 22.5 x 222 - 2000
        // = 2_995 sat, but replacing a 2_990 child takes 2_990 + 111.
        i.estimate = Some(15_000);
        let p = plan(decide(&i));
        assert_eq!(p.child_fee, 2_990 + 111);
        assert!(p.child_fee > 2_995);
    }

    #[test]
    fn a_larger_old_child_must_still_be_beaten_on_rate() {
        // Rule 6: the new child's rate must exceed the old child's, whatever their sizes.
        let old = ChildSnapshot {
            txid: txid(3),
            fee: 5_000,
            vsize: 200,
            in_mempool: true,
        };
        // 25 sat/vB old; a 111 vB child must pay > 2_775.
        assert!(min_replacement(&old, 111, 1_000) >= 5_000 + 111);
        let cheap = ChildSnapshot {
            fee: 100,
            vsize: 500,
            ..old
        };
        // 0.2 sat/vB old: rule 4 dominates.
        assert_eq!(min_replacement(&cheap, 111, 1_000), 100 + 111);
        let dense = ChildSnapshot {
            fee: 100,
            vsize: 1,
            ..old
        };
        // 100 sat/vB old (a 1 vB child): 111 vB must pay > 11_100 for a higher rate.
        assert_eq!(min_replacement(&dense, 111, 1_000), 11_101);
    }

    #[test]
    fn the_nodes_floors_are_obeyed_not_assumed() {
        let mut i = base();
        // Core 30: 0.1 sat/vB floors. A cheap estimate and a parent at 18 sat/vB: hold.
        i.floors = FeeFloors {
            min_relay: 100,
            mempool_min: 100,
            incremental: 100,
        };
        i.estimate = Some(500);
        assert_eq!(decide(&i), Hold(HoldReason::AtTarget));
        // A full mempool lifts the floor above the parent's 18 sat/vB: the child must clear it
        // by an increment, whatever the estimate says.
        i.floors.mempool_min = 40_000;
        i.estimate = None;
        let p = plan(decide(&i));
        assert_eq!(p.target_rate, 48_000, "the floor x 1.2");
        assert_eq!(p.child_fee, 48 * 222 - 2_000);
        // The child alone passes the floor + an increment.
        assert!(rate_of(p.child_fee, 111) >= 40_000 + 100);
        // With no estimate and calm floors a parent at a fair rate is left alone.
        let mut j = base();
        j.estimate = None;
        assert_eq!(decide(&j), Hold(HoldReason::AtTarget));
    }

    #[test]
    fn a_rising_floor_lifts_the_child_clear_of_it() {
        // The parent pays 198 sat/vB but the node's floor has risen to 150: the package is
        // judged against 2 x the floor at the deadline, and the child alone clears the floor.
        let mut i = base();
        i.parent.base_fee = 22_000;
        i.parent.mempool = Some(Ancestry {
            fee: 22_000,
            vsize: 111,
        });
        i.floors.mempool_min = 150_000; // 150 sat/vB
        i.estimate = Some(1_000);
        i.deadline = Deadline::Redeem {
            t1: 12,
            lock_confs: 10,
        };
        let p = plan(decide(&i));
        // want = max(150_000, 1_000) x 2.0 = 300 sat/vB; package 222 vB: 66_600 - 22_000.
        assert_eq!(p.child_fee, 66_600 - 22_000);
        assert!(p.child_fee >= fee_for(151_000, 111));
    }

    #[test]
    fn an_evicted_parent_goes_back_in_as_a_package() {
        let mut i = base();
        i.parent.mempool = None;
        i.estimate = Some(60_000);
        i.deadline = Deadline::Redeem {
            t1: 12,
            lock_confs: 10,
        };
        let p = plan(decide(&i));
        assert_eq!(p.mode, SubmitMode::Package);
        // want = 60 x 2.0 = 120 sat/vB over 222 vB = 26_640, less the parent's 2_000 (the parent
        // is judged at its own fee, which only the package lifts).
        assert_eq!(p.child_fee, 24_640);
        // A child the node dropped with the parent is not replaced, but its fee is a floor.
        i.child = Some(ChildSnapshot {
            txid: txid(4),
            fee: 25_000,
            vsize: 111,
            in_mempool: false,
        });
        let p = plan(decide(&i));
        assert_eq!(p.mode, SubmitMode::Package);
        assert!(p.child_fee >= 25_000, "never lowers a fee");
        // A dropped child that already took more than the output can give leaves no room.
        i.child = Some(ChildSnapshot {
            txid: txid(4),
            fee: 280_000,
            vsize: 111,
            in_mempool: false,
        });
        assert_eq!(decide(&i), Exhausted(ExhaustedReason::NoRoom));
        i.child = None;
        // Litecoin takes no packages: wait for the parent to be rebroadcast.
        i.packages = false;
        assert_eq!(decide(&i), Hold(HoldReason::NeedsPackage));
        // But a Litecoin parent that is in the mempool is bumped like any other.
        let mut l = base();
        l.packages = false;
        l.estimate = Some(60_000);
        l.deadline = Deadline::Redeem {
            t1: 12,
            lock_confs: 10,
        };
        assert_eq!(plan(decide(&l)).mode, SubmitMode::Send);
    }

    #[test]
    fn a_parent_below_the_static_relay_floor_cannot_be_rescued_by_a_package() {
        // Recorded on Bitcoin Core 28.1 (regtest, -minrelaytxfee=0.0003): submitpackage of a
        // 2000-sat, 111 vB parent with a 20000-sat child failed with the parent's own
        // "min relay fee not met, 2000 < 3330" and the child with "bad-txns-inputs-missingorspent".
        let mut i = base();
        i.parent.mempool = None;
        i.floors = FeeFloors {
            min_relay: 30_000,
            mempool_min: 30_000,
            incremental: 1_000,
        };
        i.estimate = Some(60_000);
        assert_eq!(decide(&i), Exhausted(ExhaustedReason::ParentBelowMinRelay));
        // Exactly at the relay floor is enough (2000 sat over 111 vB is 18.02 sat/vB).
        i.floors.min_relay = 18_018;
        i.floors.mempool_min = 18_018;
        assert!(matches!(decide(&i), Bump(_)));
        i.floors.min_relay = 18_019;
        assert_eq!(decide(&i), Exhausted(ExhaustedReason::ParentBelowMinRelay));
        // A parent the mempool holds is a different matter: it already passed that check.
        let mut held = base();
        held.floors.min_relay = 30_000;
        held.floors.mempool_min = 30_000;
        held.estimate = Some(60_000);
        assert!(matches!(decide(&held), Bump(_)));
        // And without packages the answer is the earlier one: wait for the parent.
        i.packages = false;
        assert_eq!(decide(&i), Hold(HoldReason::NeedsPackage));
    }

    #[test]
    fn a_dropped_child_with_a_held_parent_is_sent_again_never_cheaper() {
        let mut i = base();
        i.estimate = Some(60_000);
        i.deadline = Deadline::Redeem {
            t1: 12,
            lock_confs: 9,
        };
        i.child = Some(ChildSnapshot {
            txid: txid(5),
            fee: 20_000,
            vsize: 111,
            in_mempool: false,
        });
        let p = plan(decide(&i));
        assert_eq!(p.mode, SubmitMode::Send);
        assert!(p.child_fee >= 20_000);
    }

    #[test]
    fn replacements_are_rate_limited_to_one_per_block() {
        let mut i = base();
        i.estimate = Some(20_000);
        i.child = Some(ChildSnapshot {
            txid: txid(6),
            fee: 3_000,
            vsize: 111,
            in_mempool: true,
        });
        i.last_bump_height = Some(1_000);
        // Same block, target rose a little (package 22.5 sat/vB, want 24): wait.
        i.tip = 1_000;
        assert_eq!(decide(&i), Hold(HoldReason::RateLimited));
        // Next block: go.
        i.tip = 1_001;
        assert!(matches!(decide(&i), Bump(_)));
        // Same block, but the target jumped by 25%: go.
        i.tip = 1_000;
        i.estimate = Some(30_000);
        assert!(matches!(decide(&i), Bump(_)));
        // Same block, little change, but the deadline is near: go.
        i.estimate = Some(20_000);
        i.deadline = Deadline::Redeem {
            t1: 12,
            lock_confs: 9,
        };
        assert!(matches!(decide(&i), Bump(_)));
        // A longer interval is respected.
        i.deadline = Deadline::Redeem {
            t1: 12,
            lock_confs: 3,
        };
        i.params.min_interval_blocks = 3;
        i.tip = 1_002;
        assert_eq!(decide(&i), Hold(HoldReason::RateLimited));
        i.tip = 1_003;
        assert!(matches!(decide(&i), Bump(_)));
    }

    #[test]
    fn nothing_valid_fits_when_the_payout_is_gone() {
        let mut i = base();
        i.params.payout = 28_000;
        i.estimate = Some(900_000);
        i.deadline = Deadline::Redeem {
            t1: 12,
            lock_confs: 11,
        };
        // The last child already took all but dust: no valid replacement exists.
        i.child = Some(ChildSnapshot {
            txid: txid(7),
            fee: 28_000 - 330,
            vsize: 111,
            in_mempool: true,
        });
        i.last_bump_height = Some(900);
        assert_eq!(decide(&i), Exhausted(ExhaustedReason::NoRoom));
        // A payout that cannot even pay the floor for a child.
        let mut j = base();
        j.params.payout = 400;
        j.estimate = Some(900_000);
        assert_eq!(decide(&j), Exhausted(ExhaustedReason::NoRoom));
        // One where only the replacement increment does not fit.
        let mut k = base();
        k.estimate = Some(900_000);
        k.params.payout = 5_000;
        k.deadline = Deadline::Redeem {
            t1: 12,
            lock_confs: 11,
        };
        k.child = Some(ChildSnapshot {
            txid: txid(8),
            fee: 4_600,
            vsize: 111,
            in_mempool: true,
        });
        assert_eq!(decide(&k), Exhausted(ExhaustedReason::NoRoom));
    }

    #[test]
    fn refund_and_punish_use_their_own_deadlines() {
        let mut i = base();
        i.estimate = Some(60_000);
        i.deadline = Deadline::Refund {
            t2: 24,
            cancel_confs: 4,
        };
        let early = plan(decide(&i));
        assert_eq!(early.blocks_left, 19);
        i.deadline = Deadline::Refund {
            t2: 24,
            cancel_confs: 21,
        };
        let late = plan(decide(&i));
        assert!(late.urgent && late.target_rate > early.target_rate);
        // tx_punish has no deadline: never urgent, so never above the soft cap (10% of 28k).
        i.params.payout = 28_000;
        i.deadline = Deadline::Liveness;
        let p = plan(decide(&i));
        assert!(!p.urgent);
        assert_eq!(p.child_fee, 2_800);
    }

    #[test]
    fn a_parent_in_the_mempool_with_unconfirmed_ancestors_is_judged_as_a_whole() {
        // Ancestors that drag the package down: 3_000 sat over 400 vB (7.5 sat/vB).
        let mut i = base();
        i.parent.mempool = Some(Ancestry {
            fee: 3_000,
            vsize: 400,
        });
        i.estimate = Some(10_000);
        let p = plan(decide(&i));
        // want 12 sat/vB over (400 + 111) vB.
        assert_eq!(p.child_fee, fee_for(12_000, 511) - 3_000);
    }

    mod props {
        use super::*;
        use proptest::prelude::*;

        prop_compose! {
            fn floors()(min_relay in 100u64..5_000, extra in 0u64..200_000, inc in 100u64..5_000)
                -> FeeFloors {
                FeeFloors { min_relay, mempool_min: min_relay + extra, incremental: inc }
            }
        }

        prop_compose! {
            fn params()(
                payout in 1_000u64..20_000_000,
                dust in 294u64..3_300,
                soft in 1u64..60,
                urgent_blocks in 0u32..5,
                interval in 0u64..4,
                child_vsize in 100u64..140,
            ) -> Params {
                Params {
                    child_vsize,
                    payout: payout.max(dust + 1),
                    dust,
                    soft_cap_percent: soft,
                    urgent_blocks,
                    min_interval_blocks: interval,
                }
            }
        }

        prop_compose! {
            fn child()(
                n in any::<u8>(),
                fee in 1u64..2_000_000,
                vsize in 100u64..140,
                in_mempool in any::<bool>(),
            ) -> ChildSnapshot {
                ChildSnapshot { txid: txid(n), fee, vsize, in_mempool }
            }
        }

        prop_compose! {
            fn parent()(
                vsize in 100u64..400,
                base_fee in 100u64..60_000,
                in_mempool in any::<bool>(),
                extra_fee in 0u64..30_000,
                extra_vsize in 0u64..600,
            ) -> ParentSnapshot {
                ParentSnapshot {
                    vsize,
                    base_fee,
                    mempool: in_mempool.then_some(Ancestry {
                        fee: base_fee + extra_fee,
                        vsize: vsize + extra_vsize,
                    }),
                }
            }
        }

        fn deadline() -> impl Strategy<Value = Deadline> {
            prop_oneof![
                (6u32..40, 0u32..45)
                    .prop_map(|(t1, lock_confs)| Deadline::Redeem { t1, lock_confs }),
                (6u32..40, 0u32..45)
                    .prop_map(|(t2, cancel_confs)| Deadline::Refund { t2, cancel_confs }),
                Just(Deadline::Liveness),
            ]
        }

        prop_compose! {
            fn input()(
                deadline in deadline(),
                parent in parent(),
                confs in prop_oneof![9 => Just(0u32), 1 => 1u32..4],
                child in proptest::option::of(child()),
                params in params(),
                floors in floors(),
                estimate in proptest::option::of(0u64..2_000_000),
                packages in any::<bool>(),
                tip in 1_000u64..1_100,
                last in proptest::option::of(990u64..1_100),
            ) -> BumpInput {
                BumpInput {
                    deadline, parent, parent_confirmations: confs, child, params, floors,
                    estimate, packages, tip, last_bump_height: last,
                }
            }
        }

        proptest! {
            #![proptest_config(ProptestConfig { cases: 4_000, ..ProptestConfig::default() })]

            /// A fee is never lowered, and never above the cap; the child's output stays above
            /// dust; a replacement obeys BIP125's incremental-fee and feerate rules.
            #[test]
            fn every_bump_is_valid(i in input()) {
                if let Bump(p) = decide(&i) {
                    let inc = i.floors.incremental.max(1);
                    let cv = i.params.child_vsize;
                    prop_assert!(i.parent_confirmations == 0);
                    // The cap, and dust.
                    prop_assert!(p.child_fee <= cap(&i.params, p.urgent), "over the cap");
                    prop_assert!(p.child_fee <= i.params.payout - i.params.dust, "output below dust");
                    // The child alone clears the node's floor (plus an increment).
                    prop_assert!(p.child_fee >= fee_for(i.floors.floor() + inc, cv));
                    // A child the node dropped still sets the least a new one pays.
                    if let Some(c) = i.child {
                        prop_assert!(p.child_fee >= c.fee, "lowered a fee");
                    }
                    match p.mode {
                        SubmitMode::Replace(txid) => {
                            let old = i.child.unwrap();
                            prop_assert!(old.in_mempool && old.txid == txid && i.parent.mempool.is_some());
                            // Rule 3 and 4.
                            prop_assert!(p.child_fee >= old.fee + fee_for(inc, cv));
                            // Rule 6: a higher feerate than the child it replaces.
                            prop_assert!(
                                u128::from(p.child_fee) * u128::from(old.vsize)
                                    > u128::from(old.fee) * u128::from(cv)
                            );
                        }
                        SubmitMode::Send => prop_assert!(i.parent.mempool.is_some()),
                        SubmitMode::Package => {
                            prop_assert!(i.parent.mempool.is_none() && i.packages);
                        }
                    }
                    // Uncapped, the package pays at least the wanted rate.
                    if !p.capped {
                        let base = i.parent.mempool.map_or((i.parent.base_fee, i.parent.vsize),
                            |m| (m.fee, m.vsize));
                        prop_assert!(rate_of(base.0 + p.child_fee, base.1 + cv) >= p.target_rate);
                    }
                }
            }

            /// As the deadline nears the price offered and the cap only rise.
            #[test]
            fn urgency_only_escalates(i in input(), a in 0u32..40, b in 0u32..40) {
                let (near, far) = (a.min(b), a.max(b));
                let est = i.estimate;
                let floor = i.floors.floor();
                let inc = i.floors.incremental.max(1);
                prop_assert!(want_rate(est, floor, inc, near) >= want_rate(est, floor, inc, far));
                let urgent = |left: u32| left <= i.params.urgent_blocks;
                prop_assert!(cap(&i.params, urgent(near)) >= cap(&i.params, urgent(far)));
                prop_assert!(margin_permille(near) >= margin_permille(far));
            }

            /// Fixing everything but the deadline, a nearer deadline offers at least as much.
            #[test]
            fn a_nearer_deadline_never_offers_less(i in input(), lock_a in 0u32..45, lock_b in 0u32..45) {
                let (early, late) = (lock_a.min(lock_b), lock_a.max(lock_b));
                let at = |lock_confs| BumpInput {
                    deadline: Deadline::Redeem { t1: 30, lock_confs },
                    last_bump_height: None,
                    ..i
                };
                if let (Bump(e), Bump(l)) = (decide(&at(early)), decide(&at(late))) {
                    prop_assert!(l.target_rate >= e.target_rate);
                    prop_assert!(l.child_fee >= e.child_fee);
                }
            }

            /// After a bump is sent, deciding again on the same block finds nothing further to
            /// do (the package pays the target, or the cap is reached, or it is rate limited):
            /// the planner makes progress and never spins or lowers a fee.
            #[test]
            fn a_bump_settles(i in input()) {
                if let Bump(p) = decide(&i) {
                    let sent = ChildSnapshot {
                        txid: txid(200),
                        fee: p.child_fee,
                        vsize: i.params.child_vsize,
                        in_mempool: true,
                    };
                    let parent = ParentSnapshot {
                        mempool: i.parent.mempool.or(Some(Ancestry {
                            fee: i.parent.base_fee,
                            vsize: i.parent.vsize,
                        })),
                        ..i.parent
                    };
                    let after = BumpInput {
                        child: Some(sent),
                        parent,
                        last_bump_height: Some(i.tip),
                        ..i
                    };
                    match decide(&after) {
                        Hold(_) | Exhausted(_) => {}
                        Bump(q) => {
                            // Only when urgent or the target jumped, and then strictly more.
                            prop_assert!(q.child_fee > p.child_fee);
                            prop_assert!(q.child_fee >= p.child_fee + fee_for(i.floors.incremental.max(1), i.params.child_vsize));
                        }
                    }
                }
            }

            /// A confirmed parent never bumps; no packages never package-submits.
            #[test]
            fn the_gates_hold(i in input()) {
                let d = decide(&i);
                if i.parent_confirmations > 0 {
                    prop_assert_eq!(d, Hold(HoldReason::Confirmed));
                }
                if i.parent.mempool.is_none() && !i.packages && i.parent_confirmations == 0 {
                    prop_assert_eq!(d, Hold(HoldReason::NeedsPackage));
                }
                if i.parent.mempool.is_none()
                    && i.packages
                    && i.parent_confirmations == 0
                    && i.parent.base_fee < fee_for(i.floors.min_relay, i.parent.vsize)
                {
                    prop_assert_eq!(d, Exhausted(ExhaustedReason::ParentBelowMinRelay));
                }
                if let Bump(p) = d {
                    prop_assert!(p.mode != SubmitMode::Package || i.packages);
                }
            }
        }
    }
}
