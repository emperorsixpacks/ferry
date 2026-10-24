// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FerryLock} from "../src/FerryLock.sol";
import {MockWETH} from "../src/MockWETH.sol";

/// FerryLock with an 18-decimal token (WETH) at amounts far above anything 6-decimal USDC
/// reaches: 100 WETH is 1e20 base units, more than 2^64 (about 1.8e19). FerryLock keeps every
/// amount in uint256, so nothing here may depend on the token's decimals.
contract FerryLockWethTest is Test {
    uint256 constant Z_SHARE = 0x1d5a7c3e9b2f04a6c8e0f1b3d5a7c9e1f3b5d7f9a1c3e5f7091b2d3f4a5c6e7;
    uint256 constant B_SHARE = 0x2b4d6f8091a3c5e7f9b1d3f5a7c9e1b3d5f7091b2d3f4a5c6e7f8091a2b3c4d;
    /// 100 WETH: above 2^64 base units.
    uint256 constant AMOUNT = 100 ether;
    uint256 constant MAX_TIP = 0.05 ether;
    bytes32 constant SALT = keccak256("weth-session");

    FerryLock lock;
    MockWETH weth;
    address b;
    uint256 bKey;
    address zPayout = makeAddr("Z");
    address relayer = makeAddr("relayer");
    uint64 t1;
    uint64 t2;

    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    function setUp() public {
        (b, bKey) = makeAddrAndKey("B");
        vm.warp(1_700_000_000);
        lock = new FerryLock();
        weth = new MockWETH();
        // B wraps real (test) ETH, as a user would before swapping.
        vm.deal(b, 150 ether);
        vm.startPrank(b);
        weth.deposit{value: 120 ether}();
        weth.approve(address(lock), type(uint256).max);
        vm.stopPrank();
        t1 = uint64(block.timestamp + 1 hours);
        t2 = uint64(block.timestamp + 2 hours);
    }

    function terms(uint256 amount, uint256 maxTip) internal view returns (FerryLock.Terms memory) {
        return FerryLock.Terms({
            token: address(weth),
            amount: amount,
            zAddr: vm.addr(Z_SHARE),
            bAddr: vm.addr(B_SHARE),
            claimer: zPayout,
            refunder: b,
            t1: t1,
            t2: t2,
            maxTip: maxTip
        });
    }

    /// B's Ready(id) signature. It calls into the contract, so build it before any vm.prank.
    function readySig(bytes32 id) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(bKey, lock.readyDigest(id));
        return abi.encodePacked(r, s, v);
    }

    function state(bytes32 id) internal view returns (FerryLock.State s) {
        (, s) = lock.getSwap(id);
    }

    // ---- the mock itself ----

    function test_mock_isWeth9Shaped() public {
        assertEq(weth.symbol(), "WETH");
        assertEq(weth.decimals(), 18);
        assertEq(weth.name(), "Wrapped Ether");
        assertEq(weth.balanceOf(b), 120 ether);
        assertEq(weth.totalSupply(), 120 ether);

        // Plain ETH sent to the contract is wrapped; withdraw unwraps.
        address u = makeAddr("user");
        vm.deal(u, 3 ether);
        vm.prank(u);
        (bool ok,) = address(weth).call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(weth.balanceOf(u), 2 ether);
        vm.expectEmit(address(weth));
        emit Withdrawal(u, 1.5 ether);
        vm.prank(u);
        weth.withdraw(1.5 ether);
        assertEq(u.balance, 2.5 ether);
        assertEq(weth.balanceOf(u), 0.5 ether);
        vm.prank(u);
        vm.expectRevert(bytes("balance"));
        weth.withdraw(1 ether);
    }

    // ---- FerryLock at 18 decimals ----

    function test_lockAndClaim_100Weth_withTip() public {
        assertGt(AMOUNT, uint256(type(uint64).max));
        vm.prank(b);
        bytes32 id = lock.lock(SALT, terms(AMOUNT, MAX_TIP));
        (FerryLock.Terms memory t,) = lock.getSwap(id);
        assertEq(t.amount, AMOUNT);
        assertEq(weth.balanceOf(address(lock)), AMOUNT);
        assertEq(weth.balanceOf(b), 20 ether);

        bytes memory sig = readySig(id);
        vm.prank(relayer);
        lock.claim(id, Z_SHARE, MAX_TIP, sig);
        assertEq(weth.balanceOf(zPayout), AMOUNT - MAX_TIP);
        assertEq(weth.balanceOf(relayer), MAX_TIP);
        assertEq(weth.balanceOf(address(lock)), 0);
        assertEq(uint8(state(id)), uint8(FerryLock.State.Claimed));

        // Z unwraps what it received: WETH9's way out to plain ETH.
        vm.prank(zPayout);
        weth.withdraw(AMOUNT - MAX_TIP);
        assertEq(zPayout.balance, AMOUNT - MAX_TIP);
    }

    function test_refund_100Weth() public {
        vm.prank(b);
        bytes32 id = lock.lock(SALT, terms(AMOUNT, 0));
        vm.warp(t1);
        lock.refund(id, B_SHARE);
        assertEq(weth.balanceOf(b), 120 ether);
        assertEq(uint8(state(id)), uint8(FerryLock.State.Refunded));
    }

    function test_punish_100Weth() public {
        vm.prank(b);
        bytes32 id = lock.lock(SALT, terms(AMOUNT, 0));
        vm.warp(t2);
        vm.prank(relayer);
        lock.punish(id);
        assertEq(weth.balanceOf(zPayout), AMOUNT);
        assertEq(uint8(state(id)), uint8(FerryLock.State.Punished));
    }

    /// Near the top of the uint256 range the lock still claims to the last wei.
    function test_hugeAmount() public {
        (address whale, uint256 whaleKey) = makeAddrAndKey("whale");
        uint256 amount = type(uint256).max - weth.totalSupply();
        weth.mint(whale, amount);
        vm.startPrank(whale);
        weth.approve(address(lock), type(uint256).max);
        FerryLock.Terms memory t = terms(amount, amount);
        t.refunder = whale;
        bytes32 id = lock.lock(SALT, t);
        vm.stopPrank();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(whaleKey, lock.readyDigest(id));
        vm.prank(relayer);
        lock.claim(id, Z_SHARE, 7, abi.encodePacked(r, s, v));
        assertEq(weth.balanceOf(zPayout), amount - 7);
        assertEq(weth.balanceOf(relayer), 7);
    }

    /// Any amount and tip split exactly, with no rounding at 18 decimals.
    function testFuzz_lockClaim_largeAmounts(uint256 amount, uint256 tip) public {
        amount = bound(amount, 1, 1e30);
        tip = bound(tip, 0, amount);
        weth.mint(b, amount);
        uint256 before = weth.balanceOf(b);
        vm.prank(b);
        bytes32 id = lock.lock(SALT, terms(amount, tip));
        assertEq(weth.balanceOf(b), before - amount);
        bytes memory sig = readySig(id);
        vm.prank(relayer);
        lock.claim(id, Z_SHARE, tip, sig);
        assertEq(weth.balanceOf(zPayout), amount - tip);
        assertEq(weth.balanceOf(relayer), tip);
        assertEq(weth.balanceOf(address(lock)), 0);
    }

    /// Locking more than B holds or approved reverts at the token, before anything is locked.
    function test_lock_moreThanBalanceReverts() public {
        vm.prank(b);
        vm.expectRevert(FerryLock.TransferFailed.selector);
        lock.lock(SALT, terms(121 ether, 0));
        assertEq(uint8(state(lock.swapId(b, SALT))), uint8(FerryLock.State.None));
    }
}
