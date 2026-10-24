//! Raising the fee of our own stuck presigned spend (`--bump on`).
//!
//! The rules are in [`crate::bump`] and are pure; this reads what they need from the node and the
//! record, builds the child (`ferry_btc::child`), tests it with the node, sends it, and writes
//! what happened to the record and the timeline. It runs from the tick after the rebroadcast,
//! only while the swap waits on tx_redeem (Z, `Redeeming`), tx_refund (B, `Refunding`) or
//! tx_punish (Z, `Punishing`), and only while that spend is unconfirmed and still possible. It
//! never goes beyond what the first broadcast could: a spend the node never accepted and that
//! the timing rules no longer allow is left to the rebroadcaster, which will not send it.
//!
//! Not built here: a third-party `payout_to` (the redeem then pays an address that is not ours,
//! so there is no output of ours to bump from), and tx_cancel (liveness only, never bumped).

use std::path::Path;

use ferry_btc::bitcoin::{Amount, ScriptBuf};
use ferry_btc::child::{build_child, rate_of, vsize_bound, ChildError, ChildLimits};
use ferry_core::{BState, ZState};

use super::*;
use crate::bump::{self, decide, Ancestry, BumpDecision, BumpInput, ChildSnapshot, Deadline};
use crate::bump::{ExhaustedReason, HoldReason, ParentSnapshot, SubmitMode};
use crate::config::BumpMode;
use crate::record::BumpState;

/// A file with this name in the data directory stops all bumping at the next tick, without a
/// restart. `--bump off` (the default) does the same from the start.
const KILL_FILE: &str = "bump-off";

/// Whether bumping is on: `--bump on` and no kill file.
pub(super) fn bump_on(mode: BumpMode, data_dir: &Path) -> bool {
    mode == BumpMode::On && !data_dir.join(KILL_FILE).exists()
}

/// The spend this swap is waiting on, if it is one we may bump: Z's redeem or punish, B's refund.
pub(super) fn live_spend(swap: &Swap) -> Option<Spend> {
    match swap {
        Swap::Z(z) if z.state == ZState::Redeeming => Some(Spend::Redeem),
        Swap::Z(z) if z.state == ZState::Punishing => Some(Spend::Punish),
        Swap::B(b) if b.state == BState::Refunding => Some(Spend::Refund),
        _ => None,
    }
}

fn spend_name(spend: Spend) -> &'static str {
    match spend {
        Spend::Cancel => "tx_cancel",
        Spend::Redeem => "tx_redeem",
        Spend::Refund => "tx_refund",
        Spend::Punish => "tx_punish",
    }
}

/// sat/vB with one decimal, from the node's sat per kvB.
fn per_vb(rate: u64) -> String {
    format!("{:.1}", rate as f64 / 1000.0)
}

/// Write `label` to the timeline once per `key` for this spend.
fn note_once(rec: &mut SwapRecord, st: &mut BumpState, key: &str, label: String) {
    if !st.noted.iter().any(|k| k == key) {
        st.noted.push(key.to_string());
        rec.log("btc", "fee_bump_note", label, None);
    }
}

