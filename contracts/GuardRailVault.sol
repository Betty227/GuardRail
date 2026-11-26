// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// One buyer per vault. Token amounts are in the settlement token's smallest units.
contract GuardRailVault is EIP712, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State { Missing, Reserved, Captured, Voided }
    struct Quote {
        address merchant;
        uint256 amount;
        bytes32 inputHash;
        bytes32 serviceVersion;
        bytes32 rulesVersion;
        uint64 deadline;
    }
    struct Payment {
        Quote quote;
        bytes32 quoteHash;
        uint256 budgetDay;
        State state;
    }
    bytes32 public constant RECEIPT_TYPEHASH = keccak256("Receipt(bytes32 paymentId,address merchant,uint256 amount,bytes32 inputHash,bytes32 outputHash,bytes32 rulesVersion,uint64 deadline)");
    IERC20 public immutable token;
    address public immutable verifier;
    address public agent;
    bool public paused;
    uint256 public perPaymentCap;
    uint256 public dailyCap;
    uint256 public reserved;
    mapping(address => bool) public merchants;
    mapping(uint256 => uint256) public dayUsed;
    mapping(bytes32 => Payment) private payments;

    event Reserved(bytes32 indexed paymentId, bytes32 indexed intentId, bytes32 quoteHash, uint256 budgetDay);
    event Captured(bytes32 indexed paymentId, bytes32 outputHash);
    event Voided(bytes32 indexed paymentId);

    constructor(IERC20 asset, address buyer, address signer) Ownable(buyer) EIP712("GuardRail", "1") {
        require(address(asset).code.length != 0 && signer != address(0), "configuration");
        token = asset;
        verifier = signer;
    }

    function setPolicy(address agent_, uint256 single, uint256 daily) external onlyOwner {
        agent = agent_; // Set to zero to revoke new purchases.
        perPaymentCap = single;
        dailyCap = daily;
    }

    function setMerchant(address merchant, bool allowed) external onlyOwner { merchants[merchant] = allowed; }
    function setPaused(bool value) external onlyOwner { paused = value; }

    function deposit(uint256 amount) external onlyOwner nonReentrant {
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        require(amount <= token.balanceOf(address(this)) - reserved, "reserved funds");
        token.safeTransfer(msg.sender, amount);
    }

    function payment(bytes32 id) external view returns (Payment memory) { return payments[id]; }

    function reserve(bytes32 intentId, Quote calldata q) external returns (bytes32 id) {
        require(msg.sender == agent || msg.sender == owner(), "buyer or agent");
        id = keccak256(abi.encode(address(this), intentId));
        Payment storage p = payments[id];
        bytes32 hash = keccak256(abi.encode(q));
        if (p.state != State.Missing) {
            require(p.quoteHash == hash, "intent conflict");
            return id;
        }
        require(!paused && q.deadline > block.timestamp && q.merchant != address(0) && merchants[q.merchant], "policy");
        require(q.amount > 0 && q.amount <= perPaymentCap, "single cap");
        uint256 day = (block.timestamp + 8 hours) / 1 days;
        require(dayUsed[day] + q.amount <= dailyCap, "daily cap");
        require(q.amount <= token.balanceOf(address(this)) - reserved, "funds");
        dayUsed[day] += q.amount;
        reserved += q.amount;
        payments[id] = Payment(q, hash, day, State.Reserved);
        emit Reserved(id, intentId, hash, day);
    }

    function capturePayment(bytes32 id, bytes32 outputHash, bytes calldata signature) external nonReentrant {
        Payment storage p = payments[id];
        Quote storage q = p.quote;
        require(!paused && p.state == State.Reserved && block.timestamp <= q.deadline, "not capturable");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(RECEIPT_TYPEHASH, id, q.merchant, q.amount, q.inputHash, outputHash, q.rulesVersion, q.deadline)));
        require(ECDSA.recover(digest, signature) == verifier, "invalid receipt");
        p.state = State.Captured;
        reserved -= q.amount;
        token.safeTransfer(q.merchant, q.amount);
        emit Captured(id, outputHash);
    }

    function voidPayment(bytes32 id) external {
        Payment storage p = payments[id];
        require(p.state == State.Reserved, "not reserved");
        require(msg.sender == owner() || msg.sender == verifier || block.timestamp > p.quote.deadline, "not voidable");
        p.state = State.Voided;
        reserved -= p.quote.amount;
        dayUsed[p.budgetDay] -= p.quote.amount;
        emit Voided(id);
    }
}
