// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {FerryLock} from "../src/FerryLock.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// Deploy FerryLock (and, with DEPLOY_MOCK_USDC=true, a MockUSDC for local or test networks).
///   anvil:        forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:18545 \
///                   --private-key $KEY --broadcast
///   Base Sepolia: forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org \
///                   --private-key $KEY --broadcast
/// Base Sepolia already has Circle's test USDC at 0x036CbD53842c5426634e7929541eC2318f3dCF7e.
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        FerryLock lock = new FerryLock();
        console.log("FerryLock", address(lock));
        if (vm.envOr("DEPLOY_MOCK_USDC", false)) {
            MockUSDC usdc = new MockUSDC();
            console.log("MockUSDC", address(usdc));
        }
        vm.stopBroadcast();
    }
}
