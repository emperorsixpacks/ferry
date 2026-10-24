// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.24;

/// @title FerryLock: the EVM leg of a Ferry swap (shielded ZEC <-> an ERC-20 such as USDC).
/// @notice B (holds the token, wants ZEC) locks tokens here. Z (holds ZEC, wants the token) can
/// claim them only by publishing its secret share `z`, which completes the joint Zcash spend key
/// for B. If the swap is called off, B's refund publishes `b`, which lets Z reclaim its ZEC.
///
/// Windows (block timestamps, seconds):
///   [lock, t1)  claim, once B has called `ready` (after seeing the ZEC lock confirmed)
///   [t1, t2)    refund to B, revealing b
///   [t2, ...)   punish: the tokens go to Z (B failed to refund in time)
///
/// A share is checked against its committed address with the ecrecover scalar-multiplication
/// trick: ecrecover(0, v_G, G.x, k*G.x mod n) = address(k*G). See `scalarAddress`.
///
/// The off-chain timing rules of docs/PROTOCOL.md still apply and are not enforced here: Z never
/// sends a claim close to t1 and B never sends a refund close to t2, because a transaction that
/// lands too late reverts but still publishes its scalar in calldata.
contract FerryLock {
    /// secp256k1 group order.
    uint256 internal constant N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    /// x coordinate of the secp256k1 generator G.
    uint256 internal constant GX =
        0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;
    /// ecrecover recovery id for R = G: G.y is even, so v = 27.
    uint8 internal constant GV = 27;

    enum State {
        None,
        Locked,
        Ready,
        Claimed,
        Refunded,
        Punished
    }

    /// The terms B locks under. Z checks every field against the negotiated swap before it
    /// locks any ZEC.
    struct Terms {
        address token;
        uint256 amount;
        /// address(Z_s): Ethereum address of Z's share on secp256k1.
        address zAddr;
        /// address(B_s): Ethereum address of B's share on secp256k1.
        address bAddr;
        /// Z's payout address (claim and punish pay here).
        address claimer;
        /// B's address (refund pays here; only it may call `ready`).
        address refunder;
        uint64 t1;
        uint64 t2;
        /// Largest token amount a claim may pay its caller, out of `amount` (relayer fee).
        uint256 maxTip;
    }

    struct Swap {
        Terms terms;
        State state;
    }

    mapping(bytes32 => Swap) internal swaps;
    uint256 private entered = 1;

    event Locked(
        bytes32 indexed id,
        address indexed token,
        address indexed refunder,
        address claimer,
        uint256 amount,
        address zAddr,
        address bAddr,
        uint64 t1,
        uint64 t2,
        uint256 maxTip
    );
    event Ready(bytes32 indexed id);
    /// `z` is Z's share: with B's own share it completes the joint Zcash spend key.
    event Claimed(bytes32 indexed id, uint256 z, address caller, uint256 tip);
    /// `b` is B's share: with Z's own share it completes the joint Zcash spend key.
    event Refunded(bytes32 indexed id, uint256 b);
    event Punished(bytes32 indexed id);

    error BadTerms(string reason);
    error SwapExists();
    error WrongState(State state);
    error NotReady();
    error NotRefunder();
    error TooEarly();
    error TooLate();
    error BadScalar();
    error TipTooHigh();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (entered != 1) revert Reentrancy();
        entered = 2;
        _;
        entered = 1;
    }

    /// The swap id for a lock by `locker` with `salt`. Keying by the locker means nobody can
    /// front-run B's lock to occupy its id.
    function swapId(address locker, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(locker, salt));
    }

    /// address(k*G) for 0 < k < n, else address(0).
    /// ecrecover(h, v, r, s) returns address(r^-1 * (s*R - h*G)) where R is the point with
    /// x = r and the parity v encodes. With h = 0, R = G (r = G.x, v = 27) and s = k*r mod n
    /// this is r^-1 * k * r * G = k*G. s is never 0 because k != 0 and r is invertible.
    function scalarAddress(uint256 k) public pure returns (address) {
        if (k == 0 || k >= N) return address(0);
        return ecrecover(bytes32(0), GV, bytes32(GX), bytes32(mulmod(k, GX, N)));
    }

    function getSwap(bytes32 id) external view returns (Terms memory terms, State state) {
        Swap storage s = swaps[id];
        return (s.terms, s.state);
    }

    /// B locks `t.amount` of `t.token` (pre-approved) under `t`. Not claimable until `ready`.
    function lock(bytes32 salt, Terms calldata t) external nonReentrant returns (bytes32 id) {
        if (t.amount == 0) revert BadTerms("amount");
        if (t.maxTip > t.amount) revert BadTerms("maxTip");
        if (t.token.code.length == 0) revert BadTerms("token");
        if (
            t.zAddr == address(0) || t.bAddr == address(0) || t.claimer == address(0)
                || t.refunder == address(0)
        ) revert BadTerms("zero address");
        if (t.zAddr == t.bAddr) revert BadTerms("zAddr == bAddr");
        if (t.t1 <= block.timestamp) revert BadTerms("t1");
        if (t.t2 <= t.t1) revert BadTerms("t2");

        id = swapId(msg.sender, salt);
        Swap storage s = swaps[id];
        if (s.state != State.None) revert SwapExists();
        s.terms = t;
        s.state = State.Locked;

        uint256 before = _balanceOf(t.token);
        _call(t.token, abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), t.amount)));
        // Fee-on-transfer and rebasing tokens would leave the lock short of what Z checks.
        if (_balanceOf(t.token) - before != t.amount) revert BadTerms("received amount");

        emit Locked(
            id, t.token, t.refunder, t.claimer, t.amount, t.zAddr, t.bAddr, t.t1, t.t2, t.maxTip
        );
    }

    /// B, after the ZEC lock note has N confirmations: allow Z to claim. This is the EVM form of
    /// the Bitcoin flow's redeem adaptor signature: without it Z could publish z and take the
    /// tokens before locking any ZEC.
    function ready(bytes32 id) external {
        Swap storage s = swaps[id];
        if (s.state != State.Locked) revert WrongState(s.state);
        if (msg.sender != s.terms.refunder) revert NotRefunder();
        if (block.timestamp >= s.terms.t1) revert TooLate();
        s.state = State.Ready;
        emit Ready(id);
    }

    /// Anyone, before t1, once ready: pay Z's `claimer` (minus `tip` to the caller) by
    /// publishing z with z*G = Z_s. A relayer can claim for Z, so Z needs no ETH.
    function claim(bytes32 id, uint256 z, uint256 tip) external nonReentrant {
        Swap storage s = swaps[id];
        if (s.state == State.Locked) revert NotReady();
        if (s.state != State.Ready) revert WrongState(s.state);
        Terms storage t = s.terms;
        if (block.timestamp >= t.t1) revert TooLate();
        if (tip > t.maxTip) revert TipTooHigh();
        if (scalarAddress(z) != t.zAddr) revert BadScalar();
        s.state = State.Claimed;
        emit Claimed(id, z, msg.sender, tip);
        _transfer(t.token, t.claimer, t.amount - tip);
        if (tip != 0) _transfer(t.token, msg.sender, tip);
    }

    /// In [t1, t2): return the tokens to B's `refunder` by publishing b with b*G = B_s, which
    /// lets Z reclaim its ZEC. Anyone holding b may send it; the tokens only go to the refunder.
    function refund(bytes32 id, uint256 b) external nonReentrant {
        Swap storage s = swaps[id];
        if (s.state != State.Locked && s.state != State.Ready) revert WrongState(s.state);
        Terms storage t = s.terms;
        if (block.timestamp < t.t1) revert TooEarly();
        if (block.timestamp >= t.t2) revert TooLate();
        if (scalarAddress(b) != t.bAddr) revert BadScalar();
        s.state = State.Refunded;
        emit Refunded(id, b);
        _transfer(t.token, t.refunder, t.amount);
    }

    /// Anyone, from t2, if B never refunded: the tokens go to Z (mirrors tx_punish).
    function punish(bytes32 id) external nonReentrant {
        Swap storage s = swaps[id];
        if (s.state != State.Locked && s.state != State.Ready) revert WrongState(s.state);
        Terms storage t = s.terms;
        if (block.timestamp < t.t2) revert TooEarly();
        s.state = State.Punished;
        emit Punished(id);
        _transfer(t.token, t.claimer, t.amount);
    }

    function _transfer(address token, address to, uint256 amount) private {
        _call(token, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    /// SafeERC20-style call: accepts tokens that return nothing, rejects `false` and reverts.
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool))))) {
            revert TransferFailed();
        }
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeCall(IERC20.balanceOf, (address(this))));
        if (!ok || ret.length != 32) revert BadTerms("token balanceOf");
        return abi.decode(ret, (uint256));
    }
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}
