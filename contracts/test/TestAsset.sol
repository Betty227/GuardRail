// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract TestAsset is ERC20 {
    constructor() ERC20("Local test asset", "TEST") { _mint(msg.sender, 10000000); }
    function decimals() public pure override returns (uint8) { return 6; }
}
