// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.24;

/// @notice Test-only WETH stand-in with WETH9's interface: 18 decimals, `deposit` wraps the ETH
/// sent with it, `withdraw` unwraps, and plain ETH sent to the contract is wrapped too. Unlike
/// WETH9 it also has an open `mint`, so tests can create balances no ETH backs (those cannot be
/// withdrawn once the contract runs out of ETH). Never deploy it where it could pass for WETH.
contract MockWETH {
    string public constant name = "Wrapped Ether";
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        totalSupply += msg.value;
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "balance");
        balanceOf[msg.sender] -= wad;
        totalSupply -= wad;
        emit Withdrawal(msg.sender, wad);
        (bool ok,) = msg.sender.call{value: wad}("");
        require(ok, "eth transfer");
    }

    /// Test-only: WETH without the ETH behind it.
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    /// As in WETH9: moving your own tokens needs no allowance, and a maximal allowance is
    /// never decreased.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (from != msg.sender) {
            uint256 allowed = allowance[from][msg.sender];
            if (allowed != type(uint256).max) {
                require(allowed >= amount, "allowance");
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
