#!/usr/bin/env bash
# End-to-end test with REAL shielded ZEC: brings up the ZEC_BACKEND=devtool demo stack from a
# fresh chain (bitcoind + Zebra + Zaino regtest, two ferryd) on its own ports and containers,
# then runs three swaps through the control API and checks outcomes and balances:
#
#   happy   B sweeps the joint Ironwood note; Z gets the BTC.
#   refund  Z stalls after locking ZEC; B cancels and refunds; Z extracts b and reclaims its ZEC.
#   punish  B stalls after locking BTC; Z cancels and, with no refund by T2, punishes.
#
# It also checks audit H4 on both sweeps: the counterparty's wallet, which holds the joint
# viewing key, syncs and enhances (downloads the full transaction, so OVK decryption is tried)
# and must not recover the sweep's recipient or amount.
#
# And the track's core claim, nothing unshielded on the way through: every ZEC transaction of
# every swap (lock, sweep, reclaim), as the node returns it, has no transparent inputs or
# outputs, no Sapling or Orchard parts, and at least one Ironwood action.
#
# Exits 0 only if every check passes. Takes ~10 minutes on arm64 (amd64 images are emulated).
#   infra/e2e-real.sh            KEEP=1 infra/e2e-real.sh  (leave the stack running)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ZEC_BACKEND=devtool
export FERRY_DEMO_DIR="${FERRY_DEMO_DIR:-$ROOT/.e2e-real}"
export BITCOIND_CONTAINER="${BITCOIND_CONTAINER:-ferry-e2e-bitcoind}"
export ZEBRA_CONTAINER="${ZEBRA_CONTAINER:-ferry-e2e-zebra}"
export ZAINO_CONTAINER="${ZAINO_CONTAINER:-ferry-e2e-zaino}"
export BTC_RPC_PORT="${BTC_RPC_PORT:-18843}" ZEC_RPC_PORT="${ZEC_RPC_PORT:-18332}" ZAINO_PORT="${ZAINO_PORT:-8237}"
export Z_PORT="${Z_PORT:-7401}" B_PORT="${B_PORT:-7402}" Z_PEER_PORT="${Z_PEER_PORT:-7411}" B_PEER_PORT="${B_PEER_PORT:-7412}"
export ZEC_BALANCE_ZAT="${ZEC_BALANCE_ZAT:-500000000}"

cleanup() { [ -n "${KEEP:-}" ] || "$ROOT/infra/demo.sh" down >/dev/null 2>&1 || true; }
trap cleanup EXIT

"$ROOT/infra/demo.sh" down >/dev/null 2>&1 || true
"$ROOT/infra/demo.sh" up

ZEC_DEVTOOL="${ZEC_DEVTOOL:-$ROOT/vendor/zcash-devtool/target/release/zcash-devtool}" \
ZEC_SIGNER="${ZEC_SIGNER:-$ROOT/tools/ferry-zec-signer/target/release/ferry-zec-signer}" \
  python3 - "$FERRY_DEMO_DIR" <<'PY'
import json, os, shutil, sqlite3, subprocess, sys, tempfile, time, urllib.request

STATE = sys.argv[1]
PORTS = {"z": int(os.environ["Z_PORT"]), "b": int(os.environ["B_PORT"])}
MAKER = f"http://127.0.0.1:{os.environ['B_PEER_PORT']}"
ZAINO = f"localhost:{os.environ['ZAINO_PORT']}"
DEVTOOL = os.environ["ZEC_DEVTOOL"]
SIGNER = os.environ["ZEC_SIGNER"]
ZEC_RPC = f"http://127.0.0.1:{os.environ['ZEC_RPC_PORT']}"
pool_rows = []
ZEC_FEE_MAX = 50_000  # zat; ZIP-317 fees here are 10_000-25_000 per transaction
failures = []

def api(key, path, body=None):
    tok = open(f"{STATE}/{key}/api-token").read().strip()
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORTS[key]}{path}",
        data=None if body is None else json.dumps(body).encode(),
        headers={"authorization": f"Bearer {tok}", "content-type": "application/json"},
        method="GET" if body is None else "POST")
    return json.load(urllib.request.urlopen(req, timeout=30))

def balances(key):
    return api(key, "/api/status")["balances"]

def swap(key, sid):
    return api(key, f"/api/swaps/{sid}")

def kinds(view):
    return [e["kind"] for e in view["timeline"]]

def txid_of(view, kind):
    return next((e["txid"] for e in view["timeline"] if e["kind"] == kind), None)

def wait(what, pred, timeout=900, every=2):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = pred()
            if v:
                return v
        except Exception:
            pass
        time.sleep(every)
    raise TimeoutError(what)

def check(name, ok, detail=""):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{': ' + detail if detail else ''}", flush=True)
    if not ok:
        failures.append(name)