impl<L: ZecLeg + 'static> Daemon<L> {
    /// One look at the spend we wait on: bump it if the rules say so. Any node error ends the
    /// look; the next tick tries again.
    pub(super) async fn bump(&self, rec: &mut SwapRecord) {
        if !bump_on(self.cli.bump, &self.cli.data_dir) {
            return;
        }
        let Some(spend) = live_spend(&rec.swap) else {
            return;
        };
        if let Err(e) = self.bump_spend(rec, spend).await {
            tracing::warn!(id = %rec.id, "fee bump of {}: {e:#}", spend_name(spend));
        }
    }

    async fn bump_spend(&self, rec: &mut SwapRecord, spend: Spend) -> anyhow::Result<()> {
        let Ok(Some((lock, txs, confs))) = self.spend_confs(rec).await else {
            return Ok(());
        };
        let Some(r) = rec
            .rebroadcast
            .iter()
            .find(|r| txs.classify(&r.tx) == Some(spend))
        else {
            // Buried (the rebroadcaster forgot it) or never sent.
            return Ok(());
        };
        let (parent_tx, announced) = (r.tx.clone(), r.announced);
        let parent_txid = parent_tx.compute_txid();
        let confirmed = |t: &Txid| confs.get(t).is_some_and(|c| *c >= 1);
        // The spend, or the one that excludes it, is on chain: nothing left to bump.
        let excluded_by = match spend {
            Spend::Redeem => txs.txid(Spend::Cancel),
            Spend::Refund => txs.txid(Spend::Punish),
            _ => txs.txid(Spend::Refund),
        };
        if confirmed(&parent_txid) || confirmed(&excluded_by) {
            return Ok(());
        }

        let mut st = match rec.bump.take() {
            Some(s) if s.parent == Some(parent_txid) => s,
            _ => BumpState {
                parent: Some(parent_txid),
                ..Default::default()
            },
        };
        let result = self
            .bump_with(
                rec, &mut st, spend, &parent_tx, announced, lock.txid, &txs, &confs,
            )
            .await;
        rec.bump = Some(st);
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn bump_with(
        &self,
        rec: &mut SwapRecord,
        st: &mut BumpState,
        spend: Spend,
        parent_tx: &Transaction,
        announced: bool,
        lock: Txid,
        txs: &ferry_btc::SwapTxs,
        confs: &HashMap<Txid, u32>,
    ) -> anyhow::Result<()> {
        let name = spend_name(spend);
        let parent_txid = parent_tx.compute_txid();
        if spend == Spend::Redeem && rec.payout_to.is_some() {
            note_once(
                rec,
                st,
                "third_party_payout",
                format!(
                    "{name} pays a third-party address, so there is no output of ours to raise its \
                     fee from. It stays at its presigned fee"
                ),
            );
            return Ok(());
        }
        let params = rec.swap.session().params.clone();
        let rebroadcaster = Rebroadcaster {
            params: &params,
            lock,
            txs,
            confs,
        };
        let decision = rebroadcaster.decide(parent_tx);
        if decision == RebroadcastDecision::Done {
            return Ok(());
        }
        let entry = self.rpc.mempool_entry(&parent_txid).await?;
        // A spend the node does not hold goes back in as a package only if the node took it
        // before (the counterparty may have seen it) or the timing rules still allow a first
        // broadcast. Otherwise a bump would reveal what the rebroadcaster is told not to.
        let may_package = announced || decision == RebroadcastDecision::Send;
        if entry.is_none() && !may_package {
            return Ok(());
        }
        let tip = self.rpc.block_count().await?;
        if st.refused_height == Some(tip) {
            return Ok(());
        }
        let floors = self.rpc.fee_floors().await?;
        let cancel = txs.txid(Spend::Cancel);
        let deadline = match spend {
            Spend::Redeem => Deadline::Redeem {
                t1: params.t1.into(),
                lock_confs: confs.get(&lock).copied().unwrap_or(0),
            },
            Spend::Refund => Deadline::Refund {
                t2: params.t2.into(),
                cancel_confs: confs.get(&cancel).copied().unwrap_or(0),
            },
            _ => Deadline::Liveness,
        };
        let target = deadline.blocks_left().clamp(1, 1008) as u16;
        // No estimate (a node without data, a fresh one) is not an error: the floors still apply.
        let estimate = self.rpc.estimate_fee_rate_kvb(target).await.unwrap_or(None);

        // The child we sent before: what the node holds, else what we recorded.
        let mut child = None;
        if let Some(e) = &entry {
            let held = st
                .child_txid
                .filter(|t| e.spent_by.contains(t))
                .or_else(|| e.spent_by.first().copied());
            if let Some(txid) = held {
                if let Some(ce) = self.rpc.mempool_entry(&txid).await? {
                    child = Some(ChildSnapshot {
                        txid,
                        fee: ce.base_fee.to_sat(),
                        vsize: ce.vsize,
                        in_mempool: true,
                    });
                }
            }
        }
        if child.is_none() {
            child = st.child_txid.map(|txid| ChildSnapshot {
                txid,
                fee: st.child_fee,
                vsize: st.child_vsize,
                in_mempool: false,
            });
        }

        let out = parent_tx
            .output
            .first()
            .ok_or_else(|| anyhow::anyhow!("{name} has no output"))?;
        let coin = self.cli.chain;
        let child_vsize = match vsize_bound(&out.script_pubkey, &out.script_pubkey) {
            Ok(v) => v,
            Err(e) => {
                note_once(rec, st, "unsized", format!("{name} cannot be bumped: {e}"));
                return Ok(());
            }
        };
        let payout = out.value.to_sat();
        let parent = ParentSnapshot {
            vsize: parent_tx.vsize() as u64,
            base_fee: txs.prevout(spend).value.to_sat().saturating_sub(payout),
            mempool: entry.as_ref().map(|e| Ancestry {
                fee: e.ancestor_fee.to_sat(),
                vsize: e.ancestor_vsize,
            }),
        };
        let bump_params = bump::Params {
            child_vsize,
            payout,
            dust: coin.dust(&out.script_pubkey).to_sat(),
            soft_cap_percent: self.cli.bump_soft_cap_percent,
            urgent_blocks: self.cli.bump_urgent_blocks,
            min_interval_blocks: self.cli.bump_min_interval_blocks,
        };
        let input = BumpInput {
            deadline,
            parent,
            parent_confirmations: 0,
            child,
            params: bump_params,
            floors,
            estimate,
            packages: coin.supports_packages(),
            tip,
            last_bump_height: st.last_height,
        };
        let plan = match decide(&input) {
            BumpDecision::Hold(reason) => {
                tracing::debug!(id = %rec.id, "fee bump of {name}: {reason}");
                if matches!(reason, HoldReason::SoftCap) {
                    note_once(
                        rec,
                        st,
                        "soft_cap",
                        format!(
                            "{name} is below the fee wanted and the child has reached the soft cap \
                             ({}% of the payout); the cap rises as the deadline nears",
                            self.cli.bump_soft_cap_percent
                        ),
                    );
                }
                return Ok(());
            }
            BumpDecision::Exhausted(reason) => {
                let (key, why) = match reason {
                    ExhaustedReason::NoRoom => (
                        "no_room",
                        "no further fee bump fits: the child has taken all of the payout it may",
                    ),
                    ExhaustedReason::ParentBelowMinRelay => (
                        "below_min_relay",
                        "the node does not hold it and its presigned fee is below the node's \
                         minimum relay fee, which no child can lift it over",
                    ),
                };
                note_once(rec, st, key, format!("{name} cannot be bumped: {why}"));
                return Ok(());
            }
            BumpDecision::Bump(plan) => plan,
        };

        // Where the child pays: one fresh address of our own wallet, kept for every child of this
        // spend (a replacement spends the same input, so it needs no new one).
        let pay_to = match st
            .pay_to
            .as_deref()
            .and_then(|h| ScriptBuf::from_hex(h).ok())
        {
            Some(spk) => spk,
            None => {
                let spk = self.rpc.new_address(self.network()).await?.script_pubkey();
                st.pay_to = Some(spk.to_hex_string());
                spk
            }
        };
        if vsize_bound(&out.script_pubkey, &pay_to).is_ok_and(|v| v > child_vsize) {
            note_once(
                rec,
                st,
                "output_type",
                format!("{name} cannot be bumped: our wallet's address is larger than the output it spends"),
            );
            return Ok(());
        }
        // Two independent guards besides the planner's own arithmetic: the child's fee may not
        // pass the cap, and its rate may not pass three times the wanted package rate (a child
        // pays for its parent too, so up to about 2.5x is normal), or twice the last child's.
        let inc = floors.incremental.max(1);
        let ceiling = plan
            .target_rate
            .saturating_mul(3)
            .saturating_add(inc.saturating_mul(2))
            .max(rate_of(st.child_fee, st.child_vsize).saturating_mul(2));
        let limits = ChildLimits {
            max_fee: Amount::from_sat(bump::cap(&bump_params, plan.urgent)),
            max_fee_rate: ceiling,
        };
        let built = match build_child(
            &self.rpc,
            parent_tx,
            0,
            &pay_to,
            Amount::from_sat(plan.child_fee),
            coin,
            &limits,
        )
        .await
        {
            Ok(b) => b,
            Err(ChildError::NotSigned) => {
                st.refused_height = Some(tip);
                note_once(
                    rec,
                    st,
                    "not_ours",
                    format!("{name} cannot be bumped: its output is not one this wallet can spend"),
                );
                return Ok(());
            }
            Err(e) => {
                st.refused_height = Some(tip);
                return Err(e.into());
            }
        };

        // Ask the node first, with the same ceiling it will enforce. A package cannot be asked:
        // Bitcoin Core's testmempoolaccept judges each transaction of it on its own fee, so it
        // refuses exactly the parent that the child is there to lift. submitpackage applies the
        // package feerate, and carries the same ceiling as maxfeerate.
        let package = plan.mode == SubmitMode::Package;
        if !package {
            let verdicts = self
                .rpc
                .test_accept(std::slice::from_ref(&built.tx), Some(ceiling))
                .await?;
            if let Some(no) = verdicts.iter().find(|v| !v.allowed) {
                st.refused_height = Some(tip);
                let why = no.reject_reason.clone().unwrap_or_default();
                note_once(
                    rec,
                    st,
                    &format!("refused:{why}"),
                    format!(
                        "The node would not take the fee bump of {name} ({why}); trying again at the next block"
                    ),
                );
                return Ok(());
            }
        }

        let child_txid = built.tx.compute_txid();
        if package {
            let sent = self
                .rpc
                .submit_package(&[parent_tx.clone(), built.tx.clone()], Some(ceiling))
                .await?;
            if !sent.success {
                st.refused_height = Some(tip);
                let why = sent
                    .errors
                    .first()
                    .map(|(_, e)| e.clone())
                    .unwrap_or(sent.message);
                note_once(
                    rec,
                    st,
                    &format!("refused:{why}"),
                    format!("The node would not take {name} with its child as a package ({why}); trying again at the next block"),
                );
                return Ok(());
            }
            // The parent went in through the package: it is announced now, as if sent alone.
            if let Some(r) = rec
                .rebroadcast
                .iter_mut()
                .find(|r| r.tx.compute_txid() == parent_txid)
            {
                if !r.announced {
                    r.announced = true;
                    self.narrate_broadcast(rec, parent_tx, parent_txid);
                }
            }
        } else {
            self.rpc.broadcast_capped(&built.tx, ceiling).await?;
        }

        let base = parent.mempool.unwrap_or(Ancestry {
            fee: parent.base_fee,
            vsize: parent.vsize,
        });
        st.child_txid = Some(child_txid);
        st.child_fee = built.fee.to_sat();
        st.child_vsize = built.vsize;
        st.package_rate = rate_of(base.fee + st.child_fee, base.vsize + built.vsize);
        st.attempts += 1;
        st.last_height = Some(tip);
        st.refused_height = None;
        let how = match plan.mode {
            SubmitMode::Send => "sent a child",
            SubmitMode::Replace(_) => "replaced its child with a better one",
            SubmitMode::Package => {
                "sent it with a child as a package, as the node's mempool had dropped it"
            }
        };
        rec.log(
            "btc",
            "fee_bump",
            format!(
                "Raised the fee of {name}: {how} paying {} sat out of its own payout, taking the pair to \
                 {} sat/vB (wanted {}; {} blocks before its deadline){}",
                st.child_fee,
                per_vb(st.package_rate),
                per_vb(plan.target_rate),
                plan.blocks_left,
                if plan.capped { ", held at the fee cap" } else { "" },
            ),
            Some(child_txid.to_string()),
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::tests::sample_record;

    #[test]
    fn the_kill_switch_stops_bumping_at_once() {
        let dir = tempfile::tempdir().unwrap();
        // Off by default, and off means off.
        assert!(!bump_on(BumpMode::Off, dir.path()));
        assert!(bump_on(BumpMode::On, dir.path()));
        // The file stops a running daemon at its next tick, no restart; removing it lets it on.
        let kill = dir.path().join(KILL_FILE);
        std::fs::write(&kill, "").unwrap();
        assert!(!bump_on(BumpMode::On, dir.path()));
        assert!(!bump_on(BumpMode::Off, dir.path()));
        std::fs::remove_file(&kill).unwrap();
        assert!(bump_on(BumpMode::On, dir.path()));
    }

    #[test]
    fn only_the_spends_we_wait_on_are_bumped() {
        // The record is B's, the maker's; Z's states are covered by the regtest swaps.
        let mut rec = sample_record();
        for (state, want) in [
            (BState::Refunding, Some(Spend::Refund)),
            (BState::Cancelled, None),
            (BState::RedeemSigSent, None),
            (BState::BtcRedeemed, None),
            (BState::Refunded, None),
            (BState::Punished, None),
        ] {
            let Swap::B(b) = &mut rec.swap else {
                panic!("sample record is B's")
            };
            b.state = state.clone();
            assert_eq!(live_spend(&rec.swap), want, "{state:?}");
        }
    }

    #[test]
    fn rates_read_in_sat_per_vbyte() {
        assert_eq!(per_vb(1_000), "1.0");
        assert_eq!(per_vb(72_500), "72.5");
        assert_eq!(per_vb(100), "0.1");
    }
}
