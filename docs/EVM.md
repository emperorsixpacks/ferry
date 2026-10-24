# Ferry on EVM: shielded ZEC ↔ USDC (draft)

The Zcash side of Ferry stays the same: Z locks ZEC in the Ironwood pool to the joint key
`ask = σ(z + b)`. The counter-asset is an ERC-20 (USDC) held by the `FerryLock` contract
(`contracts/src/FerryLock.sol`) instead of a Taproot output. The public testnet is Base Sepolia,
and local runs use anvil.

| | holds | wants |
|---|---|---|
| **Z** | shielded ZEC | USDC |
| **B** | USDC | shielded ZEC |

Status: the contract, its tests and the `ferry-evm` client crate are done (phase 1). The
ferry-core state machines, ferryd flags and UI are still to come (phase 2).

## Contract

```
lock(salt, Terms{token, amount, zAddr, bAddr, claimer, refunder, t1, t2, maxTip})   by B
    id = keccak256(abi.encode(msg.sender, salt)); state Locked; pulls exactly `amount`
ready(id)            refunder only, before t1                    Locked → Ready
claim(id, z, tip)    anyone, before t1, once Ready, z·G ↔ zAddr  → Claimed: claimer gets amount − tip, caller gets tip
refund(id, b)        anyone, t1 ≤ now < t2, b·G ↔ bAddr          → Refunded: refunder gets amount
punish(id)           anyone, now ≥ t2, still Locked or Ready     → Punished: claimer gets amount
```

- `zAddr` and `bAddr` are the Ethereum addresses of `Z_s = z·G` and `B_s = b·G`, the secp256k1
  points each side already proves with the cross-group DLEQ.
- All windows use `block.timestamp` (seconds). Base produces a block every 2 s with
  deterministic timestamps.
- There is no separate cancel step. In Bitcoin, tx_cancel exists because script timelocks are
  relative. Here the contract checks absolute windows, so `[lock, t1)`, `[t1, t2)` and `[t2, ∞)`
  can never overlap.
- Token transfers use a SafeERC20-style call: tokens that return nothing are accepted, and
  `false` or a revert is rejected. A reentrancy guard covers lock, claim, refund and punish.
  `lock` checks the balance it actually received, so fee-on-transfer tokens are rejected.

### The ecrecover check

`ecrecover(h, v, r, s)` returns `address(r⁻¹·(s·R − h·G))`, where `R` is the point with
x = `r` and the y parity that `v` encodes. With `h = 0`, `R = G` (`r = G.x`, `v = 27`
because G.y is even) and `s = k·G.x mod n`, the result is `r⁻¹·k·r·G = k·G`. This
`scalarAddress(k)` costs one 3000-gas precompile call. It returns `address(0)` for `k = 0`
and for `k ≥ n`. The second case matters: `k + n` names the same point, but B must receive the
canonical scalar so it can map it back to the Pallas share.

How it is checked:

- `forge test` compares it against `vm.addr` and against a separate pure-Solidity Jacobian
  double-and-add reference: 1000 fuzz runs over `[1, n)`, 1000 over the share range
  `[1, 2²⁵⁴)`, known vectors (1·G, 2·G, (n−1)·G), and the out-of-range cases.
- `crates/ferry-evm` compares its k256 implementation against alloy's signer, and the anvil test
  compares the deployed contract's `scalarAddress` against `ferry-evm` for DLEQ-proven Ferry
  shares.

## Flow

1. **Setup.** This is unchanged except for the counter-asset terms. In place of a BTC key and
   address, each side gives an EVM address: Z's `claimer` and B's `refunder`. Both sides agree
   on the chain id, the FerryLock address, the token, `amount`, `t1`, `t2` and `maxTip`.
2. **Lock.** B approves the token, then calls `lock` (`EvmClient::lock`).
3. **Check.** Z waits for the lock's confirmations, then checks **every** term on chain
   (`EvmClient::check_lock`). This includes `bAddr`: if B committed to some other `b'`, B's
   refund would reveal `b'`, not `b`, and Z's ZEC would be stuck. Z also checks that the
   contract is the agreed deployment (code hash) and that the token is the agreed USDC.
