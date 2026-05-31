// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FHE, InEbool, InEuint128, ebool, euint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

contract DarkPoolDex is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant PRICE_SCALE = 1e18;
    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 1_000;
    uint256 public constant MAX_BATCH_MATCHES = 20;
    uint8 public constant MATCH_INVALID_BUY_ESCROW = 1;
    uint8 public constant MATCH_INVALID_SELL_ESCROW = 2;

    IERC20 public immutable baseToken;
    IERC20 public immutable quoteToken;
    uint8 public immutable baseTokenDecimals;
    uint8 public immutable quoteTokenDecimals;
    uint256 public immutable baseUnit;

    address public feeRecipient;
    bool public paused;
    bool public permissionlessMatching = true;
    bool public publicFillReveal = true;
    uint32 public batchDuration;
    uint16 public makerFeeBps;
    uint16 public takerFeeBps;
    uint128 public minFillAmount = 1;
    uint128 public maxFillAmount;
    uint256 public maxQuoteValue;
    uint256 public protocolBaseFees;
    uint256 public protocolQuoteFees;
    uint256 public nextOrderId = 1;
    uint256 public nextMatchId = 1;

    mapping(address user => uint256 amount) public baseBalance;
    mapping(address user => uint256 amount) public quoteBalance;
    mapping(address user => uint256 amount) public reservedBaseBalance;
    mapping(address user => uint256 amount) public reservedQuoteBalance;
    mapping(address keeper => bool active) public keepers;
    mapping(address trader => mapping(address operator => bool active)) public disclosureOperators;
    mapping(bytes32 pairKey => bool finalized) public finalizedPairAttempts;

    struct Order {
        address trader;
        uint64 expiry;
        uint64 createdAt;
        uint64 fillNonce;
        uint256 batchId;
        bool cancelled;
        bool filled;
        uint128 totalFilled;
        uint256 reservedBase;
        uint256 reservedQuote;
        euint128 price;
        euint128 originalAmount;
        euint128 remainingAmount;
        ebool isBuy;
    }

    struct MatchIntent {
        uint256 buyOrderId;
        uint256 sellOrderId;
        uint256 batchId;
        uint64 createdAt;
        uint64 buyFillNonce;
        uint64 sellFillNonce;
        bool finalized;
        bool buyIsTaker;
        bool publicFillReveal;
        uint16 makerFeeBps;
        uint16 takerFeeBps;
        uint128 minFillAmount;
        uint128 maxFillAmount;
        uint256 maxQuoteValue;
        ebool matched;
        ebool buyFilled;
        ebool sellFilled;
        euint128 fillAmount;
        euint128 fillPrice;
        euint128 buyRemainingAfter;
        euint128 sellRemainingAfter;
    }

    mapping(uint256 orderId => Order order) private _orders;
    mapping(uint256 matchId => MatchIntent intent) private _matches;

    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event OrderPlaced(uint256 indexed orderId, address indexed trader, uint64 expiry, uint256 indexed batchId);
    event OrderCancelled(uint256 indexed orderId, address indexed trader, uint128 totalFilled);
    event OrderReserveLocked(uint256 indexed orderId, address indexed trader, uint256 baseAmount, uint256 quoteAmount);
    event OrderReserveReleased(uint256 indexed orderId, address indexed trader, uint256 baseAmount, uint256 quoteAmount);
    event MatchPrepared(
        uint256 indexed matchId,
        uint256 indexed buyOrderId,
        uint256 indexed sellOrderId,
        uint256 batchId,
        bool buyIsTaker,
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
        uint256 quotePaid,
        uint256 makerFee,
        uint256 takerFee,
        bool buyOrderFilled,
        bool sellOrderFilled
    );
    event MatchInvalidated(uint256 indexed matchId, uint256 indexed buyOrderId, uint256 indexed sellOrderId, uint8 reason);
    event KeeperSet(address indexed keeper, bool active);
    event PermissionlessMatchingSet(bool enabled);
    event PublicFillRevealSet(bool enabled);
    event MarketPausedSet(bool paused);
    event FeeConfigUpdated(uint16 makerFeeBps, uint16 takerFeeBps, address indexed feeRecipient);
    event RiskLimitsUpdated(uint128 minFillAmount, uint128 maxFillAmount, uint256 maxQuoteValue);
    event BatchDurationUpdated(uint32 batchDuration);
    event ProtocolFeesWithdrawn(address indexed to, uint256 baseAmount, uint256 quoteAmount);
    event DisclosureOperatorSet(address indexed trader, address indexed operator, bool active);
    event OrderDisclosureGranted(uint256 indexed orderId, address indexed trader, address indexed viewer);
    event MatchDisclosureGranted(uint256 indexed matchId, address indexed viewer);

    error AmountZero();
    error BatchOpen();
    error ExpiredOrder();
    error FeeTooHigh();
    error InsufficientEscrow();
    error InvalidConfig();
    error InvalidExpiry();
    error InvalidMatch();
    error InvalidOrder();
    error InvalidRecipient();
    error LengthMismatch();
    error MarketPaused();
    error MatchingRestricted();
    error NotOrderOwner();
    error OrderClosed();
    error PairAlreadyFinalized();
    error ReserveRequired();
    error RiskLimitExceeded();
    error SameTrader();
    error SignatureInvalid();
    error StaleMatch();
    error WrongBatch();

    constructor(IERC20 baseToken_, IERC20 quoteToken_) Ownable(msg.sender) {
        if (address(baseToken_) == address(0) || address(quoteToken_) == address(0)) revert InvalidRecipient();

        baseToken = baseToken_;
        quoteToken = quoteToken_;
        baseTokenDecimals = IERC20Metadata(address(baseToken_)).decimals();
        quoteTokenDecimals = IERC20Metadata(address(quoteToken_)).decimals();
        baseUnit = 10 ** uint256(baseTokenDecimals);
        feeRecipient = msg.sender;
    }

    modifier whenMarketOpen() {
        if (paused) revert MarketPaused();
        _;
    }

    modifier onlyMatcher() {
        if (!permissionlessMatching && !keepers[msg.sender] && msg.sender != owner()) {
            revert MatchingRestricted();
        }
        _;
    }

    function setKeeper(address keeper, bool active) external onlyOwner {
        if (keeper == address(0)) revert InvalidRecipient();
        keepers[keeper] = active;
        emit KeeperSet(keeper, active);
    }

    function setPermissionlessMatching(bool enabled) external onlyOwner {
        permissionlessMatching = enabled;
        emit PermissionlessMatchingSet(enabled);
    }

    function setPublicFillReveal(bool enabled) external onlyOwner {
        publicFillReveal = enabled;
        emit PublicFillRevealSet(enabled);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit MarketPausedSet(paused_);
    }

    function setFeeConfig(uint16 makerFeeBps_, uint16 takerFeeBps_, address feeRecipient_) external onlyOwner {
        if (makerFeeBps_ > MAX_FEE_BPS || takerFeeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeRecipient_ == address(0)) revert InvalidRecipient();

        makerFeeBps = makerFeeBps_;
        takerFeeBps = takerFeeBps_;
        feeRecipient = feeRecipient_;
        emit FeeConfigUpdated(makerFeeBps_, takerFeeBps_, feeRecipient_);
    }

    function setRiskLimits(uint128 minFillAmount_, uint128 maxFillAmount_, uint256 maxQuoteValue_) external onlyOwner {
        if (maxFillAmount_ != 0 && maxFillAmount_ < minFillAmount_) revert InvalidConfig();

        minFillAmount = minFillAmount_;
        maxFillAmount = maxFillAmount_;
        maxQuoteValue = maxQuoteValue_;
        emit RiskLimitsUpdated(minFillAmount_, maxFillAmount_, maxQuoteValue_);
    }

    function setBatchDuration(uint32 batchDuration_) external onlyOwner {
        if (nextOrderId != 1) revert InvalidConfig();
        batchDuration = batchDuration_;
        emit BatchDurationUpdated(batchDuration_);
    }

    function setDisclosureOperator(address operator, bool active) external {
        if (operator == address(0)) revert InvalidRecipient();
        disclosureOperators[msg.sender][operator] = active;
        emit DisclosureOperatorSet(msg.sender, operator, active);
    }

    function depositBase(uint256 amount) external nonReentrant {
        if (amount == 0) revert AmountZero();
        uint256 balanceBefore = baseToken.balanceOf(address(this));
        baseToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = baseToken.balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert AmountZero();

        baseBalance[msg.sender] += received;
        emit Deposited(msg.sender, address(baseToken), received);
    }

    function depositQuote(uint256 amount) external nonReentrant {
        if (amount == 0) revert AmountZero();
        uint256 balanceBefore = quoteToken.balanceOf(address(this));
        quoteToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = quoteToken.balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert AmountZero();

        quoteBalance[msg.sender] += received;
        emit Deposited(msg.sender, address(quoteToken), received);
    }

    function withdrawBase(uint256 amount) external nonReentrant {
        if (amount == 0) revert AmountZero();
        if (availableBaseBalance(msg.sender) < amount) revert InsufficientEscrow();
        baseBalance[msg.sender] -= amount;
        baseToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, address(baseToken), amount);
    }

    function withdrawQuote(uint256 amount) external nonReentrant {
        if (amount == 0) revert AmountZero();
        if (availableQuoteBalance(msg.sender) < amount) revert InsufficientEscrow();
        quoteBalance[msg.sender] -= amount;
        quoteToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, address(quoteToken), amount);
    }

    function withdrawProtocolFees(address to, uint256 baseAmount, uint256 quoteAmount) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidRecipient();
        if (to != feeRecipient) revert InvalidRecipient();
        if (baseAmount > protocolBaseFees || quoteAmount > protocolQuoteFees) revert InsufficientEscrow();

        protocolBaseFees -= baseAmount;
        protocolQuoteFees -= quoteAmount;

        if (baseAmount != 0) baseToken.safeTransfer(to, baseAmount);
        if (quoteAmount != 0) quoteToken.safeTransfer(to, quoteAmount);

        emit ProtocolFeesWithdrawn(to, baseAmount, quoteAmount);
    }

    function placeOrder(
        InEuint128 memory encryptedPrice,
        InEuint128 memory encryptedAmount,
        InEbool memory encryptedIsBuy,
        uint64 expiry
    ) external whenMarketOpen returns (uint256 orderId) {
        if (expiry <= block.timestamp) revert InvalidExpiry();

        euint128 price = FHE.asEuint128(encryptedPrice);
        euint128 amount = FHE.asEuint128(encryptedAmount);
        ebool isBuy = FHE.asEbool(encryptedIsBuy);
        uint256 batchId = currentBatchId();

        orderId = nextOrderId++;
        Order storage order = _orders[orderId];
        order.trader = msg.sender;
        order.expiry = expiry;
        order.createdAt = uint64(block.timestamp);
        order.batchId = batchId;
        order.price = price;
        order.originalAmount = amount;
        order.remainingAmount = amount;
        order.isBuy = isBuy;

        _allowOrderHandles(order, msg.sender);
        emit OrderPlaced(orderId, msg.sender, expiry, batchId);
    }

    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage order = _orders[orderId];
        if (order.trader == address(0)) revert InvalidOrder();
        if (order.trader != msg.sender) revert NotOrderOwner();
        if (order.cancelled || order.filled) revert OrderClosed();

        order.cancelled = true;
        _releaseOrderReserves(orderId, order);
        emit OrderCancelled(orderId, msg.sender, order.totalFilled);
    }

    function tryMatch(uint256 buyOrderId, uint256 sellOrderId)
        external
        whenMarketOpen
        onlyMatcher
        returns (uint256 matchId)
    {
        return _prepareMatch(buyOrderId, sellOrderId, 0, false);
    }

    function tryBatchMatch(uint256 batchId, uint256 buyOrderId, uint256 sellOrderId)
        external
        whenMarketOpen
        onlyMatcher
        returns (uint256 matchId)
    {
        return _prepareMatch(buyOrderId, sellOrderId, batchId, true);
    }

    function tryBatchMatches(uint256 batchId, uint256[] calldata buyOrderIds, uint256[] calldata sellOrderIds)
        external
        whenMarketOpen
        onlyMatcher
        returns (uint256[] memory matchIds)
    {
        if (buyOrderIds.length != sellOrderIds.length) revert LengthMismatch();
        if (buyOrderIds.length > MAX_BATCH_MATCHES) revert InvalidConfig();

        matchIds = new uint256[](buyOrderIds.length);
        for (uint256 i = 0; i < buyOrderIds.length; ++i) {
            matchIds[i] = _prepareMatch(buyOrderIds[i], sellOrderIds[i], batchId, true);
        }
    }

    function finalizeMatch(
        uint256 matchId,
        bool matchedPlaintext,
        bytes calldata matchedSignature,
        uint128 fillAmountPlaintext,
        bytes calldata fillAmountSignature,
        uint128 fillPricePlaintext,
        bytes calldata fillPriceSignature,
        bool buyFilledPlaintext,
        bytes calldata buyFilledSignature,
        bool sellFilledPlaintext,
        bytes calldata sellFilledSignature
    ) external nonReentrant {
        MatchIntent storage intent = _matches[matchId];
        if (intent.buyOrderId == 0 || intent.sellOrderId == 0 || intent.finalized) revert InvalidMatch();

        Order storage buyOrder = _orders[intent.buyOrderId];
        Order storage sellOrder = _orders[intent.sellOrderId];
        if (buyOrder.fillNonce != intent.buyFillNonce || sellOrder.fillNonce != intent.sellFillNonce) {
            revert StaleMatch();
        }

        bool valid = FHE.verifyDecryptResult(intent.matched, matchedPlaintext, matchedSignature)
            && FHE.verifyDecryptResult(intent.fillAmount, fillAmountPlaintext, fillAmountSignature)
            && FHE.verifyDecryptResult(intent.fillPrice, fillPricePlaintext, fillPriceSignature)
            && FHE.verifyDecryptResult(intent.buyFilled, buyFilledPlaintext, buyFilledSignature)
            && FHE.verifyDecryptResult(intent.sellFilled, sellFilledPlaintext, sellFilledSignature);
        if (!valid) revert SignatureInvalid();

        intent.finalized = true;
        bytes32 pairKey = _pairKey(intent.buyOrderId, intent.sellOrderId);
        finalizedPairAttempts[pairKey] = true;

        if (!matchedPlaintext) {
            emit MatchFinalized(matchId, intent.buyOrderId, intent.sellOrderId, false, 0, 0, 0, 0, 0, false, false);
            return;
        }

        if (fillAmountPlaintext == 0 || fillPricePlaintext == 0) revert AmountZero();
        if (buyOrder.cancelled || sellOrder.cancelled || buyOrder.filled || sellOrder.filled) revert OrderClosed();
        if (buyOrder.expiry <= block.timestamp || sellOrder.expiry <= block.timestamp) revert ExpiredOrder();

        uint256 quotePaid = quoteAmountFor(fillAmountPlaintext, fillPricePlaintext);
        if (quotePaid == 0) revert AmountZero();
        _enforceRiskLimits(
            fillAmountPlaintext,
            quotePaid,
            intent.minFillAmount,
            intent.maxFillAmount,
            intent.maxQuoteValue
        );

        uint256 makerFee = (quotePaid * intent.makerFeeBps) / BPS;
        uint256 takerFee = (quotePaid * intent.takerFeeBps) / BPS;
        uint256 buyerFee = intent.buyIsTaker ? takerFee : makerFee;
        uint256 sellerFee = intent.buyIsTaker ? makerFee : takerFee;
        uint256 buyerDebit = quotePaid + buyerFee;
        uint256 sellerCredit = quotePaid - sellerFee;

        if (quoteBalance[buyOrder.trader] < buyerDebit) {
            buyOrder.cancelled = true;
            _releaseOrderReserves(intent.buyOrderId, buyOrder);
            emit MatchInvalidated(matchId, intent.buyOrderId, intent.sellOrderId, MATCH_INVALID_BUY_ESCROW);
            return;
        }
        if (baseBalance[sellOrder.trader] < fillAmountPlaintext) {
            sellOrder.cancelled = true;
            _releaseOrderReserves(intent.sellOrderId, sellOrder);
            emit MatchInvalidated(matchId, intent.buyOrderId, intent.sellOrderId, MATCH_INVALID_SELL_ESCROW);
            return;
        }

        quoteBalance[buyOrder.trader] -= buyerDebit;
        quoteBalance[sellOrder.trader] += sellerCredit;
        baseBalance[sellOrder.trader] -= fillAmountPlaintext;
        baseBalance[buyOrder.trader] += fillAmountPlaintext;
        protocolQuoteFees += buyerFee + sellerFee;

        buyOrder.remainingAmount = intent.buyRemainingAfter;
        sellOrder.remainingAmount = intent.sellRemainingAfter;
        buyOrder.totalFilled += fillAmountPlaintext;
        sellOrder.totalFilled += fillAmountPlaintext;
        buyOrder.fillNonce += 1;
        sellOrder.fillNonce += 1;
        buyOrder.filled = buyFilledPlaintext;
        sellOrder.filled = sellFilledPlaintext;
        if (buyFilledPlaintext) _releaseOrderReserves(intent.buyOrderId, buyOrder);
        if (sellFilledPlaintext) _releaseOrderReserves(intent.sellOrderId, sellOrder);
        _allowOrderHandles(buyOrder, buyOrder.trader);
        _allowOrderHandles(sellOrder, sellOrder.trader);

        emit MatchFinalized(
            matchId,
            intent.buyOrderId,
            intent.sellOrderId,
            true,
            fillAmountPlaintext,
            fillPricePlaintext,
            quotePaid,
            makerFee,
            takerFee,
            buyFilledPlaintext,
            sellFilledPlaintext
        );
    }

    function grantOrderDisclosure(uint256 orderId, address viewer) external {
        if (viewer == address(0)) revert InvalidRecipient();

        Order storage order = _orders[orderId];
        if (order.trader == address(0)) revert InvalidOrder();
        if (!_canGrantDisclosure(order.trader, msg.sender)) revert NotOrderOwner();

        FHE.allow(order.price, viewer);
        FHE.allow(order.originalAmount, viewer);
        FHE.allow(order.remainingAmount, viewer);
        FHE.allow(order.isBuy, viewer);

        emit OrderDisclosureGranted(orderId, order.trader, viewer);
    }

    function grantMatchDisclosure(uint256 matchId, address viewer) external {
        if (viewer == address(0)) revert InvalidRecipient();

        MatchIntent storage intent = _matches[matchId];
        if (intent.buyOrderId == 0 || intent.sellOrderId == 0) revert InvalidMatch();

        Order storage buyOrder = _orders[intent.buyOrderId];
        Order storage sellOrder = _orders[intent.sellOrderId];
        if (
            msg.sender != owner() && msg.sender != buyOrder.trader && msg.sender != sellOrder.trader
                && !disclosureOperators[buyOrder.trader][msg.sender]
                && !disclosureOperators[sellOrder.trader][msg.sender]
        ) {
            revert NotOrderOwner();
        }

        _allowMatchHandles(intent, viewer);
        emit MatchDisclosureGranted(matchId, viewer);
    }

    function quoteAmountFor(uint128 baseAmount, uint128 price) public view returns (uint256) {
        return (uint256(baseAmount) * uint256(price)) / baseUnit;
    }

    function availableBaseBalance(address user) public view returns (uint256) {
        return baseBalance[user] - reservedBaseBalance[user];
    }

    function availableQuoteBalance(address user) public view returns (uint256) {
        return quoteBalance[user] - reservedQuoteBalance[user];
    }

    function currentBatchId() public view returns (uint256) {
        if (batchDuration == 0) return 0;
        return block.timestamp / batchDuration;
    }

    function isBatchClosed(uint256 batchId) public view returns (bool) {
        if (batchDuration == 0) return true;
        return block.timestamp >= (batchId + 1) * uint256(batchDuration);
    }

    function getOrderMeta(uint256 orderId)
        external
        view
        returns (
            address trader,
            uint64 expiry,
            uint64 createdAt,
            uint64 fillNonce,
            uint256 batchId,
            bool cancelled,
            bool filled,
            uint128 totalFilled,
            uint256 reservedBase,
            uint256 reservedQuote
        )
    {
        Order storage order = _orders[orderId];
        return (
            order.trader,
            order.expiry,
            order.createdAt,
            order.fillNonce,
            order.batchId,
            order.cancelled,
            order.filled,
            order.totalFilled,
            order.reservedBase,
            order.reservedQuote
        );
    }

    function getOrderHandles(uint256 orderId)
        external
        view
        returns (euint128 price, euint128 originalAmount, euint128 remainingAmount, ebool isBuy)
    {
        Order storage order = _orders[orderId];
        return (order.price, order.originalAmount, order.remainingAmount, order.isBuy);
    }

    function getMatchMeta(uint256 matchId)
        external
        view
        returns (
            uint256 buyOrderId,
            uint256 sellOrderId,
            uint256 batchId,
            uint64 createdAt,
            bool finalized,
            bool buyIsTaker,
            uint16 matchMakerFeeBps,
            uint16 matchTakerFeeBps,
            bool matchPublicFillReveal,
            uint128 matchMinFillAmount,
            uint128 matchMaxFillAmount,
            uint256 matchMaxQuoteValue
        )
    {
        MatchIntent storage intent = _matches[matchId];
        return (
            intent.buyOrderId,
            intent.sellOrderId,
            intent.batchId,
            intent.createdAt,
            intent.finalized,
            intent.buyIsTaker,
            intent.makerFeeBps,
            intent.takerFeeBps,
            intent.publicFillReveal,
            intent.minFillAmount,
            intent.maxFillAmount,
            intent.maxQuoteValue
        );
    }

    function getMatchHandles(uint256 matchId)
        external
        view
        returns (ebool matched, euint128 fillAmount, euint128 fillPrice, ebool buyFilled, ebool sellFilled)
    {
        MatchIntent storage intent = _matches[matchId];
        return (intent.matched, intent.fillAmount, intent.fillPrice, intent.buyFilled, intent.sellFilled);
    }

    function _prepareMatch(uint256 buyOrderId, uint256 sellOrderId, uint256 batchId, bool enforceBatch)
        private
        returns (uint256 matchId)
    {
        Order storage buyOrder = _activeOrder(buyOrderId);
        Order storage sellOrder = _activeOrder(sellOrderId);
        if (buyOrder.trader == sellOrder.trader) revert SameTrader();

        bytes32 pairKey = _pairKey(buyOrderId, sellOrderId);
        if (finalizedPairAttempts[pairKey]) revert PairAlreadyFinalized();

        uint256 matchBatchId = _validateBatchWindow(buyOrder, sellOrder, batchId, enforceBatch);

        ebool sellSide = FHE.not(sellOrder.isBuy);
        ebool sidesCross = FHE.and(buyOrder.isBuy, sellSide);
        ebool priceCross = FHE.gte(buyOrder.price, sellOrder.price);
        ebool matched = FHE.and(sidesCross, priceCross);

        euint128 rawFillAmount = FHE.min(buyOrder.remainingAmount, sellOrder.remainingAmount);
        euint128 zero = FHE.asEuint128(0);
        euint128 fillAmount = FHE.select(matched, rawFillAmount, zero);
        euint128 fillPrice = FHE.select(matched, sellOrder.price, zero);
        euint128 buyRemainingAfter = FHE.sub(buyOrder.remainingAmount, fillAmount);
        euint128 sellRemainingAfter = FHE.sub(sellOrder.remainingAmount, fillAmount);
        ebool buyFilled = FHE.eq(buyRemainingAfter, zero);
        ebool sellFilled = FHE.eq(sellRemainingAfter, zero);

        bool buyIsTaker =
            buyOrder.createdAt > sellOrder.createdAt || (buyOrder.createdAt == sellOrder.createdAt && buyOrderId > sellOrderId);

        matchId = nextMatchId++;
        MatchIntent storage intent = _matches[matchId];
        intent.buyOrderId = buyOrderId;
        intent.sellOrderId = sellOrderId;
        intent.batchId = matchBatchId;
        intent.createdAt = uint64(block.timestamp);
        intent.buyFillNonce = buyOrder.fillNonce;
        intent.sellFillNonce = sellOrder.fillNonce;
        intent.buyIsTaker = buyIsTaker;
        intent.publicFillReveal = publicFillReveal;
        intent.makerFeeBps = makerFeeBps;
        intent.takerFeeBps = takerFeeBps;
        intent.minFillAmount = minFillAmount;
        intent.maxFillAmount = maxFillAmount;
        intent.maxQuoteValue = maxQuoteValue;
        intent.matched = matched;
        intent.buyFilled = buyFilled;
        intent.sellFilled = sellFilled;
        intent.fillAmount = fillAmount;
        intent.fillPrice = fillPrice;
        intent.buyRemainingAfter = buyRemainingAfter;
        intent.sellRemainingAfter = sellRemainingAfter;

        if (intent.publicFillReveal || msg.sender == owner() || keepers[msg.sender]) {
            _allowMatchHandles(intent, msg.sender);
        }
        _allowMatchHandles(intent, buyOrder.trader);
        _allowMatchHandles(intent, sellOrder.trader);
        _allowRemainingHandles(intent);

        emit MatchPrepared(matchId, buyOrderId, sellOrderId, matchBatchId, buyIsTaker, matched, fillAmount, fillPrice);
    }

    function _activeOrder(uint256 orderId) private view returns (Order storage order) {
        order = _orders[orderId];
        if (order.trader == address(0)) revert InvalidOrder();
        if (order.cancelled || order.filled) revert OrderClosed();
        if (order.expiry <= block.timestamp) revert ExpiredOrder();
    }

    function _validateBatchWindow(
        Order storage buyOrder,
        Order storage sellOrder,
        uint256 batchId,
        bool enforceBatch
    ) private view returns (uint256 matchBatchId) {
        if (enforceBatch) {
            if (buyOrder.batchId != batchId || sellOrder.batchId != batchId) revert WrongBatch();
            if (!isBatchClosed(batchId)) revert BatchOpen();
            return batchId;
        }

        if (batchDuration == 0) return 0;

        matchBatchId = buyOrder.batchId > sellOrder.batchId ? buyOrder.batchId : sellOrder.batchId;
        if (!isBatchClosed(matchBatchId)) revert BatchOpen();
    }

    function _enforceRiskLimits(
        uint128 fillAmount,
        uint256 quotePaid,
        uint128 minFillAmount_,
        uint128 maxFillAmount_,
        uint256 maxQuoteValue_
    ) private pure {
        if (fillAmount < minFillAmount_) revert RiskLimitExceeded();
        if (maxFillAmount_ != 0 && fillAmount > maxFillAmount_) revert RiskLimitExceeded();
        if (maxQuoteValue_ != 0 && quotePaid > maxQuoteValue_) revert RiskLimitExceeded();
    }

    function _releaseOrderReserves(uint256 orderId, Order storage order) private {
        uint256 baseAmount = order.reservedBase;
        uint256 quoteAmount = order.reservedQuote;
        if (baseAmount == 0 && quoteAmount == 0) return;

        order.reservedBase = 0;
        order.reservedQuote = 0;
        reservedBaseBalance[order.trader] -= baseAmount;
        reservedQuoteBalance[order.trader] -= quoteAmount;
        emit OrderReserveReleased(orderId, order.trader, baseAmount, quoteAmount);
    }

    function _allowOrderHandles(Order storage order, address viewer) private {
        FHE.allowThis(order.price);
        FHE.allowThis(order.originalAmount);
        FHE.allowThis(order.remainingAmount);
        FHE.allowThis(order.isBuy);
        FHE.allow(order.price, viewer);
        FHE.allow(order.originalAmount, viewer);
        FHE.allow(order.remainingAmount, viewer);
        FHE.allow(order.isBuy, viewer);
    }

    function _allowMatchHandles(MatchIntent storage intent, address viewer) private {
        _allowMatchBool(intent.matched, viewer);
        _allowMatchBool(intent.buyFilled, viewer);
        _allowMatchBool(intent.sellFilled, viewer);
        _allowMatchUint(intent.fillAmount, viewer);
        _allowMatchUint(intent.fillPrice, viewer);
        if (intent.publicFillReveal) _allowMatchPublic(intent);
    }

    function _allowMatchBool(ebool handle, address viewer) private {
        FHE.allowThis(handle);
        FHE.allow(handle, viewer);
    }

    function _allowMatchUint(euint128 handle, address viewer) private {
        FHE.allowThis(handle);
        FHE.allow(handle, viewer);
    }

    function _allowRemainingHandles(MatchIntent storage intent) private {
        FHE.allowThis(intent.buyRemainingAfter);
        FHE.allowThis(intent.sellRemainingAfter);
    }

    function _allowMatchPublic(MatchIntent storage intent) private {
        FHE.allowPublic(intent.matched);
        FHE.allowPublic(intent.buyFilled);
        FHE.allowPublic(intent.sellFilled);
        FHE.allowPublic(intent.fillAmount);
        FHE.allowPublic(intent.fillPrice);
    }

    function _canGrantDisclosure(address trader, address caller) private view returns (bool) {
        return caller == trader || caller == owner() || disclosureOperators[trader][caller];
    }

    function _pairKey(uint256 buyOrderId, uint256 sellOrderId) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(buyOrderId, sellOrderId));
    }
}
