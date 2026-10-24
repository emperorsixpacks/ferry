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
use ferry_btc::rpc::PackageError;
use ferry_core::{BState, ZState};

use super::*;
use crate::bump::{self, decide, Ancestry, BumpDecision, BumpInput, ChildSnapshot, Deadline};
use crate::bump::{ExhaustedReason, HoldReason, ParentSnapshot, SubmitMode};
use crate::config::BumpMode;
use crate::record::BumpState;

/// A file with this name in the data directory stops all bumping at the next tick, without a
/// restart. `--bump off` (the default) does the same from the start.
const KILL_FILE: &str = "bump-off";

/// Whether bumping is on: `--bump on`, no kill file, and not a main network. (ferryd does not even
/// start with `--bump on` on a mainnet, `Cli::check_bump`; this is the second lock on the same
/// door, until the outside review of the bump is done.)
pub(super) fn bump_on(mode: BumpMode, network: Network, data_dir: &Path) -> bool {
    mode == BumpMode::On && network != Network::Bitcoin && !data_dir.join(KILL_FILE).exists()
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

/// Whether the spend is urgent: a redeem or refund with at most `window` blocks left before its
/// deadline. A punish has no deadline and never is, whatever the window. Worked out here from the
/// spend itself, apart from the planner's answer, for the fee cap and the retry gate: an urgency
/// mistake in the planner then meets a cap that did not make it.
fn is_urgent(spend: Spend, blocks_left: u32, window: u32) -> bool {
    matches!(spend, Spend::Redeem | Spend::Refund) && blocks_left <= window
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

/// The most notes one spend's bump may write to the timeline.
const MAX_NOTES: usize = 16;

/// Write `label` to the timeline once per `key` for this spend, and at most [`MAX_NOTES`] times.
fn note_once(rec: &mut SwapRecord, st: &mut BumpState, key: &str, label: String) {
    if st.noted.len() < MAX_NOTES && !st.noted.iter().any(|k| k == key) {
        st.noted.push(key.to_string());
        rec.log("btc", "fee_bump_note", label, None);
    }
}

/// What a node's refusal says, without the numbers and txids it carries, so the same refusal is
/// one note: "insufficient fee, rejecting replacement ab12..., not enough ..." is "insufficient fee".
fn reason_code(why: &str) -> String {
    why.split([',', ';', '('])
        .next()
        .unwrap_or(why)
        .trim()
        .chars()
        .take(60)
        .collect()
}

/// The node's own text of an answer that refused something, without the "rpc <method> error <code>"
/// that [`RpcError`]'s display adds.
fn refusal_text(e: &RpcError) -> String {
    match e {
        RpcError::Rpc { message, .. } => message.clone(),
        other => other.to_string(),
    }
}

impl<L: ZecLeg + 'static> Daemon<L> {
    /// One look at the spend we wait on: bump it if the rules say so. Any node error ends the
    /// look; the next tick tries again.
    pub(super) async fn bump(&self, rec: &mut SwapRecord) {
        if !bump_on(self.cli.bump, self.cli.network, &self.cli.data_dir) {
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
        // In the node's mempool means the node took it and the counterparty can see it, however
        // it got there (our package, a crash before this was saved): it counts as sent.
        if entry.is_some() {
            self.mark_announced(rec, parent_tx);
        }
        let announced = announced || entry.is_some();
        // A spend the node does not hold goes back in as a package only if the node took it
        // before (the counterparty may have seen it) or the timing rules still allow a first
        // broadcast. Otherwise a bump would reveal what the rebroadcaster is told not to.
        let may_package = announced || decision == RebroadcastDecision::Send;
        if entry.is_none() && !may_package {
            return Ok(());
        }
        let tip = self.rpc.block_count().await?;
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
        let urgent = is_urgent(spend, deadline.blocks_left(), self.cli.bump_urgent_blocks);
        // A bump the node refused is not tried again within the same block, unless time is short:
        // a refusal can come from a floor that moved between reading it and sending, and the next
        // tick reads it again. (The reason is written to the timeline once either way.)
        if st.refused_height == Some(tip) && !urgent {
            return Ok(());
        }
        let floors = self.rpc.fee_floors().await?;
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
                             ({}% of the payout); {}",
                            self.cli.bump_soft_cap_percent,
                            if spend == Spend::Punish {
                                "a penalty has no deadline, so the cap stays"
                            } else {
                                "the cap rises as the deadline nears"
                            }
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
        // What the child may pay: the cap (the soft cap, or the payout less dust when time is
        // short), from the urgency worked out above rather than the planner's. That is the one
        // limit on what a bump costs. The fee-rate ceiling, which the node enforces too as
        // maxfeerate, is not a second one: it always admits the planned child. A child pays for
        // its parent too, so its own rate is about 2.5x the wanted package rate for a parent of
        // its size, and more for a parent that has unconfirmed ancestors to carry; the ceiling is
        // the larger of three times the wanted rate, twice the last child's rate, and the
        // planned child's own rate with a margin.
        let inc = floors.incremental.max(1);
        let planned_rate = rate_of(plan.child_fee, child_vsize);
        let ceiling = plan
            .target_rate
            .saturating_mul(3)
            .saturating_add(inc.saturating_mul(2))
            .max(rate_of(st.child_fee, st.child_vsize).saturating_mul(2))
            .max(
                planned_rate
                    .saturating_add(planned_rate / 8)
                    .saturating_add(inc),
            );
        let limits = ChildLimits {
            max_fee: Amount::from_sat(bump::cap(&bump_params, urgent)),
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
            // The node answered with a refusal (a locked wallet: -13): the same answer until
            // something changes, so try again at the next block, and say why once.
            Err(ChildError::Rpc(e @ RpcError::Rpc { .. })) => {
                let why = refusal_text(&e);
                let what = format!("would not sign the fee bump of {name} ({why})");
                return self.refused(rec, st, tip, &what, &why);
            }
            // The node could not be asked: nothing was refused, so try again at the next tick.
            Err(ChildError::Rpc(e)) => return Err(e.into()),
            // Refused by our own checks (a cap, dust, a locked coin, a larger signature): the same
            // answer until something changes, so wait for the next block.
            Err(e) => {
                st.refused_height = Some(tip);
                return Err(e.into());
            }
        };

        // Ask the node first, with the same ceiling it will enforce. A package cannot be asked:
        // Bitcoin Core's testmempoolaccept judges each transaction of it on its own fee, so it
        // refuses exactly the parent that the child is there to lift. submitpackage applies the
        // package feerate, and carries the same ceiling as maxfeerate. A replacement of our
        // child is asked too; a node that does not replace answers "txn-mempool-conflict" to any
        // replacement, so that answer is not a verdict and the send decides.
        let package = plan.mode == SubmitMode::Package;
        if !package {
            let verdicts = self
                .rpc
                .test_accept(std::slice::from_ref(&built.tx), Some(ceiling))
                .await?;
            let replacing = matches!(plan.mode, SubmitMode::Replace(_));
            let no = verdicts.iter().find(|v| match v.reject_reason.as_deref() {
                _ if v.allowed => false,
                Some("txn-mempool-conflict") => !replacing,
                _ => true,
            });
            if let Some(no) = no {
                let why = no.reject_reason.clone().unwrap_or_default();
                let what = format!("would not take the fee bump of {name} ({why})");
                return self.refused(rec, st, tip, &what, &why);
            }
        }

        let child_txid = built.tx.compute_txid();
        if package && self.rpc.tx_mined(&parent_txid, 0).await? {
            // The parent was mined since this tick began, alone or with our earlier child (which
            // spent its output, so gettxout alone would miss it). A package whose parent is
            // already in a block fails as a whole (the parent is "already known"), and there is
            // nothing left to lift: the next tick sees the parent confirmed and stops.
            return Ok(());
        }
        // What the node says to the real send. An answer from the node that refuses it is a
        // refusal, tried again at the next block; a node that cannot be reached is an error.
        let refusal = if package {
            match self
                .rpc
                .submit_package(&[parent_tx.clone(), built.tx.clone()], Some(ceiling))
                .await
            {
                Ok(sent) if sent.success => None,
                // The parent's own error says why; the child's is usually "missing inputs",
                // because its parent did not go in.
                Ok(sent) => Some(
                    sent.errors
                        .iter()
                        .find(|(t, _)| *t == parent_txid)
                        .or_else(|| sent.errors.first())
                        .map(|(_, e)| e.clone())
                        .unwrap_or(sent.message),
                ),
                Err(PackageError::Rpc(e @ RpcError::Rpc { .. })) => Some(refusal_text(&e)),
                Err(e) => return Err(e.into()),
            }
        } else {
            match self.rpc.broadcast_capped(&built.tx, ceiling).await {
                Ok(_) => None,
                Err(e @ RpcError::Rpc { .. }) => Some(refusal_text(&e)),
                Err(e) => return Err(e.into()),
            }
        };
        if package && matches!(self.rpc.mempool_entry(&parent_txid).await, Ok(Some(_))) {
            // The parent is in the mempool now, whether or not its child got in with it: it has
            // been sent, so it is announced, as if the node had taken it alone.
            self.mark_announced(rec, parent_tx);
        }
        if let Some(why) = refusal {
            let what = if package {
                format!("would not take {name} with its child as a package ({why})")
            } else {
                format!("would not take the fee bump of {name} ({why})")
            };
            return self.refused(rec, st, tip, &what, &why);
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
            SubmitMode::Replace(_) => "replaced the previous child",
            SubmitMode::Package => {
                "sent it with a child as a package, because the node's mempool had dropped it"
            }
        };
        rec.log(
            "btc",
            "fee_bump",
            format!(
                "Raised the fee of {name}: {how}, the child paying {} sat out of its own payout and \
                 taking the pair to {} sat/vB (wanted {}; {} block{} before its deadline){}",
                st.child_fee,
                per_vb(st.package_rate),
                per_vb(plan.target_rate),
                plan.blocks_left,
                if plan.blocks_left == 1 { "" } else { "s" },
                if plan.capped { ", held at the fee cap" } else { "" },
            ),
            Some(child_txid.to_string()),
        );
        Ok(())
    }
}

impl<L: ZecLeg + 'static> Daemon<L> {
    /// The node refused our child: remember the block, write the reason once, and try again at
    /// the next block.
    fn refused(
        &self,
        rec: &mut SwapRecord,
        st: &mut BumpState,
        tip: u64,
        what: &str,
        why: &str,
    ) -> anyhow::Result<()> {
        st.refused_height = Some(tip);
        let hint = if why.contains("txn-mempool-conflict") {
            " (this node does not replace transactions: litecoind needs -mempoolreplacement=1, \
              so the child stays at the fee it has)"
        } else {
            ""
        };
        note_once(
            rec,
            st,
            &format!("refused:{}", reason_code(why)),
            format!("The node {what}{hint}; trying again at the next block"),
        );
        Ok(())
    }

    /// Record that `parent_tx` has been sent (the node holds it): its entry in the rebroadcast set
    /// becomes `announced` and the timeline gets its broadcast line, as `try_broadcast` does when
    /// the node takes a spend alone.
    fn mark_announced(&self, rec: &mut SwapRecord, parent_tx: &Transaction) {
        let txid = parent_tx.compute_txid();
        if let Some(r) = rec
            .rebroadcast
            .iter_mut()
            .find(|r| r.tx.compute_txid() == txid)
        {
            if !r.announced {
                r.announced = true;
                self.narrate_broadcast(rec, parent_tx, txid);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::tests::sample_record;

    #[test]
    fn the_kill_switch_stops_bumping_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let reg = Network::Regtest;
        // Off by default, and off means off.
        assert!(!bump_on(BumpMode::Off, reg, dir.path()));
        assert!(bump_on(BumpMode::On, reg, dir.path()));
        // The file stops a running daemon at its next tick, no restart; removing it lets it on.
        let kill = dir.path().join(KILL_FILE);
        std::fs::write(&kill, "").unwrap();
        assert!(!bump_on(BumpMode::On, reg, dir.path()));
        assert!(!bump_on(BumpMode::Off, reg, dir.path()));
        std::fs::remove_file(&kill).unwrap();
        assert!(bump_on(BumpMode::On, reg, dir.path()));
    }

    /// The second lock on the mainnet door: whatever the flag says, a main network never bumps.
    #[test]
    fn a_main_network_never_bumps() {
        let dir = tempfile::tempdir().unwrap();
        for net in [Network::Regtest, Network::Testnet, Network::Signet] {
            assert!(bump_on(BumpMode::On, net, dir.path()), "{net}");
        }
        assert!(!bump_on(BumpMode::On, Network::Bitcoin, dir.path()));
        assert!(!bump_on(BumpMode::Off, Network::Bitcoin, dir.path()));
    }

    /// The cap and the retry gate work urgency out from the spend, not from the planner: a
    /// penalty is never urgent, whatever the window (the flag allows 0 to 5; this must not rely
    /// on it).
    #[test]
    fn only_a_redeem_or_refund_near_its_deadline_is_urgent() {
        for window in [0, 2, 5, 6, 7, 40] {
            for left in [0, 1, 2, 5, 6, 7, 100] {
                assert!(
                    !is_urgent(Spend::Punish, left, window),
                    "punish {left} {window}"
                );
                assert!(
                    !is_urgent(Spend::Cancel, left, window),
                    "cancel {left} {window}"
                );
                for spend in [Spend::Redeem, Spend::Refund] {
                    assert_eq!(
                        is_urgent(spend, left, window),
                        left <= window,
                        "{spend:?} {left} {window}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_refusal_is_one_note_whatever_numbers_it_carries() {
        // Core's texts carry txids and amounts that change with every attempt.
        assert_eq!(
            reason_code("insufficient fee, rejecting replacement ab12cd, not enough additional fees to relay; 100 < 111"),
            "insufficient fee"
        );
        assert_eq!(
            reason_code("min relay fee not met, 2000 < 3330"),
            "min relay fee not met"
        );
        assert_eq!(reason_code("txn-mempool-conflict"), "txn-mempool-conflict");
        assert_eq!(
            reason_code("  mempool min fee not met, 1 < 2  "),
            "mempool min fee not met"
        );
        assert_eq!(reason_code(&"x".repeat(200)).len(), 60);
        let e = RpcError::Rpc {
            method: "sendrawtransaction".into(),
            code: -26,
            message: "insufficient fee, rejecting replacement".into(),
        };
        assert_eq!(refusal_text(&e), "insufficient fee, rejecting replacement");
    }

    #[test]
    fn notes_are_written_once_and_at_most_sixteen_times() {
        let mut rec = sample_record();
        let mut st = BumpState::default();
        note_once(&mut rec, &mut st, "a", "first".into());
        note_once(&mut rec, &mut st, "a", "again".into());
        assert_eq!(rec.timeline.len(), 1);
        for i in 0..40 {
            note_once(&mut rec, &mut st, &format!("k{i}"), format!("note {i}"));
        }
        assert_eq!(rec.timeline.len(), MAX_NOTES);
        assert_eq!(st.noted.len(), MAX_NOTES);
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
