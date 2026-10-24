// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FerryLock} from "../src/FerryLock.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// Reference secp256k1 arithmetic (Jacobian double-and-add), independent of ecrecover.
library RefSecp {
    uint256 internal constant P =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint256 internal constant N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant GX =
        0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;
    uint256 internal constant GY =
        0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8;

    function sub(uint256 a, uint256 b) private pure returns (uint256) {
        return addmod(a, P - b, P);
    }

    function dbl(uint256 x, uint256 y, uint256 z)
        private
        pure
        returns (uint256 x3, uint256 y3, uint256 z3)
    {
        z3 = mulmod(mulmod(2, y, P), z, P);
        uint256 a = mulmod(x, x, P);
        uint256 c = mulmod(y, y, P); // B = Y^2
        y3 = addmod(x, c, P); // X + B
        c = mulmod(c, c, P); // C = B^2
        uint256 d = mulmod(2, sub(sub(mulmod(y3, y3, P), a), c), P);
        a = mulmod(3, a, P); // E = 3A
        x3 = sub(mulmod(a, a, P), mulmod(2, d, P));
        y3 = sub(mulmod(a, sub(d, x3), P), mulmod(8, c, P));
    }

    /// (x1, y1, z1) + G (madd-2007-bl), for accumulators that are never +-G (true for k < n).
    function addG(uint256 x1, uint256 y1, uint256 z1)
        private
        pure
        returns (uint256 x3, uint256 y3, uint256 z3)
    {
        uint256 z1z1 = mulmod(z1, z1, P);
        uint256 h = sub(mulmod(GX, z1z1, P), x1);
        require(h != 0, "ref: accumulator is +-G");
        uint256 r = mulmod(2, sub(mulmod(GY, mulmod(z1, z1z1, P), P), y1), P);
        uint256 hh = mulmod(h, h, P);
        uint256 zh = addmod(z1, h, P);
        z3 = sub(sub(mulmod(zh, zh, P), z1z1), hh);
        hh = mulmod(4, hh, P); // I
        h = mulmod(h, hh, P); // J
        z1z1 = mulmod(x1, hh, P); // V
        x3 = sub(sub(mulmod(r, r, P), h), mulmod(2, z1z1, P));
        y3 = sub(mulmod(r, sub(z1z1, x3), P), mulmod(2, mulmod(y1, h, P), P));
    }

    function inv(uint256 a) private pure returns (uint256 r) {
        r = 1;
        uint256 e = P - 2;
        uint256 b = a;
        while (e != 0) {
            if (e & 1 == 1) r = mulmod(r, b, P);
            b = mulmod(b, b, P);
            e >>= 1;
        }
    }

    function mul(uint256 k) internal pure returns (uint256 x, uint256 y) {
        require(k != 0 && k < N, "ref: scalar out of range");
        (uint256 X, uint256 Y, uint256 Z) = (0, 0, 0);
        bool started;
        for (uint256 i = 256; i > 0; i--) {
            if (started) (X, Y, Z) = dbl(X, Y, Z);
            if ((k >> (i - 1)) & 1 == 1) {
                if (!started) {
                    (X, Y, Z) = (GX, GY, 1);
                    started = true;
                } else {
                    (X, Y, Z) = addG(X, Y, Z);
                }
            }
        }
        uint256 zi = inv(Z);
        uint256 zi2 = mulmod(zi, zi, P);
        x = mulmod(X, zi2, P);
        y = mulmod(Y, mulmod(zi2, zi, P), P);
    }

    function addr(uint256 k) internal pure returns (address) {
        (uint256 x, uint256 y) = mul(k);
        return address(uint160(uint256(keccak256(abi.encodePacked(x, y)))));
    }
}

/// Takes a 1% fee on transferFrom.
contract FeeOnTransfer {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        balanceOf[from] -= a;
        balanceOf[to] += a - a / 100;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// USDT-style: transfer functions return nothing.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address, uint256) external {}

    function transferFrom(address from, address to, uint256 a) external {
        balanceOf[from] -= a;
        balanceOf[to] += a;
    }

    function transfer(address to, uint256 a) external {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
    }
}