def start(zec_zat):
    sid = api("z", "/api/swaps", {"maker": MAKER, "zec_zat": zec_zat})["id"]
    print(f"  swap {sid}", flush=True)
    return sid

def stall(key, sid):
    # 409 until the party reaches a state where a stall changes the outcome
    wait(f"{key} stall accepted", lambda: api(key, f"/api/swaps/{sid}/fault", {"fault": "stall"}).get("ok"), 300, 0.5)
    print(f"  {key.upper()} stalled in {swap(key, sid)['state']}", flush=True)

def outcomes(sid, timeout=900):
    return wait(f"outcomes of {sid}",
                lambda: (lambda z, b: (z, b) if z["outcome"] and b["outcome"] else None)(swap("z", sid), swap("b", sid)),
                timeout)

def zec_pools(txid):
    """Pools of a transaction as mined (raw bytes from the node, parsed by ferry-zec-signer)."""
    req = urllib.request.Request(ZEC_RPC, data=json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "getrawtransaction", "params": [txid, 0]}).encode(),
        headers={"content-type": "application/json"})
    raw = json.load(urllib.request.urlopen(req, timeout=30))["result"]
    with tempfile.NamedTemporaryFile("w", suffix=".hex", delete=False) as f:
        f.write(raw)
    out = subprocess.run([SIGNER, "pools", f.name], check=True, capture_output=True, text=True).stdout
    os.unlink(f.name)
    return {k: int(v) for k, v in (kv.split("=") for kv in out.split())}

def shielded_only(story, role, txid):
    if not txid:
        check(f"{story} {role}: transaction exists", False)
        return
    p = zec_pools(txid)
    pool_rows.append((story, role, txid, p))
    ok = (p["ironwood_actions"] > 0 and p["transparent_inputs"] == p["transparent_outputs"] == 0
          and p["sapling_spends"] == p["sapling_outputs"] == p["orchard_actions"] == 0)
    check(f"{story} {role} is Ironwood-only", ok, " ".join(f"{k}={v}" for k, v in p.items()))