4. **ZEC lock.** Z sends the ZEC to the joint address. B waits for N Zcash confirmations.
5. **Ready.** B calls `ready(id)`. This takes the place of the redeem adaptor signature in the
   Bitcoin flow. Without it, Z could publish `z` and take the USDC before locking any ZEC.
6. **Claim.** Z, or a relayer Z hands `z` to, calls `claim`. The tokens go to `claimer`, and
   the caller keeps at most `maxTip`, so Z needs no ETH.
7. **Sweep.** B reads `z` from the `Claimed` event or from the calldata
   (`SwapEvent::revealed_share`, `revealed_in_calldata`), checks it against `zAddr` and Z's
   Pallas point, and sweeps the ZEC with `σ(z + b)`.

Abort paths: if B never calls ready, or Z never claims, then after t1 B refunds and reveals `b`,
and Z reclaims its ZEC. If B stays silent until t2, anyone can call `punish` and the tokens go to
Z. As with Bitcoin, Z's ZEC then stays locked, and going quiet costs B.

## Design review: what changed from the first proposal, and why

The proposal was sound in outline. These are the points where it needed changes:

1. **The tip must be bounded by the lock terms.** In the proposal the caller chose the tip
   freely. Once `z` is in a pending claim, anyone can resubmit the claim with a tip equal to the
   whole amount. Binding the tip to a relayer with a signature from `z` doesn't help, because
   `z` is public by then and anyone can re-sign. So `Terms.maxTip` (with `maxTip ≤ amount`) is
   fixed at lock time and Z checks it. A front-runner can take only the agreed `maxTip`.
2. **Swap ids are keyed by the locker.** `id = keccak256(locker, salt)`, so nobody can occupy
   B's id by front-running its lock.
3. **`ready` is refunder-only and only before t1.** A ready after t1 could never be used.
4. **Only canonical scalars are accepted** (`0 < k < n`). See above.
5. **`refund` accepts any caller.** The payout is fixed to `refunder`, and only the holder of
   `b` can produce it, so this is equivalent to "B only" while letting B use a relayer too.
6. **The terms are checked when the lock is made**: `t1 > now`, `t2 > t1`, no zero addresses,
   `zAddr ≠ bAddr`, the token has code, and the exact amount is received.

### Timing rules (the daemon enforces these, not the chain)

Rules carried over:

- Z does not send a claim once `now ≥ t1 − Δ`.
- B does not send a refund once `now ≥ t2 − Δ`.

New rules for EVM, because **a transaction that reverts still publishes its calldata**:

- **Never broadcast a claim or refund that would revert.** `EvmClient::claim` and
  `EvmClient::refund` check the share against the committed address and the on-chain state,
  simulate with `eth_call`, and send nothing if any of these fail. The anvil test checks that the
  sender's nonce doesn't change.
- **B refunds only once the latest block's timestamp is ≥ t1.** The client enforces this, and it
  is the EVM version of "refund only after tx_cancel has k confirmations". A refund that lands
  before t1 reverts but shows `b` while Z can still claim. Z would then get both the USDC and
  its ZEC back.
- **Z claims only after `ready` has k confirmations.** If a reorg removes `ready`, Z's claim
  reverts and `z` leaks. B then sweeps the ZEC and refunds the USDC after t1. On Base mainnet,
  "k confirmations" should mean the L1-safe head.
- **Sequencer liveness.** Base has a single sequencer. It can delay a claim, and the forced
  L1-inclusion path takes up to the 12 h sequencing window. On mainnet, the gap between ready
  and t1 − Δ has to cover that. A Base Sepolia demo can use minutes.

Compared with Bitcoin, one race is gone. A valid redeem and a valid cancel can no longer compete
in the mempool, because the windows don't overlap. The only risk left is a late transaction
reverting with its scalar visible, and the rules above cover it.

### Revealing z or b publicly

On Bitcoin, only the counterparty learns the share, by completing its adaptor signature. On EVM,
everyone sees it in calldata and in the event. **Conclusion: this is not a safety or privacy
problem**, for these reasons:

- **One share controls nothing.** `ask = σ(z + b)`. After a claim, the world knows `z` and only B
  knows `b`. After a refund, the world knows `b` and only Z knows `z`. Each share is fresh per
  swap and never reused.
- **Outsiders can't find or spend the note, even if both shares were public** (for example after
  a timing-rule violation). Recognising the note requires `ivk`, and that needs `rivk`. Spending
  it requires the note opening and its nullifier, which needs `nk`. `nk` and `rivk` come from
  both parties' nonces plus their ECDH secret, and never go on chain. So the only party that
  could exploit both shares is the counterparty, which is the case the timing rules exist for.
- **No cross-chain link.** From `z` and `b` an observer can compute `Z_p`, `B_p` and `ak`. But
  `ak` never appears on Zcash: a spend publishes `rk = ak + α·SpendAuthG` with a fresh uniform
  `α`, which perfectly hides `ak`, and the address `pk_d = ivk·g_d` can't be computed without
  `rivk`.
- **Caveat:** `zAddr` and `bAddr` become ordinary Ethereum accounts whose private keys are
  public. They are commitments only, so nothing should ever be sent to them.

### What the public sees on Base

Unlike Bitcoin's key-path happy case, which looks like an ordinary payment, **every path on Base
is a visible call to a known swap contract**: lock, ready, then claim, refund or punish. The
calls show the token, the amount, `t1`, `t2`, the claimer and refunder addresses, and the
outcome. The Zcash side is unchanged: the ZEC amount, the joint address and the sweep destination
stay shielded.

Timing leaks to keep in mind:

- **`ready` roughly dates the ZEC lock.** It lands about N Zcash blocks after the lock note.
  This narrows down which Zcash block holds the lock, but not which shielded transaction in it.
- **The claim time is public.** B's ZEC sweep keeps its random delay so it doesn't line up with
  the claim.
- **Reused claimer and refunder addresses link a user's swaps together.** Use a fresh address
  per swap. The relayer tip exists partly so a fresh claimer address needs no ETH.

Possible next step: an off-chain EIP-712 "ready" signature from B that Z submits with the claim.
That would remove the `ready` transaction, along with its timing signal and B's gas cost, while
keeping the same gate.

### Trust in the token

USDC's issuer can pause transfers or blacklist addresses, including the contract or Z's claimer.
A paused token makes claim, refund and punish revert. The client simulates first, so this doesn't
leak a share, but funds stay stuck until the token is unpaused. This trust in the issuer is
inherent to swapping USDC and is disclosed rather than solved. Z must also confirm that `token`
is the real USDC: a malicious token could block Z's claim alone.

## Code

- `contracts/`: Foundry project. `FerryLock.sol`, `MockUSDC.sol` (6 decimals, open mint, for
  tests only), `test/FerryLock.t.sol` (33 tests, 5 of them fuzz), `script/Deploy.s.sol`
  (`DEPLOY_MOCK_USDC=true` also deploys MockUSDC; Base Sepolia's Circle test USDC is
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e`), and `export-artifacts.sh`, which refreshes
  `crates/ferry-evm/artifacts`. forge-std v1.11.0 is vendored in `contracts/lib`.
- `crates/ferry-evm` (alloy 2.1):
  - `EvmClient`: `lock` (approves if needed), `ready`, `claim`, `refund`, `punish`, `swap`,
    `check_lock`, `events`, `revealed_in_tx` and `latest_timestamp`.
  - `SwapWatcher`: polls a swap's logs with a confirmation depth.
  - `SwapEvent` and `SwapEventKind`, including `revealed_share`, which checks the revealed share
    against the committed address.
  - `revealed_in_calldata`.
  - `point_address`, `point_address_sec1`, `scalar_address` and `verify_share`.
  - Tests: unit tests, `tests/anvil.rs` (spawns anvil on 127.0.0.1:18545 and runs a relayed
    happy claim, a refund and a punish with DLEQ-proven shares), and `tests/artifacts.rs` (the
    committed ABI and bytecode match a fresh `forge build`).

Gas (forge gas report): lock about 273k, ready about 31k, claim about 65k (up to 103k with a
tip), refund about 57k, punish about 68k.
