# Ferry on EVM: shielded ZEC ↔ USDC

The Zcash side of Ferry stays the same: Z locks ZEC in the Ironwood pool to the joint key
`ask = σ(z + b)`. The counter-asset is an ERC-20 (USDC) held by the `FerryLock` contract
(`contracts/src/FerryLock.sol`) instead of a Taproot output. The public testnet is Base Sepolia,
and local runs use anvil.

| | holds | wants |
|---|---|---|
| **Z** | shielded ZEC | USDC |
| **B** | USDC | shielded ZEC |

To run it: `ferryd --counter evm` with the `--evm-*` flags (below). `infra/evm-demo.sh test`
runs a happy swap, a refund and a punish against anvil with the mock ZEC leg.
`infra/evm-testnet.sh` sets up the public run on Base Sepolia and Zcash testnet
([Running on Base Sepolia](#running-on-base-sepolia)).

## Contract

```
lock(salt, Terms{token, amount, zAddr, bAddr, claimer, refunder, t1, t2, maxTip})   by B
    id = keccak256(abi.encode(msg.sender, salt)); state Locked; pulls exactly `amount`
claim(id, z, tip, readySig)  anyone, before t1, with the refunder's EIP-712 Ready(id) signature,
                             z·G ↔ zAddr      → Claimed: claimer gets amount − tip, caller gets tip
refund(id, b)                anyone, t1 ≤ now < t2, b·G ↔ bAddr  → Refunded: refunder gets amount
punish(id)                   anyone, now ≥ t2, still Locked      → Punished: claimer gets amount
```

- `zAddr` and `bAddr` are the Ethereum addresses of `Z_s = z·G` and `B_s = b·G`, the secp256k1
  points each side already proves with the cross-group DLEQ.
- **Ready is an off-chain signature.** B signs the EIP-712 message `Ready(bytes32 id)` (domain:
  name `FerryLock`, version `1`, the chain id and the contract) once the ZEC lock has N
  confirmations, and sends it to Z over the peer channel. `claim` requires it. It plays the role
  of the Bitcoin flow's redeem adaptor signature: without it Z could publish `z` and take the
  USDC before locking any ZEC. The contract accepts only 65-byte `r‖s‖v` signatures with
  `v ∈ {27, 28}` and low `s`, so each signature has exactly one encoding. The domain is computed
  on each call (the contract has no immutables), so the deployed code equals the compiled runtime
  code, and ferryd checks exactly that at startup.
- All windows use `block.timestamp` (seconds). Base produces a block every 2 s with
  deterministic timestamps.
- There is no separate cancel step. In Bitcoin, tx_cancel exists because script timelocks are
  relative. Here the contract checks absolute windows, so `[lock, t1)`, `[t1, t2)` and `[t2, ∞)`
  never overlap.
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

1. **Setup** (peer messages `Propose` and `Accept`, with their own transcript domain). Each side
   sends its DLEQ-proven share points, a nonce, an ECDH key and its EVM account: Z's `claimer`
   and B's `refunder`. The terms add the chain id, the FerryLock address, the token, `amount`,
   absolute `t1` and `t2`, both Δ margins, the confirmation targets and `maxTip`. The salt comes
   from the session id, so both sides know the swap id before anything is on chain.
2. **Lock.** B approves the token and calls `lock`.
3. **Check.** Z waits for the lock's confirmations, then compares **every** term on chain with
   what it expects. This includes `bAddr`: if B committed to some other `b'`, B's refund would
   reveal `b'`, not `b`, and Z's ZEC would be stuck. ferryd also refuses to start unless the code
   at the FerryLock address is this build's FerryLock and the chain id is the agreed one.
4. **ZEC lock.** Z sends the ZEC to the joint address. B waits for N Zcash confirmations.
5. **Ready.** B signs `Ready(id)` and sends it (peer message `ReadySig`), but only while Z still
   has time to claim. Z checks that it recovers to B's refunder address.
6. **Claim.** Z, or a relayer Z hands `z` and the signature to, calls `claim`. The tokens go to
   `claimer`, and the caller keeps at most `maxTip`, so Z needs no ETH.
7. **Sweep.** B reads `z` from the `Claimed` event (or the calldata), checks it against `zAddr`
   and Z's Pallas point, and sweeps the ZEC with `σ(z + b)` after a random delay.

Abort paths: if B never signs Ready, or Z never claims, then from t1 B refunds and reveals `b`,
and Z reclaims its ZEC. If B stays silent until t2, anyone can call `punish` and the tokens go to
Z. As with Bitcoin, Z's ZEC then stays locked, and going quiet costs B.

## Design review: what changed from the first proposal, and why

The proposal was sound in outline. These are the points where it changed:

1. **The tip must be bounded by the lock terms.** In the proposal the caller chose the tip
   freely. Once `z` is in a pending claim, anyone can resubmit the claim with a tip equal to the
   whole amount. Binding the tip to a relayer with a signature from `z` doesn't help, because
   `z` is public by then and anyone can re-sign. So `Terms.maxTip` (with `maxTip ≤ amount`) is
   fixed at lock time and Z checks it. A front-runner can take only the agreed `maxTip`.
   A Z taker refuses any maker whose `maxTip` is above its own `--evm-max-tip` (0 by default),
   and a Z maker accepts only its own value. Otherwise a maker could set `maxTip = amount`, watch
   for Z's claim, resubmit it with the full tip, and also sweep the ZEC with the revealed `z`.
2. **Swap ids are keyed by the locker.** `id = keccak256(locker, salt)`, so nobody can occupy
   B's id by front-running its lock.
3. **Ready is an off-chain EIP-712 signature, not an on-chain `ready()` call.** This is the same
   gate with no transaction, so B pays no gas for it. It also leaves no on-chain timestamp
   roughly dating the ZEC lock, and no reorg can drop a ready transaction and make a claim
   revert (and leak `z`). The signature is bound to the chain, the contract and the swap id.
4. **Only canonical scalars are accepted** (`0 < k < n`). See above.
5. **`refund` accepts any caller.** The payout is fixed to `refunder`, and only the holder of
   `b` can produce it, so this is equivalent to "B only" while letting B use a relayer too.
6. **The terms are checked when the lock is made**: `t1 > now`, `t2 > t1`, no zero addresses,
   `zAddr ≠ bAddr`, the token has code, and the exact amount is received.

### Timing rules (the daemon enforces these, not the chain)

Rules carried over:

- Z does not send a claim once `now ≥ t1 − Δ`.
- B does not send a refund once `now ≥ t2 − Δ`.
- B signs Ready only after N Zcash confirmations, and only while `now < t1 − Δ`.

New rules for EVM, because **a transaction that reverts still publishes its calldata**:

- **Never broadcast a claim or refund that would revert.** `EvmClient::claim` and
  `EvmClient::refund` check the share against the committed address, the Ready signature and the
  on-chain state, simulate with `eth_call`, and send nothing if any of these fail. The anvil test
  checks that the sender's nonce doesn't change.
- **Each claim and refund action carries its window** (`not_after = t1 − Δ`; refund
  `[t1, t2 − Δ)`), and ferryd re-checks it against the latest block time when it actually
  sends, not only when the state machine decided.
- **B refunds only once the latest block's timestamp is ≥ t1.** This is the EVM version of
  "refund only after tx_cancel has k confirmations". A refund that lands before t1 reverts but
  shows `b` while Z can still claim. Z would then get both the USDC and its ZEC back.
- **Sequencer liveness.** Base has a single sequencer. It can delay a claim, and the forced
  L1-inclusion path takes up to the 12 h sequencing window. The Base mainnet policy therefore
  asks for 1 h margins and at least 4 h from the proposal to t1 − Δ; Base Sepolia asks for 2 min
  margins (`EvmPolicy::for_chain`).

Compared with Bitcoin, one race is gone. A valid claim and a valid refund can never compete in
the mempool, because the windows don't overlap. The only risk left is a late transaction
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
is a visible call to a known swap contract**: the lock, then a claim, a refund or a punish. The
calls show the token, the amount, `t1`, `t2`, the claimer and refunder addresses, and the outcome.
The Zcash side is unchanged: the ZEC amount, the joint address and the sweep destination stay
shielded.

Timing leaks to keep in mind:

- **The claim time is public.** B's ZEC sweep keeps its random delay so it doesn't line up with
  the claim.
- **Reused claimer and refunder addresses link a user's swaps together.** Use a fresh address
  per swap. The relayer tip exists partly so a fresh claimer address needs no ETH.

### Trust in the token

USDC's issuer can pause transfers or blacklist addresses, including the contract or Z's claimer.
A paused token makes claim, refund and punish revert. The client simulates first, so this doesn't
leak a share, but funds stay stuck until the token is unpaused. This trust in the issuer is
inherent to swapping USDC and is disclosed rather than solved. Z must also confirm that `token`
is the real USDC: a malicious token could block Z's claim alone.

## Code

- **`contracts/`** (Foundry). `FerryLock.sol`; `MockUSDC.sol` (6 decimals, open mint, tests
  only); `test/FerryLock.t.sol` (34 tests, 5 of them fuzz); `script/Deploy.s.sol`
  (`DEPLOY_MOCK_USDC=true` also deploys MockUSDC; Base Sepolia's Circle test USDC is
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e`); and `export-artifacts.sh`, which refreshes
  `crates/ferry-evm/artifacts`. forge-std v1.11.0 is vendored in `contracts/lib`.
- **`crates/ferry-evm`** (alloy 2.1).
  - Always available, and used by ferry-core: `point_address`, `scalar_address`,
    `verify_share`, `swap_id`, `ready_digest` and `ready_signer` (FerryLock's signature rules).
  - With the default `client` feature: `EvmClient` (`lock`, `claim`, `refund`, `punish`,
    `swap`, `check_lock`, `check_deployment`, `events`, `latest_block`), `SwapWatcher`,
    `SwapEvent::revealed_share`, `revealed_in_calldata`, `sign_ready`. `connect_http` speaks
    https (rustls), gives each request 30 s, retries rate-limited requests (HTTP 429 or 503)
    with a backoff, takes each nonce from the node (so a failed send leaves no nonce gap), and
    waits at most 3 minutes for a receipt.
  - Tests: unit tests, `tests/anvil.rs` (spawns anvil on 127.0.0.1:18545, or on
    `FERRY_EVM_TEST_PORT`: deployment check, a
    relayed happy claim with an EIP-712 signature checked against the contract's digest, a
    refund and a punish, all with DLEQ-proven shares), and `tests/artifacts.rs` (the committed
    ABI and bytecode match a fresh `forge build`).
- **`ferry_core::evm`.** `EvmParams` with block-time windows, and `EvmPolicy` per chain (anvil
  needs `--dev-policy`). `EvmKeys`/`EvmSetup`, `EvmSession` (joint key, the shares from revealed
  scalars, swap id, ready digest, the exact lock terms), versioned `EvmEnvelope`/`EvmMessage`,
  and the two state machines.
  - **Shared with the Bitcoin machines:** the joint-key and DLEQ code, the `ZecLeg` actions,
    and the Z side's refused / lapsed / late-note rules, ported as they are.
  - **Not shared:** the counter-chain steps. Adaptor signatures and presigned transactions have
    no EVM equivalent, so there is no common abstraction worth forcing.
  - **Idempotent:** each machine takes one chain observation per tick, so its transitions can
    safely repeat.
  - **Tests:** `tests/evm_sim.rs` drives both machines against a simulated FerryLock that
    applies the contract's rules and fails the test on any call the contract would refuse.
- **`ferryd --counter evm`** (`crates/ferryd/src/evm/`). It has the Bitcoin daemon's structure
  but its own record store (`<data-dir>/evm-swaps`), views and routes, on the same paths.
  - **Flags:**
    - `--evm-rpc`, `--evm-contract`, `--evm-token`, `--evm-key-file` (hex key: Z's payout
      account, which also sends the claim; B's account, which locks, refunds and signs Ready).
    - `--evm-token-symbol`, `--evm-token-decimals`.
    - `--evm-t1-secs` (proposal to t1), `--evm-refund-secs` (t2 − t1), `--evm-delta-secs`.
    - `--evm-lock-confs`, `--evm-max-tip`, `--evm-log-chunk`.
  - `--maker-offer RATE:MIN:MAX` gives the rate in token base units per ZEC. The price feed
    works with `--maker-price-pair ZEC/USDC`.
  - Each poll re-reads only the last 120 blocks of a swap's FerryLock events and keeps the
    older ones from earlier polls, so the scan stays one `eth_getLogs` request on public RPCs.
  - The views keep the Bitcoin shape: counter amounts sit in `btc_sat` as token base units, and
    `chains.btc` carries `coin`, `ticker` and `decimals`. A `counter` block adds the contract,
    token, swap id and commitments. Timeline kinds reuse the Bitcoin names where the step is the
    same (`btc_lock_broadcast`, `redeem_adaptor_received` for Ready, `btc_redeem_broadcast` for
    the claim, `cancel_seen` when t1 passes), so the UI's steps work for both.
- **`infra/evm-demo.sh`.** anvil on 18545, ferryd on 7901/7902 (peers on 7911/7912), and
  `happy`, `refund`, `punish`, `test`.
- **`infra/evm-testnet.sh`.** Base Sepolia and Zcash testnet: `keys`, `status`, `deploy`, `up`,
  `swap`, `down`, and `fork` for a rehearsal on a local fork (below).
- **Web.** The coin table has a `usdc` entry (6 decimals, `kind: "evm"`, the chain named from
  the network). Deadlines are drawn in block time, the crossing has no cancel output, and the
  maker list labels EVM makers `ZEC/<token>`. `pnpm shoot:evm` takes the screenshots against a
  running EVM demo.

Gas (forge gas report): lock about 273k; claim about 75k, or up to 109k with a tip; refund about
57k; punish about 68k. Ready costs nothing. Deploying FerryLock costs about 1.79M.

## Running on Base Sepolia

`infra/evm-testnet.sh` runs the swap on public test networks: Circle's test USDC
(`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) in a FerryLock you deploy on Base Sepolia, and
real TAZ on Zcash testnet through zcash-devtool wallets, the way `infra/testnet.sh` runs the
signet pair. It needs Foundry (`cast`, `forge`), python3, openssl, and zcash-devtool built with
Ferry's patch (`vendor/zcash-devtool`, or set `ZEC_DEVTOOL`).

### 1. Create the accounts

```sh
infra/evm-testnet.sh keys
```

This creates, once, three Base Sepolia accounts (the deployer, B and Z) and a Zcash testnet
wallet for each side. Everything goes in `.evm-testnet/` (git ignores it; the directory is
private to you, mode 0700, and each file 0600). The script prints addresses, never a key, and
running it again changes nothing. **Back up `.evm-testnet/`**: it holds the only copy of the
keys.

### 2. Fund them

`keys` prints the addresses, and `infra/evm-testnet.sh status` shows them again with their
balances and lists exactly what is still missing.

| account | what it does | send it | from |
|---|---|---|---|
| deployer | deploys FerryLock, once | about 0.005 ETH | Coinbase CDP faucet or Alchemy faucet (Base Sepolia) |
| B, the maker | approves and locks the USDC; refunds | about 0.002 ETH and 10 USDC | ETH: as above; USDC: https://faucet.circle.com, network Base Sepolia |
| Z, the taker | receives the USDC and sends the claim | about 0.001 ETH | as above |
| Z's Zcash wallet (`utest1…`) | holds the ZEC Z swaps | at least 0.0505 TAZ; 1 TAZ is plenty | https://fauzec.com |
| B's Zcash wallet | receives the swapped ZEC | nothing | |

The ETH only pays gas, and Base Sepolia gas is cheap: at its usual base fee the deployment costs
about 0.00001 ETH and a swap less than that. The amounts above leave room for gas spikes and many
swaps. The default swap is 0.05 ZEC for 2 USDC (40 USDC per ZEC), so 10 USDC covers five.
zcash-devtool spends TAZ from another wallet only after 10 confirmations (about 13 minutes), so
fund Z's Zcash wallet first.

### 3. Deploy, start, swap

```sh
infra/evm-testnet.sh deploy   # FerryLock from the deployer; checks the code on chain is this build's
infra/evm-testnet.sh up       # B (maker, API :7952, peer :7962) and Z (API :7951, peer :7961)
infra/evm-testnet.sh swap     # 0.05 ZEC for 2 USDC, followed to the end with sepolia.basescan.org links
infra/evm-testnet.sh down     # stops the two daemons it started
```

Before doing anything, `deploy`, `up` and `swap` ask the RPC for the chain id (84532) and ask the
USDC contract for its `symbol()` ("USDC") and `decimals()` (6), and stop if any answer is
different. `deploy` rebuilds the contracts and stops if they no longer match the artifact that
ferryd compiles in. ferryd itself also refuses to start unless the code at the FerryLock address
is that FerryLock.

A swap takes about 5 to 10 minutes: B's lock and 10 confirmations (about 30 seconds), Z's ZEC
lock and its 3 Zcash confirmations (about 4 minutes on average), the claim, then B's sweep after
its random delay. To see the abort paths in real time, start the daemons with `FAULTS=1`:
`swap --refund` (Z stops after locking its ZEC; B refunds at t1, 45 minutes in, and Z takes its
ZEC back) and `swap --punish` (B stops after locking; Z punishes at t2, 75 minutes in).

The UI: `cd web && source ../.evm-testnet/env && PORT=7995 pnpm dev:ui`.

### Timing on a public chain

All deadlines are in Base block time (FerryLock compares `block.timestamp`), and every value is
an environment variable (`infra/evm-testnet.sh help`).

| | default | why |
|---|---|---|
| t1 | 45 min after the proposal | B's lock takes about 30 s. The rest is for Z's ZEC lock to get 3 Zcash confirmations: testnet blocks come every 75 s on average, but the testnet sometimes stalls for 10 to 20 minutes. If the window runs out, nothing is lost: B refunds at t1 and Z takes its ZEC back. |
| Δ | 5 min | No claim after t1 − Δ, no refund after t2 − Δ, no Ready after t1 − Δ. A late claim reverts but still shows `z`, so Δ must cover the slowest inclusion on a chain with one sequencer, plus RPC retries. ferryd's Base Sepolia policy asks for at least 2 min. |
| t2 − t1 | 30 min | B refunds as soon as a block at or after t1 exists. Punish opens at t2. |
| EVM lock confirmations | 10 (about 20 s) | Z sends ZEC only once B's lock is 10 blocks deep. Base reorgs are rare and shallow, so this costs little; the policy minimum is 2. |
| ZEC confirmations | 3 | The Base Sepolia policy minimum. |
| poll | every 4 s | Each daemon reads the chain this often, to stay under the public RPC's rate limit. |

### Rehearsal on a fork

```sh
infra/evm-testnet.sh fork test
```

This starts anvil on 127.0.0.1:18547 as a fork of Base Sepolia (the chain id stays 84532, so
ferryd applies the Base Sepolia policy, not the anvil one). It creates separate keys in
`.evm-testnet-fork/` and gives them the amounts above: the ETH with `anvil_setBalance`, and 10 of
Circle's real test USDC, moved from a real holder by impersonation. Then it deploys FerryLock,
starts both daemons with the mock ZEC leg, and runs a swap, a refund and a punish, jumping the
fork's clock to t1 and t2. Nothing is sent to the real network. The last run is in
`docs/evidence/evm-base-sepolia-fork-2026-10-20.txt`, together with a start against the real
Zcash testnet. `fork up`, `fork fund` and `fork down` do the steps one at a time; point the other
commands at the fork with
`FERRY_EVM_TESTNET_DIR=.evm-testnet-fork EVM_RPC=http://127.0.0.1:18547 ZEC_BACKEND=mock FAULTS=1`.

### Limits

- **Test networks only.** Test ETH, test USDC and TAZ have no value. Base mainnet has a much
  stricter policy (1 h margins, 30 confirmations), and nothing here has been run there.
- **RPC rate limits.** https://sepolia.base.org is shared and throttled, and it answers
  `eth_getLogs` for at most 200 blocks at a time. The script and ferryd retry throttled requests
  with a backoff and time requests out, ferryd scans logs in 200-block chunks and re-reads only
  recent blocks, and the daemons poll every 4 s. For long or frequent runs, set `EVM_RPC` to your
  own endpoint (Alchemy, QuickNode, a Coinbase CDP node).
- **The USDC issuer can freeze.** Test USDC is Circle's contract. If Circle pauses it or
  blacklists FerryLock or a party's address, claim, refund and punish revert. ferryd simulates
  them first, so no share leaks, but the tokens stay in FerryLock until Circle lifts it (see
  [Trust in the token](#trust-in-the-token)).
- **Hot keys.** The three Base Sepolia keys sit unencrypted in `.evm-testnet/` (the deployer's
  in a keystore whose password is in the file next to it). That is fine for test funds only.
- **Faucets** limit how often you can ask (fauzec.com gives 1 TAZ a day).

## Follow-ups

- **Watchtower.** Anyone may call `punish`, so a keyless EVM tower for Z is simple. A tower for
  B would need `b`.
- **Base Sepolia.** The setup is scripted and rehearsed on a fork (above). A run on the real
  network waits for the accounts to be funded.
