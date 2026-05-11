// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FHE, InEbool, InEuint128, ebool, euint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract DarkPoolDex is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant PRICE_SCALE = 1e18;

    IERC20 public immutable baseToken;
    IERC20 public immutable quoteToken;

    uint256 public nextOrderId = 1;
    uint256 public nextMatchId = 1;

    mapping(address user => uint256 amount) public baseBalance;
    mapping(address user => uint256 amount) public quoteBalance;

    struct Order {
        address trader;
        uint64 expiry;
        uint64 createdAt;
        bool cancelled;
        bool filled;
        euint128 price;
        euint128 amount;
        ebool isBuy;
    }

    struct MatchIntent {
        uint256 buyOrderId;
        uint256 sellOrderId;
        uint64 createdAt;
        bool finalized;
        ebool matched;
        euint128 fillAmount;
        euint128 fillPrice;
    }

    mapping(uint256 orderId => Order order) private _orders;
    mapping(uint256 matchId => MatchIntent intent) private _matches;

    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event OrderPlaced(uint256 indexed orderId, address indexed trader, uint64 expiry);
    event OrderCancelled(uint256 indexed orderId, address indexed trader);
    event MatchPrepared(
        uint256 indexed matchId,
        uint256 indexed buyOrderId,
        uint256 indexed sellOrderId,
        ebool matched,
        euint128 fillAmount,
        euint128 fillPrice
    );
    event MatchFinalized(
        uint256 indexed matchId,
        uint256 indexed buyOrderId,
        uint256 indexed sellOrderId,
        bool matched,
        uint128 fillAmount,
        uint128 fillPrice,
        uint256 quotePaid
    );

    error AmountZero();
    error ExpiredOrder();
    error InvalidExpiry();
    error InvalidOrder();
    error InvalidMatch();
    error NotOrderOwner();
    error OrderClosed();
    error SignatureInvalid();
    error InsufficientEscrow();
    error SameTrader();

    constructor(IERC20 baseToken_, IERC20 quoteToken_) Ownable(msg.sender) {
        baseToken = baseToken_;
        quoteToken = quoteToken_;
    }

    function depositBase(uint256 amount) external nonReentrant {
        if (amount == 0) revert AmountZero();
        baseBalance[msg.sender] += amount;
        baseToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, address(baseToken), amount);
    }

    function depositQuote(uint256 amount) external nonReentrant {
        if (amount == 0) revert AmountZero();
        quoteBalance[msg.sender] += amount;
        quoteToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, address(quoteToken), amount);
    }

    function withdrawBase(uint256 amount) external nonReentrant {
        if (amount == 0) revert AmountZero();
        if (baseBalance[msg.sender] < amount) revert InsufficientEscrow();
        baseBalance[msg.sender] -= amount;
        baseToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, address(baseToken), amount);
    }

    function withdrawQuote(uint256 amount) external nonReentrant {
        if (amount == 0) revert AmountZero();
        if (quoteBalance[msg.sender] < amount) revert InsufficientEscrow();
        quoteBalance[msg.sender] -= amount;
        quoteToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, address(quoteToken), amount);
    }

    function placeOrder(
        InEuint128 memory encryptedPrice,
        InEuint128 memory encryptedAmount,
        InEbool memory encryptedIsBuy,
        uint64 expiry
    ) external returns (uint256 orderId) {
        if (expiry <= block.timestamp) revert InvalidExpiry();

        euint128 price = FHE.asEuint128(encryptedPrice);
        euint128 amount = FHE.asEuint128(encryptedAmount);
        ebool isBuy = FHE.asEbool(encryptedIsBuy);

        FHE.allowThis(price);
        FHE.allowThis(amount);
        FHE.allowThis(isBuy);
        FHE.allowSender(price);
        FHE.allowSender(amount);
        FHE.allowSender(isBuy);

        orderId = nextOrderId++;
        _orders[orderId] = Order({
            trader: msg.sender,
            expiry: expiry,
            createdAt: uint64(block.timestamp),
            cancelled: false,
            filled: false,
            price: price,
            amount: amount,
            isBuy: isBuy
        });

        emit OrderPlaced(orderId, msg.sender, expiry);
    }

    function cancelOrder(uint256 orderId) external {
        Order storage order = _orders[orderId];
        if (order.trader == address(0)) revert InvalidOrder();
        if (order.trader != msg.sender) revert NotOrderOwner();
        if (order.cancelled || order.filled) revert OrderClosed();

        order.cancelled = true;
        emit OrderCancelled(orderId, msg.sender);
    }

    function tryMatch(uint256 buyOrderId, uint256 sellOrderId) external returns (uint256 matchId) {
        Order storage buyOrder = _activeOrder(buyOrderId);
        Order storage sellOrder = _activeOrder(sellOrderId);
        if (buyOrder.trader == sellOrder.trader) revert SameTrader();

        ebool sellSide = FHE.not(sellOrder.isBuy);
        ebool sidesCross = FHE.and(buyOrder.isBuy, sellSide);
        ebool priceCross = FHE.gte(buyOrder.price, sellOrder.price);
        ebool matched = FHE.and(sidesCross, priceCross);

        euint128 rawFillAmount = FHE.min(buyOrder.amount, sellOrder.amount);
        euint128 zero = FHE.asEuint128(0);
        euint128 fillAmount = FHE.select(matched, rawFillAmount, zero);
        euint128 fillPrice = FHE.select(matched, sellOrder.price, zero);

        FHE.allowThis(matched);
        FHE.allowThis(fillAmount);
        FHE.allowThis(fillPrice);
        FHE.allowPublic(matched);
        FHE.allowPublic(fillAmount);
        FHE.allowPublic(fillPrice);
        FHE.allow(matched, buyOrder.trader);
        FHE.allow(fillAmount, buyOrder.trader);
        FHE.allow(fillPrice, buyOrder.trader);
        FHE.allow(matched, sellOrder.trader);
        FHE.allow(fillAmount, sellOrder.trader);
        FHE.allow(fillPrice, sellOrder.trader);

        matchId = nextMatchId++;
        _matches[matchId] = MatchIntent({
            buyOrderId: buyOrderId,
            sellOrderId: sellOrderId,
            createdAt: uint64(block.timestamp),
            finalized: false,
            matched: matched,
            fillAmount: fillAmount,
            fillPrice: fillPrice
        });

        emit MatchPrepared(matchId, buyOrderId, sellOrderId, matched, fillAmount, fillPrice);
    }

    function finalizeMatch(
        uint256 matchId,
        bool matchedPlaintext,
        bytes calldata matchedSignature,
        uint128 fillAmountPlaintext,
        bytes calldata fillAmountSignature,
        uint128 fillPricePlaintext,
        bytes calldata fillPriceSignature
    ) external nonReentrant {
        MatchIntent storage intent = _matches[matchId];
        if (intent.buyOrderId == 0 || intent.sellOrderId == 0 || intent.finalized) revert InvalidMatch();

        bool valid = FHE.verifyDecryptResult(intent.matched, matchedPlaintext, matchedSignature)
            && FHE.verifyDecryptResult(intent.fillAmount, fillAmountPlaintext, fillAmountSignature)
            && FHE.verifyDecryptResult(intent.fillPrice, fillPricePlaintext, fillPriceSignature);
        if (!valid) revert SignatureInvalid();

        intent.finalized = true;

        if (!matchedPlaintext) {
            emit MatchFinalized(matchId, intent.buyOrderId, intent.sellOrderId, false, 0, 0, 0);
            return;
        }

        if (fillAmountPlaintext == 0 || fillPricePlaintext == 0) revert AmountZero();

        Order storage buyOrder = _orders[intent.buyOrderId];
        Order storage sellOrder = _orders[intent.sellOrderId];
        if (buyOrder.cancelled || sellOrder.cancelled || buyOrder.filled || sellOrder.filled) revert OrderClosed();

        uint256 quotePaid = (uint256(fillAmountPlaintext) * uint256(fillPricePlaintext)) / PRICE_SCALE;
        if (quoteBalance[buyOrder.trader] < quotePaid) revert InsufficientEscrow();
        if (baseBalance[sellOrder.trader] < fillAmountPlaintext) revert InsufficientEscrow();

        buyOrder.filled = true;
        sellOrder.filled = true;

        quoteBalance[buyOrder.trader] -= quotePaid;
        quoteBalance[sellOrder.trader] += quotePaid;
        baseBalance[sellOrder.trader] -= fillAmountPlaintext;
        baseBalance[buyOrder.trader] += fillAmountPlaintext;

        emit MatchFinalized(
            matchId,
            intent.buyOrderId,
            intent.sellOrderId,
            true,
            fillAmountPlaintext,
            fillPricePlaintext,
            quotePaid
        );
    }

    function getOrderMeta(
        uint256 orderId
    )
        external
        view
        returns (address trader, uint64 expiry, uint64 createdAt, bool cancelled, bool filled)
    {
        Order storage order = _orders[orderId];
        return (order.trader, order.expiry, order.createdAt, order.cancelled, order.filled);
    }

    function getOrderHandles(
        uint256 orderId
    ) external view returns (euint128 price, euint128 amount, ebool isBuy) {
        Order storage order = _orders[orderId];
        return (order.price, order.amount, order.isBuy);
    }

    function getMatchMeta(
        uint256 matchId
    ) external view returns (uint256 buyOrderId, uint256 sellOrderId, uint64 createdAt, bool finalized) {
        MatchIntent storage intent = _matches[matchId];
        return (intent.buyOrderId, intent.sellOrderId, intent.createdAt, intent.finalized);
    }

    function getMatchHandles(
        uint256 matchId
    ) external view returns (ebool matched, euint128 fillAmount, euint128 fillPrice) {
        MatchIntent storage intent = _matches[matchId];
        return (intent.matched, intent.fillAmount, intent.fillPrice);
    }

    function _activeOrder(uint256 orderId) private view returns (Order storage order) {
        order = _orders[orderId];
        if (order.trader == address(0)) revert InvalidOrder();
        if (order.cancelled || order.filled) revert OrderClosed();
        if (order.expiry <= block.timestamp) revert ExpiredOrder();
    }
}