def h4(observer, txid):
    """What the observer's wallet (holding the joint viewing key) recovers of `txid`'s outputs,
    after a sync and enhance on a copy of the wallet (the daemon keeps using the original)."""
    tmp = tempfile.mkdtemp()
    w = os.path.join(tmp, "w")
    shutil.copytree(f"{STATE}/zec/{observer}", w)
    env = dict(os.environ, RUST_LOG="error", NO_COLOR="1")
    for cmd in ("sync", "enhance"):
        subprocess.run([DEVTOOL, "wallet", "-w", w, cmd, "-s", ZAINO], check=True, env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    internal = bytes.fromhex(txid)[::-1]
    db = sqlite3.connect(os.path.join(w, "data.sqlite"))
    known = db.execute("SELECT raw IS NOT NULL FROM transactions WHERE txid = ?", (internal,)).fetchone()
    sent = db.execute("""SELECT s.value, s.to_address FROM sent_notes s JOIN transactions t
                         ON t.id_tx = s.transaction_id WHERE t.txid = ?""", (internal,)).fetchall()
    recv = db.execute("""SELECT n.value FROM ironwood_received_notes n JOIN transactions t
                         ON t.id_tx = n.transaction_id WHERE t.txid = ? AND n.value > 0""", (internal,)).fetchall()
    shutil.rmtree(tmp)
    return known, sent, recv

def h4_check(observer, txid, label):
    known, sent, recv = h4(observer, txid)
    check(f"H4 {label}: {observer.upper()} sees the spend of the joint note", bool(known) and known[0] == 1,
          "full transaction downloaded" if known else "transaction unknown")
    check(f"H4 {label}: {observer.upper()} recovers no recipient or amount", not sent and not recv,
          f"sent_notes={sent} received={recv}")

print("\n== happy: B sweeps the joint note, Z redeems the BTC", flush=True)
z0, b0 = balances("z"), balances("b")
sid = start(100_000_000)
z, b = outcomes(sid)
check("outcomes swapped/swapped", (z["outcome"], b["outcome"]) == ("swapped", "swapped"), f"{z['state']}/{b['state']}")
amt = z["amounts"]
sweep = txid_of(b, "zec_sweep_broadcast")
check("B broadcast the ZEC sweep", sweep is not None, sweep or "")
b1 = wait("B's swept ZEC to be spendable",
          lambda: (lambda x: x if x["zec_shielded_zat"] >= b0["zec_shielded_zat"] + amt["zec_zat"] - ZEC_FEE_MAX else None)(balances("b")), 300)
check("B received the ZEC", b1["zec_shielded_zat"] - b0["zec_shielded_zat"] >= amt["zec_zat"] - ZEC_FEE_MAX,
      f"+{b1['zec_shielded_zat'] - b0['zec_shielded_zat']} zat")
z1 = wait("Z's BTC", lambda: (lambda x: x if x["btc_sat"] > z0["btc_sat"] else None)(balances("z")), 120)
check("Z received the BTC", z1["btc_sat"] - z0["btc_sat"] >= amt["btc_sat"] - 10_000, f"+{z1['btc_sat'] - z0['btc_sat']} sat")
check("Z spent the ZEC", z0["zec_shielded_zat"] - z1["zec_shielded_zat"] >= amt["zec_zat"], f"-{z0['zec_shielded_zat'] - z1['zec_shielded_zat']} zat")
print(f"  lock {txid_of(z, 'zec_lock_broadcast')}  sweep {sweep}  btc redeem {txid_of(z, 'btc_redeem_broadcast')}", flush=True)
if sweep:
    h4_check("z", sweep, "B's sweep")
shielded_only("happy", "ZEC lock", txid_of(z, "zec_lock_broadcast"))
shielded_only("happy", "B's sweep", sweep)

print("\n== refund: Z stalls after locking ZEC, B refunds, Z reclaims", flush=True)
z0 = wait("Z's ZEC change to settle", lambda: (lambda x: x if x["zec_shielded_zat"] > 0 else None)(balances("z")), 300)
time.sleep(30)  # let change notes reach their confirmations so the before-balance is complete
z0 = balances("z")
sid = start(50_000_000)
wait("Z's ZEC lock", lambda: "zec_lock_broadcast" in kinds(swap("z", sid)), 600, 0.5)
stall("z", sid)
z, b = outcomes(sid)
check("outcomes Z refunded (reclaimed) / B refunded", (z["outcome"], b["outcome"]) == ("refunded", "refunded"), f"{z['state']}/{b['state']}")
reclaim = txid_of(z, "zec_reclaim_broadcast")
check("Z broadcast the ZEC reclaim", reclaim is not None, reclaim or "")
z1 = wait("Z's reclaimed ZEC to be spendable",
          lambda: (lambda x: x if z0["zec_shielded_zat"] - x["zec_shielded_zat"] <= ZEC_FEE_MAX else None)(balances("z")), 300)
check("Z got its ZEC back (less fees)", z0["zec_shielded_zat"] - z1["zec_shielded_zat"] <= ZEC_FEE_MAX,
      f"-{z0['zec_shielded_zat'] - z1['zec_shielded_zat']} zat")
print(f"  lock {txid_of(z, 'zec_lock_broadcast')}  cancel {txid_of(b, 'cancel_broadcast')}  refund {txid_of(b, 'refund_broadcast')}  reclaim {reclaim}", flush=True)
if reclaim:
    h4_check("b", reclaim, "Z's reclaim")
shielded_only("refund", "ZEC lock", txid_of(z, "zec_lock_broadcast"))
shielded_only("refund", "Z's reclaim", reclaim)

print("\n== punish: B stalls after locking BTC, Z cancels and punishes", flush=True)
z0 = balances("z")
sid = start(30_000_000)
wait("B's BTC lock", lambda: "btc_lock_broadcast" in kinds(swap("b", sid)), 600, 0.5)
stall("b", sid)
z, b = outcomes(sid, 1200)
check("outcomes punished/punished", (z["outcome"], b["outcome"]) == ("punished", "punished"), f"{z['state']}/{b['state']}")
amt = z["amounts"]
z1 = wait("Z's punish BTC", lambda: (lambda x: x if x["btc_sat"] >= z0["btc_sat"] + amt["btc_sat"] - 10_000 else None)(balances("z")), 120)
check("Z took B's BTC", z1["btc_sat"] - z0["btc_sat"] >= amt["btc_sat"] - 10_000, f"+{z1['btc_sat'] - z0['btc_sat']} sat")
check("nobody swept the joint note", not any(k in kinds(z) + kinds(b) for k in ("zec_sweep_broadcast", "zec_reclaim_broadcast")))
print(f"  btc lock {txid_of(b, 'btc_lock_broadcast')}  zec lock {txid_of(z, 'zec_lock_broadcast')}  "
      f"cancel {txid_of(z, 'cancel_broadcast')}  punish {txid_of(z, 'punish_broadcast')}", flush=True)

if txid_of(z, "zec_lock_broadcast"):
    shielded_only("punish", "ZEC lock", txid_of(z, "zec_lock_broadcast"))

print("\n== every ZEC transaction, as mined", flush=True)
print(f"  {'swap':<7} {'tx':<12} {'txid':<64}  t-in t-out sapling orchard ironwood", flush=True)
for story, role, txid, p in pool_rows:
    print(f"  {story:<7} {role:<12} {txid}  {p['transparent_inputs']:>4} {p['transparent_outputs']:>5} "
          f"{p['sapling_spends'] + p['sapling_outputs']:>7} {p['orchard_actions']:>7} {p['ironwood_actions']:>8}", flush=True)

print("\n" + ("ALL PASS" if not failures else f"FAILED: {failures}"), flush=True)
sys.exit(1 if failures else 0)
PY
