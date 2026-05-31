// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MockToken is ERC20, Ownable {
    uint256 public immutable faucetAmount;

    mapping(address account => bool claimed) public faucetClaimed;

    event FaucetClaimed(address indexed account, uint256 amount);

    error FaucetAlreadyClaimed();
    error FaucetDisabled();

    constructor(string memory name_, string memory symbol_, uint256 faucetAmount_) ERC20(name_, symbol_) Ownable(msg.sender) {
        faucetAmount = faucetAmount_;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function claimFaucet() external {
        if (faucetAmount == 0) revert FaucetDisabled();
        if (faucetClaimed[msg.sender]) revert FaucetAlreadyClaimed();

        faucetClaimed[msg.sender] = true;
        _mint(msg.sender, faucetAmount);
        emit FaucetClaimed(msg.sender, faucetAmount);
    }
}