/// Returns false from transfer (after locking succeeded).
contract FalseOnTransfer {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        balanceOf[from] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// Re-enters FerryLock.claim from inside transfer.
contract ReentrantToken {
    mapping(address => uint256) public balanceOf;
    FerryLock public target;
    bytes32 public id;
    uint256 public z;
    bool public reentered;

    function arm(FerryLock t, bytes32 i, uint256 s) external {
        (target, id, z) = (t, i, s);
    }

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        balanceOf[from] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        if (address(target) != address(0) && !reentered) {
            reentered = true;
            target.claim(id, z, 0);
        }
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

contract FerryLockTest is Test {
    uint256 constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 constant AMOUNT = 250e6; // 250 USDC
    uint256 constant MAX_TIP = 2e6;

    // Shares are below 2^254 in Ferry (valid on Pallas and secp256k1).
    uint256 constant Z_SHARE = 0x1d5a7c3e9b2f04a6c8e0f1b3d5a7c9e1f3b5d7f9a1c3e5f7091b2d3f4a5c6e7;
    uint256 constant B_SHARE = 0x2b4d6f8091a3c5e7f9b1d3f5a7c9e1b3d5f7091b2d3f4a5c6e7f8091a2b3c4d;

    FerryLock lock;
    MockUSDC usdc;
    address b = makeAddr("B");
    address zPayout = makeAddr("Z");
    address relayer = makeAddr("relayer");
    bytes32 constant SALT = keccak256("session-1");
    uint64 t1;
    uint64 t2;

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
    event Claimed(bytes32 indexed id, uint256 z, address caller, uint256 tip);
    event Refunded(bytes32 indexed id, uint256 b);
    event Punished(bytes32 indexed id);

    function setUp() public {
        vm.warp(1_700_000_000);
        lock = new FerryLock();
        usdc = new MockUSDC();
        usdc.mint(b, 1_000e6);
        vm.prank(b);
        usdc.approve(address(lock), type(uint256).max);
        t1 = uint64(block.timestamp + 1 hours);
        t2 = uint64(block.timestamp + 2 hours);
    }

    function terms(address token) internal view returns (FerryLock.Terms memory) {
        return FerryLock.Terms({
            token: token,
            amount: AMOUNT,
            zAddr: vm.addr(Z_SHARE),
            bAddr: vm.addr(B_SHARE),
            claimer: zPayout,
            refunder: b,
            t1: t1,
            t2: t2,
            maxTip: MAX_TIP
        });
    }

    function doLock() internal returns (bytes32 id) {
        vm.prank(b);
        id = lock.lock(SALT, terms(address(usdc)));
    }

    function lockReady() internal returns (bytes32 id) {
        id = doLock();
        vm.prank(b);
        lock.ready(id);
    }

    function state(bytes32 id) internal view returns (FerryLock.State s) {
        (, s) = lock.getSwap(id);
    }

    // ---- the ecrecover scalar-multiplication check ----

    function test_scalarAddress_knownValues() public view {
        // 1*G: the well-known address of private key 1.
        assertEq(lock.scalarAddress(1), 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf);
        assertEq(lock.scalarAddress(2), 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF);
        assertEq(lock.scalarAddress(N - 1), RefSecp.addr(N - 1));
        assertEq(lock.scalarAddress(Z_SHARE), RefSecp.addr(Z_SHARE));
        assertEq(lock.scalarAddress(B_SHARE), vm.addr(B_SHARE));
    }

    function test_scalarAddress_rejectsOutOfRange() public view {
        assertEq(lock.scalarAddress(0), address(0));
        assertEq(lock.scalarAddress(N), address(0));
        // k + n would name the same point; only the canonical scalar is accepted.
        assertEq(lock.scalarAddress(N + 1), address(0));
        assertEq(lock.scalarAddress(type(uint256).max), address(0));
    }

    /// The ecrecover trick against an independent pure-Solidity scalar multiplication and
    /// against Foundry's own key derivation.
    function testFuzz_scalarAddress_matchesReference(uint256 k) public view {
        k = bound(k, 1, N - 1);
        address got = lock.scalarAddress(k);
        assertEq(got, RefSecp.addr(k), "vs Jacobian reference");
        assertEq(got, vm.addr(k), "vs vm.addr");
    }

    /// Shares in Ferry's actual range (< 2^254).
    function testFuzz_scalarAddress_shareRange(uint256 k) public view {
        k = bound(k, 1, (1 << 254) - 1);
        assertEq(lock.scalarAddress(k), RefSecp.addr(k));
    }

    function testFuzz_scalarAddress_distinctScalarsDiffer(uint256 k, uint256 j) public view {
        k = bound(k, 1, N - 1);
        j = bound(j, 1, N - 1);
        vm.assume(k != j);
        assertTrue(lock.scalarAddress(k) != lock.scalarAddress(j));
    }

    // ---- lock ----

    function test_lock_emitsAndStores() public {
        bytes32 id = lock.swapId(b, SALT);
        vm.expectEmit(address(lock));
        emit Locked(
            id,
            address(usdc),
            b,
            zPayout,
            AMOUNT,
            vm.addr(Z_SHARE),
            vm.addr(B_SHARE),
            t1,
            t2,
            MAX_TIP
        );
        assertEq(doLock(), id);
        (FerryLock.Terms memory t, FerryLock.State s) = lock.getSwap(id);
        assertEq(uint8(s), uint8(FerryLock.State.Locked));
        assertEq(t.zAddr, vm.addr(Z_SHARE));
        assertEq(t.amount, AMOUNT);
        assertEq(usdc.balanceOf(address(lock)), AMOUNT);
    }

    function test_lock_idIsPerLocker() public {
        bytes32 id = doLock();
        // Someone else using the same salt gets a different id and cannot squat B's.
        address other = makeAddr("other");
        usdc.mint(other, AMOUNT);
        vm.startPrank(other);
        usdc.approve(address(lock), AMOUNT);
        bytes32 id2 = lock.lock(SALT, terms(address(usdc)));
        vm.stopPrank();
        assertTrue(id != id2);
        vm.prank(b);
        vm.expectRevert(FerryLock.SwapExists.selector);
        lock.lock(SALT, terms(address(usdc)));
    }

    function test_lock_rejectsBadTerms() public {
        FerryLock.Terms memory t;
        vm.startPrank(b);

        t = terms(address(usdc));
        t.amount = 0;
        vm.expectRevert(abi.encodeWithSelector(FerryLock.BadTerms.selector, "amount"));
        lock.lock(SALT, t);

        t = terms(address(usdc));
        t.maxTip = AMOUNT + 1;
        vm.expectRevert(abi.encodeWithSelector(FerryLock.BadTerms.selector, "maxTip"));
        lock.lock(SALT, t);

        t = terms(makeAddr("eoa"));
        vm.expectRevert(abi.encodeWithSelector(FerryLock.BadTerms.selector, "token"));
        lock.lock(SALT, t);

        t = terms(address(usdc));
        t.claimer = address(0);
        vm.expectRevert(abi.encodeWithSelector(FerryLock.BadTerms.selector, "zero address"));
        lock.lock(SALT, t);

        t = terms(address(usdc));
        t.bAddr = t.zAddr;
        vm.expectRevert(abi.encodeWithSelector(FerryLock.BadTerms.selector, "zAddr == bAddr"));
        lock.lock(SALT, t);

        t = terms(address(usdc));
        t.t1 = uint64(block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(FerryLock.BadTerms.selector, "t1"));
        lock.lock(SALT, t);

        t = terms(address(usdc));
        t.t2 = t.t1;
        vm.expectRevert(abi.encodeWithSelector(FerryLock.BadTerms.selector, "t2"));
        lock.lock(SALT, t);

        vm.stopPrank();
    }

    function test_lock_rejectsFeeOnTransferToken() public {
        FeeOnTransfer fot = new FeeOnTransfer();
        fot.mint(b, AMOUNT);
        vm.prank(b);
        vm.expectRevert(abi.encodeWithSelector(FerryLock.BadTerms.selector, "received amount"));
        lock.lock(SALT, terms(address(fot)));
    }

    function test_lock_failingTransferFromReverts() public {
        vm.prank(makeAddr("broke"));
        vm.expectRevert(FerryLock.TransferFailed.selector);
        lock.lock(SALT, terms(address(usdc)));
    }

    // ---- ready ----

    function test_ready_onlyRefunderBeforeT1Once() public {
        bytes32 id = doLock();
        vm.prank(zPayout);
        vm.expectRevert(FerryLock.NotRefunder.selector);
        lock.ready(id);

        vm.warp(t1);
        vm.prank(b);
        vm.expectRevert(FerryLock.TooLate.selector);
        lock.ready(id);

        vm.warp(t1 - 1);
        vm.prank(b);
        vm.expectEmit(address(lock));
        emit Ready(id);
        lock.ready(id);
        assertEq(uint8(state(id)), uint8(FerryLock.State.Ready));

        vm.prank(b);
        vm.expectRevert(
            abi.encodeWithSelector(FerryLock.WrongState.selector, FerryLock.State.Ready)
        );
        lock.ready(id);
    }

    function test_ready_unknownSwap() public {
        vm.prank(b);
        vm.expectRevert(abi.encodeWithSelector(FerryLock.WrongState.selector, FerryLock.State.None));
        lock.ready(bytes32(uint256(1)));
    }

    // ---- claim ----

    function test_claim_happy() public {
        bytes32 id = lockReady();
        vm.expectEmit(address(lock));
        emit Claimed(id, Z_SHARE, zPayout, 0);
        vm.prank(zPayout);
        lock.claim(id, Z_SHARE, 0);
        assertEq(usdc.balanceOf(zPayout), AMOUNT);
        assertEq(usdc.balanceOf(address(lock)), 0);
        assertEq(uint8(state(id)), uint8(FerryLock.State.Claimed));
    }

    function test_claim_justBeforeT1() public {
        bytes32 id = lockReady();
        vm.warp(t1 - 1);
        lock.claim(id, Z_SHARE, 0);
        assertEq(usdc.balanceOf(zPayout), AMOUNT);
    }

    function test_claim_beforeReadyReverts() public {
        bytes32 id = doLock();
        vm.prank(zPayout);
        vm.expectRevert(FerryLock.NotReady.selector);
        lock.claim(id, Z_SHARE, 0);
    }

    function test_claim_wrongScalarReverts() public {
        bytes32 id = lockReady();
        vm.expectRevert(FerryLock.BadScalar.selector);
        lock.claim(id, B_SHARE, 0);
        vm.expectRevert(FerryLock.BadScalar.selector);
        lock.claim(id, Z_SHARE + 1, 0);
        vm.expectRevert(FerryLock.BadScalar.selector);
        lock.claim(id, 0, 0);
    }

    /// k + n names the same point as k; only the canonical scalar (the one B can map back to a
    /// Pallas share) is accepted.
    function test_claim_nonCanonicalScalarReverts() public {
        FerryLock.Terms memory t = terms(address(usdc));
        t.zAddr = vm.addr(5);
        vm.startPrank(b);
        bytes32 id = lock.lock(SALT, t);
        lock.ready(id);
        vm.stopPrank();
        vm.expectRevert(FerryLock.BadScalar.selector);
        lock.claim(id, 5 + N, 0);
        lock.claim(id, 5, 0);
        assertEq(usdc.balanceOf(zPayout), AMOUNT);
    }

    function testFuzz_claim_wrongScalarReverts(uint256 k) public {
        vm.assume(k != Z_SHARE);
        bytes32 id = lockReady();
        vm.expectRevert(FerryLock.BadScalar.selector);
        lock.claim(id, k, 0);
    }

    function test_claim_atOrAfterT1Reverts() public {
        bytes32 id = lockReady();
        vm.warp(t1);
        vm.expectRevert(FerryLock.TooLate.selector);
        lock.claim(id, Z_SHARE, 0);
    }

    function test_claim_twiceReverts() public {
        bytes32 id = lockReady();
        lock.claim(id, Z_SHARE, 0);
        vm.expectRevert(
            abi.encodeWithSelector(FerryLock.WrongState.selector, FerryLock.State.Claimed)
        );
        lock.claim(id, Z_SHARE, 0);
    }

    function test_claim_relayerTip() public {
        bytes32 id = lockReady();
        vm.expectEmit(address(lock));
        emit Claimed(id, Z_SHARE, relayer, MAX_TIP);
        vm.prank(relayer);
        lock.claim(id, Z_SHARE, MAX_TIP);
        assertEq(usdc.balanceOf(relayer), MAX_TIP);
        assertEq(usdc.balanceOf(zPayout), AMOUNT - MAX_TIP);
    }

    function test_claim_tipAboveMaxReverts() public {
        bytes32 id = lockReady();
        vm.prank(relayer);
        vm.expectRevert(FerryLock.TipTooHigh.selector);
        lock.claim(id, Z_SHARE, MAX_TIP + 1);
    }

    function testFuzz_claim_tipSplit(uint256 tip) public {
        tip = bound(tip, 0, MAX_TIP);
        bytes32 id = lockReady();
        vm.prank(relayer);
        lock.claim(id, Z_SHARE, tip);
        assertEq(usdc.balanceOf(relayer) + usdc.balanceOf(zPayout), AMOUNT);
        assertEq(usdc.balanceOf(relayer), tip);
    }

    // ---- refund ----

    function test_refund_window() public {
        bytes32 id = doLock();
        uint256 before = usdc.balanceOf(b);

        vm.warp(t1 - 1);
        vm.expectRevert(FerryLock.TooEarly.selector);
        lock.refund(id, B_SHARE);

        vm.warp(t2);
        vm.expectRevert(FerryLock.TooLate.selector);
        lock.refund(id, B_SHARE);

        vm.warp(t1);
        vm.expectRevert(FerryLock.BadScalar.selector);
        lock.refund(id, Z_SHARE);

        vm.expectEmit(address(lock));
        emit Refunded(id, B_SHARE);
        vm.prank(b);
        lock.refund(id, B_SHARE);
        assertEq(usdc.balanceOf(b), before + AMOUNT);
        assertEq(uint8(state(id)), uint8(FerryLock.State.Refunded));

        vm.expectRevert(
            abi.encodeWithSelector(FerryLock.WrongState.selector, FerryLock.State.Refunded)
        );
        lock.punish(id);
    }

    function test_refund_lastSecond() public {
        bytes32 id = doLock();
        vm.warp(t2 - 1);
        lock.refund(id, B_SHARE);
        assertEq(uint8(state(id)), uint8(FerryLock.State.Refunded));
    }

    function test_refund_afterReadyButUnclaimed() public {
        bytes32 id = lockReady();
        vm.warp(t1);
        // Anyone holding b may send it; the tokens only go to the refunder.
        vm.prank(relayer);
        lock.refund(id, B_SHARE);
        assertEq(usdc.balanceOf(b), 1_000e6);
        assertEq(usdc.balanceOf(relayer), 0);
    }

    function test_refund_afterClaimReverts() public {
        bytes32 id = lockReady();
        lock.claim(id, Z_SHARE, 0);
        vm.warp(t1);
        vm.expectRevert(
            abi.encodeWithSelector(FerryLock.WrongState.selector, FerryLock.State.Claimed)
        );
        lock.refund(id, B_SHARE);
    }

    // ---- punish ----

    function test_punish() public {
        bytes32 id = doLock();
        vm.warp(t2 - 1);
        vm.expectRevert(FerryLock.TooEarly.selector);
        lock.punish(id);

        vm.warp(t2);
        vm.expectEmit(address(lock));
        emit Punished(id);
        vm.prank(relayer);
        lock.punish(id);
        assertEq(usdc.balanceOf(zPayout), AMOUNT);
        assertEq(uint8(state(id)), uint8(FerryLock.State.Punished));

        vm.expectRevert(
            abi.encodeWithSelector(FerryLock.WrongState.selector, FerryLock.State.Punished)
        );
        lock.refund(id, B_SHARE);
    }

    function test_punish_afterReady() public {
        bytes32 id = lockReady();
        vm.warp(t2 + 1 days);
        lock.punish(id);
        assertEq(usdc.balanceOf(zPayout), AMOUNT);
    }

    function test_punish_afterClaimReverts() public {
        bytes32 id = lockReady();
        lock.claim(id, Z_SHARE, 0);
        vm.warp(t2);
        vm.expectRevert(
            abi.encodeWithSelector(FerryLock.WrongState.selector, FerryLock.State.Claimed)
        );
        lock.punish(id);
    }

    // ---- token handling ----

    function test_noReturnTokenWorks() public {
        NoReturnToken t = new NoReturnToken();
        t.mint(b, AMOUNT);
        vm.prank(b);
        bytes32 id = lock.lock(SALT, terms(address(t)));
        vm.prank(b);
        lock.ready(id);
        lock.claim(id, Z_SHARE, 0);
        assertEq(t.balanceOf(zPayout), AMOUNT);
    }

    function test_falseReturningTransferReverts() public {
        FalseOnTransfer t = new FalseOnTransfer();
        t.mint(b, AMOUNT);
        vm.prank(b);
        bytes32 id = lock.lock(SALT, terms(address(t)));
        vm.prank(b);
        lock.ready(id);
        vm.expectRevert(FerryLock.TransferFailed.selector);
        lock.claim(id, Z_SHARE, 0);
        // The failed claim rolled back: still Ready.
        assertEq(uint8(state(id)), uint8(FerryLock.State.Ready));
    }

    function test_reentrancyBlocked() public {
        ReentrantToken t = new ReentrantToken();
        t.mint(b, AMOUNT);
        vm.prank(b);
        bytes32 id = lock.lock(SALT, terms(address(t)));
        vm.prank(b);
        lock.ready(id);
        t.arm(lock, id, Z_SHARE);
        // The inner claim hits the guard, so the token's transfer (and the claim) fails.
        vm.expectRevert(FerryLock.TransferFailed.selector);
        lock.claim(id, Z_SHARE, 0);
        assertEq(uint8(state(id)), uint8(FerryLock.State.Ready));
    }
}
