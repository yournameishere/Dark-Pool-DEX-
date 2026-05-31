import hre from "hardhat";
import { expect } from "chai";
import { Encryptable } from "@cofhe/sdk";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { CofheClient } from "@cofhe/sdk";
import type { DarkPoolDex, MockToken } from "../typechain-types";

const ONE = 10n ** 18n;
const BPS = 10_000n;

function toBool(value: bigint): boolean {
  return value !== 0n;
}

describe("DarkPoolDex", function () {
  let deployer: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let seller: HardhatEthersSigner;
  let secondSeller: HardhatEthersSigner;
  let keeper: HardhatEthersSigner;

  async function deployFixture() {
    [deployer, buyer, seller, secondSeller, keeper] = await hre.ethers.getSigners();

    const base = (await hre.ethers.deployContract("MockToken", [
      "Mock Wrapped Ether",
      "mWETH",
      10n * ONE,
    ], deployer)) as unknown as MockToken;
    const quote = (await hre.ethers.deployContract("MockToken", [
      "Mock USD",
      "mUSD",
      50_000n * ONE,
    ], deployer)) as unknown as MockToken;
    const dex = (await hre.ethers.deployContract(
      "DarkPoolDex",
      [await base.getAddress(), await quote.getAddress()],
      deployer,
    )) as unknown as DarkPoolDex;

    await base.waitForDeployment();
    await quote.waitForDeployment();
    await dex.waitForDeployment();

    return { base, quote, dex };
  }

  async function expiry(seconds = 3_600n) {
    const latestBlock = await hre.ethers.provider.getBlock("latest");
    if (!latestBlock) throw new Error("Latest block unavailable");
    return BigInt(latestBlock.timestamp) + seconds;
  }

  async function encryptedOrder(client: CofheClient, price: bigint, amount: bigint, isBuy: boolean) {
    return client
      .encryptInputs([Encryptable.uint128(price), Encryptable.uint128(amount), Encryptable.bool(isBuy)])
      .execute();
  }

  async function placeOrder(
    dex: DarkPoolDex,
    trader: HardhatEthersSigner,
    client: CofheClient,
    price: bigint,
    amount: bigint,
    isBuy: boolean,
  ) {
    const orderId = await dex.nextOrderId();
    const [encPrice, encAmount, encSide] = await encryptedOrder(client, price, amount, isBuy);
    await dex.connect(trader).placeOrder(encPrice, encAmount, encSide, await expiry());
    return orderId;
  }

  async function decryptMatch(client: CofheClient, dex: DarkPoolDex, matchId: bigint, withPermit = false) {
    if (withPermit) {
      await client.permits.getOrCreateSelfPermit();
    }
    const decrypt = (handle: bigint | string) => {
      const request = client.decryptForTx(handle);
      return withPermit ? request.withPermit().execute() : request.withoutPermit().execute();
    };
    const handles = await dex.getMatchHandles(matchId);
    const matched = await decrypt(handles.matched);
    const fillAmount = await decrypt(handles.fillAmount);
    const fillPrice = await decrypt(handles.fillPrice);
    const buyFilled = await decrypt(handles.buyFilled);
    const sellFilled = await decrypt(handles.sellFilled);

    return {
      matched,
      fillAmount,
      fillPrice,
      buyFilled,
      sellFilled,
      matchedPlaintext: toBool(matched.decryptedValue),
      buyFilledPlaintext: toBool(buyFilled.decryptedValue),
      sellFilledPlaintext: toBool(sellFilled.decryptedValue),
    };
  }

  async function finalizeFrom(client: CofheClient, dex: DarkPoolDex, matchId: bigint) {
    const result = await decryptMatch(client, dex, matchId);
    await dex.finalizeMatch(
      matchId,
      result.matchedPlaintext,
      result.matched.signature,
      result.fillAmount.decryptedValue,
      result.fillAmount.signature,
      result.fillPrice.decryptedValue,
      result.fillPrice.signature,
      result.buyFilledPlaintext,
      result.buyFilled.signature,
      result.sellFilledPlaintext,
      result.sellFilled.signature,
    );
    return result;
  }

  async function fundAndDeposit(
    base: MockToken,
    quote: MockToken,
    dex: DarkPoolDex,
    trader: HardhatEthersSigner,
    baseAmount: bigint,
    quoteAmount: bigint,
  ) {
    if (baseAmount > 0n) {
      await base.mint(trader.address, baseAmount);
      await base.connect(trader).approve(await dex.getAddress(), baseAmount);
      await dex.connect(trader).depositBase(baseAmount);
    }

    if (quoteAmount > 0n) {
      await quote.mint(trader.address, quoteAmount);
      await quote.connect(trader).approve(await dex.getAddress(), quoteAmount);
      await dex.connect(trader).depositQuote(quoteAmount);
    }
  }

  it("places encrypted orders, partially fills them, and settles remaining quantity across fills", async function () {
    const { base, quote, dex } = await deployFixture();

    const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
    const sellerClient = await hre.cofhe.createClientWithBatteries(seller);
    const secondSellerClient = await hre.cofhe.createClientWithBatteries(secondSeller);

    const bidPrice = 2_000n * ONE;
    const askPrice = 1_990n * ONE;
    const buyAmount = 5n * ONE;
    const firstSellAmount = 2n * ONE;
    const secondSellAmount = 3n * ONE;
    const quoteDeposit = 12_000n * ONE;

    await fundAndDeposit(base, quote, dex, buyer, 0n, quoteDeposit);
    await fundAndDeposit(base, quote, dex, seller, firstSellAmount, 0n);
    await fundAndDeposit(base, quote, dex, secondSeller, secondSellAmount, 0n);

    const buyOrderId = await placeOrder(dex, buyer, buyerClient, bidPrice, buyAmount, true);
    const firstSellOrderId = await placeOrder(dex, seller, sellerClient, askPrice, firstSellAmount, false);
    const secondSellOrderId = await placeOrder(
      dex,
      secondSeller,
      secondSellerClient,
      askPrice,
      secondSellAmount,
      false,
    );

    const firstMatchId = await dex.nextMatchId();
    await dex.tryMatch(buyOrderId, firstSellOrderId);
    const firstFill = await finalizeFrom(buyerClient, dex, firstMatchId);

    expect(firstFill.matchedPlaintext).to.equal(true);
    expect(firstFill.fillAmount.decryptedValue).to.equal(firstSellAmount);
    expect(firstFill.buyFilledPlaintext).to.equal(false);
    expect(firstFill.sellFilledPlaintext).to.equal(true);

    const buyMetaAfterFirst = await dex.getOrderMeta(buyOrderId);
    const firstSellMeta = await dex.getOrderMeta(firstSellOrderId);
    expect(buyMetaAfterFirst.filled).to.equal(false);
    expect(buyMetaAfterFirst.totalFilled).to.equal(firstSellAmount);
    expect(firstSellMeta.filled).to.equal(true);

    const secondMatchId = await dex.nextMatchId();
    await dex.tryMatch(buyOrderId, secondSellOrderId);
    const secondFill = await finalizeFrom(buyerClient, dex, secondMatchId);

    expect(secondFill.fillAmount.decryptedValue).to.equal(secondSellAmount);
    expect(secondFill.buyFilledPlaintext).to.equal(true);
    expect(secondFill.sellFilledPlaintext).to.equal(true);

    const quotePaid = ((firstSellAmount + secondSellAmount) * askPrice) / ONE;
    expect(await dex.baseBalance(buyer.address)).to.equal(buyAmount);
    expect(await dex.baseBalance(seller.address)).to.equal(0n);
    expect(await dex.baseBalance(secondSeller.address)).to.equal(0n);
    expect(await dex.quoteBalance(buyer.address)).to.equal(quoteDeposit - quotePaid);
    expect(await dex.quoteBalance(seller.address)).to.equal((firstSellAmount * askPrice) / ONE);
    expect(await dex.quoteBalance(secondSeller.address)).to.equal((secondSellAmount * askPrice) / ONE);

    const buyMetaFinal = await dex.getOrderMeta(buyOrderId);
    expect(buyMetaFinal.filled).to.equal(true);
    expect(buyMetaFinal.fillNonce).to.equal(2n);
    expect(buyMetaFinal.totalFilled).to.equal(buyAmount);
  });

  it("finalizes a non-crossing pair without moving escrow", async function () {
    const { base, quote, dex } = await deployFixture();

    const amount = 1n * ONE;
    const bidPrice = 1_900n * ONE;
    const askPrice = 2_000n * ONE;
    const quoteDeposit = 3_000n * ONE;

    await fundAndDeposit(base, quote, dex, buyer, 0n, quoteDeposit);
    await fundAndDeposit(base, quote, dex, seller, amount, 0n);

    const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
    const sellerClient = await hre.cofhe.createClientWithBatteries(seller);

    const buyOrderId = await placeOrder(dex, buyer, buyerClient, bidPrice, amount, true);
    const sellOrderId = await placeOrder(dex, seller, sellerClient, askPrice, amount, false);
    const matchId = await dex.nextMatchId();

    await dex.tryMatch(buyOrderId, sellOrderId);
    const result = await finalizeFrom(buyerClient, dex, matchId);

    expect(result.matchedPlaintext).to.equal(false);
    expect(await dex.baseBalance(seller.address)).to.equal(amount);
    expect(await dex.quoteBalance(buyer.address)).to.equal(quoteDeposit);
  });

  it("settles with trader permit decryption when public fill reveal is disabled", async function () {
    const { base, quote, dex } = await deployFixture();

    const amount = 1n * ONE;
    const bidPrice = 2_000n * ONE;
    const askPrice = 1_990n * ONE;
    const quoteDeposit = 3_000n * ONE;

    await dex.setPublicFillReveal(false);
    await fundAndDeposit(base, quote, dex, buyer, 0n, quoteDeposit);
    await fundAndDeposit(base, quote, dex, seller, amount, 0n);

    const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
    const sellerClient = await hre.cofhe.createClientWithBatteries(seller);

    const buyOrderId = await placeOrder(dex, buyer, buyerClient, bidPrice, amount, true);
    const sellOrderId = await placeOrder(dex, seller, sellerClient, askPrice, amount, false);
    const matchId = await dex.nextMatchId();

    await dex.tryMatch(buyOrderId, sellOrderId);
    const result = await decryptMatch(buyerClient, dex, matchId, true);
    await dex.finalizeMatch(
      matchId,
      result.matchedPlaintext,
      result.matched.signature,
      result.fillAmount.decryptedValue,
      result.fillAmount.signature,
      result.fillPrice.decryptedValue,
      result.fillPrice.signature,
      result.buyFilledPlaintext,
      result.buyFilled.signature,
      result.sellFilledPlaintext,
      result.sellFilled.signature,
    );

    expect(result.matchedPlaintext).to.equal(true);
    expect(await dex.baseBalance(buyer.address)).to.equal(amount);
    expect(await dex.quoteBalance(seller.address)).to.equal((amount * askPrice) / ONE);
  });

  it("prevents stale prepared matches from overfilling an order", async function () {
    const { base, quote, dex } = await deployFixture();

    const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
    const sellerClient = await hre.cofhe.createClientWithBatteries(seller);
    const secondSellerClient = await hre.cofhe.createClientWithBatteries(secondSeller);

    const amount = 2n * ONE;
    const price = 1_990n * ONE;
    await fundAndDeposit(base, quote, dex, buyer, 0n, 10_000n * ONE);
    await fundAndDeposit(base, quote, dex, seller, amount, 0n);
    await fundAndDeposit(base, quote, dex, secondSeller, amount, 0n);

    const buyOrderId = await placeOrder(dex, buyer, buyerClient, 2_000n * ONE, amount, true);
    const sellOrderId = await placeOrder(dex, seller, sellerClient, price, amount, false);
    const secondSellOrderId = await placeOrder(dex, secondSeller, secondSellerClient, price, amount, false);

    const firstMatchId = await dex.nextMatchId();
    await dex.tryMatch(buyOrderId, sellOrderId);
    const staleMatchId = await dex.nextMatchId();
    await dex.tryMatch(buyOrderId, secondSellOrderId);

    await finalizeFrom(buyerClient, dex, firstMatchId);

    const staleResult = await decryptMatch(buyerClient, dex, staleMatchId);
    await expect(
      dex.finalizeMatch(
        staleMatchId,
        staleResult.matchedPlaintext,
        staleResult.matched.signature,
        staleResult.fillAmount.decryptedValue,
        staleResult.fillAmount.signature,
        staleResult.fillPrice.decryptedValue,
        staleResult.fillPrice.signature,
        staleResult.buyFilledPlaintext,
        staleResult.buyFilled.signature,
        staleResult.sellFilledPlaintext,
        staleResult.sellFilled.signature,
      ),
    ).to.be.revertedWithCustomError(dex, "StaleMatch");
  });

  it("accounts maker and taker fees in quote escrow and lets the owner withdraw them", async function () {
    const { base, quote, dex } = await deployFixture();

    const amount = 2n * ONE;
    const askPrice = 1_990n * ONE;
    const quoteDeposit = 5_000n * ONE;
    const makerFeeBps = 10n;
    const takerFeeBps = 20n;

    await dex.setFeeConfig(Number(makerFeeBps), Number(takerFeeBps), deployer.address);
    await fundAndDeposit(base, quote, dex, seller, amount, 0n);
    await fundAndDeposit(base, quote, dex, buyer, 0n, quoteDeposit);

    const sellerClient = await hre.cofhe.createClientWithBatteries(seller);
    const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
    const sellOrderId = await placeOrder(dex, seller, sellerClient, askPrice, amount, false);
    const buyOrderId = await placeOrder(dex, buyer, buyerClient, 2_000n * ONE, amount, true);

    const matchId = await dex.nextMatchId();
    await dex.tryMatch(buyOrderId, sellOrderId);
    await dex.setFeeConfig(100, 200, deployer.address);
    await finalizeFrom(buyerClient, dex, matchId);

    const quotePaid = (amount * askPrice) / ONE;
    const makerFee = (quotePaid * makerFeeBps) / BPS;
    const takerFee = (quotePaid * takerFeeBps) / BPS;

    expect(await dex.quoteBalance(buyer.address)).to.equal(quoteDeposit - quotePaid - takerFee);
    expect(await dex.quoteBalance(seller.address)).to.equal(quotePaid - makerFee);
    expect(await dex.protocolQuoteFees()).to.equal(makerFee + takerFee);

    await expect(dex.withdrawProtocolFees(secondSeller.address, 0, makerFee + takerFee)).to.be.revertedWithCustomError(
      dex,
      "InvalidRecipient",
    );
    await expect(dex.withdrawProtocolFees(deployer.address, 0, makerFee + takerFee))
      .to.emit(dex, "ProtocolFeesWithdrawn")
      .withArgs(deployer.address, 0, makerFee + takerFee);
  });

  it("does not lock public per-order reserves that reveal encrypted order side or size", async function () {
    const { base, quote, dex } = await deployFixture();

    const sellerClient = await hre.cofhe.createClientWithBatteries(seller);
    const amount = 2n * ONE;

    await fundAndDeposit(base, quote, dex, seller, amount, 0n);
    const sellOrderId = await placeOrder(dex, seller, sellerClient, 1_990n * ONE, amount, false);

    const meta = await dex.getOrderMeta(sellOrderId);
    expect(meta.reservedBase).to.equal(0n);
    expect(meta.reservedQuote).to.equal(0n);
    expect(await dex.reservedBaseBalance(seller.address)).to.equal(0n);
    expect(await dex.availableBaseBalance(seller.address)).to.equal(amount);

    await dex.connect(seller).cancelOrder(sellOrderId);
    expect(await dex.reservedBaseBalance(seller.address)).to.equal(0n);
    await expect(dex.connect(seller).withdrawBase(amount)).to.emit(dex, "Withdrawn");
  });

  it("invalidates matches when settlement escrow is no longer available", async function () {
    const { base, quote, dex } = await deployFixture();

    const amount = 1n * ONE;
    const bidPrice = 2_000n * ONE;
    const askPrice = 1_990n * ONE;
    const quoteDeposit = 3_000n * ONE;

    await fundAndDeposit(base, quote, dex, buyer, 0n, quoteDeposit);
    await fundAndDeposit(base, quote, dex, seller, amount, 0n);

    const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
    const sellerClient = await hre.cofhe.createClientWithBatteries(seller);

    const buyOrderId = await placeOrder(dex, buyer, buyerClient, bidPrice, amount, true);
    const sellOrderId = await placeOrder(dex, seller, sellerClient, askPrice, amount, false);
    await dex.connect(seller).withdrawBase(amount);
    const matchId = await dex.nextMatchId();

    await dex.tryMatch(buyOrderId, sellOrderId);
    const result = await decryptMatch(buyerClient, dex, matchId);

    await expect(
      dex.finalizeMatch(
        matchId,
        result.matchedPlaintext,
        result.matched.signature,
        result.fillAmount.decryptedValue,
        result.fillAmount.signature,
        result.fillPrice.decryptedValue,
        result.fillPrice.signature,
        result.buyFilledPlaintext,
        result.buyFilled.signature,
        result.sellFilledPlaintext,
        result.sellFilled.signature,
      ),
    )
      .to.emit(dex, "MatchInvalidated")
      .withArgs(matchId, buyOrderId, sellOrderId, await dex.MATCH_INVALID_SELL_ESCROW());

    const sellMeta = await dex.getOrderMeta(sellOrderId);
    expect(sellMeta.cancelled).to.equal(true);
    await expect(dex.tryMatch(buyOrderId, sellOrderId)).to.be.revertedWithCustomError(dex, "OrderClosed");
  });

  it("uses match-time reveal and fee snapshots when config changes before finalization", async function () {
    const { base, quote, dex } = await deployFixture();

    const amount = 1n * ONE;
    const bidPrice = 2_000n * ONE;
    const askPrice = 1_990n * ONE;

    await dex.setFeeConfig(10, 20, deployer.address);
    await dex.setPublicFillReveal(false);
    await fundAndDeposit(base, quote, dex, buyer, 0n, 3_000n * ONE);
    await fundAndDeposit(base, quote, dex, seller, amount, 0n);

    const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
    const sellerClient = await hre.cofhe.createClientWithBatteries(seller);
    const buyOrderId = await placeOrder(dex, buyer, buyerClient, bidPrice, amount, true);
    const sellOrderId = await placeOrder(dex, seller, sellerClient, askPrice, amount, false);

    const matchId = await dex.nextMatchId();
    await dex.tryMatch(buyOrderId, sellOrderId);
    await dex.setFeeConfig(100, 200, deployer.address);
    await dex.setPublicFillReveal(true);

    const meta = await dex.getMatchMeta(matchId);
    expect(meta.matchMakerFeeBps).to.equal(10n);
    expect(meta.matchTakerFeeBps).to.equal(20n);
    expect(meta.matchPublicFillReveal).to.equal(false);
    expect(meta.matchMinFillAmount).to.equal(1n);
    expect(meta.matchMaxFillAmount).to.equal(0n);
    expect(meta.matchMaxQuoteValue).to.equal(0n);

    const result = await decryptMatch(buyerClient, dex, matchId, true);
    await dex.finalizeMatch(
      matchId,
      result.matchedPlaintext,
      result.matched.signature,
      result.fillAmount.decryptedValue,
      result.fillAmount.signature,
      result.fillPrice.decryptedValue,
      result.fillPrice.signature,
      result.buyFilledPlaintext,
      result.buyFilled.signature,
      result.sellFilledPlaintext,
      result.sellFilled.signature,
    );
  });

  it("uses match-time risk snapshots when limits change before finalization", async function () {
    const { base, quote, dex } = await deployFixture();

    const amount = 2n * ONE;
    const askPrice = 1_990n * ONE;

    await dex.setRiskLimits(1, 0, 0);
    await fundAndDeposit(base, quote, dex, buyer, 0n, 5_000n * ONE);
    await fundAndDeposit(base, quote, dex, seller, amount, 0n);

    const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
    const sellerClient = await hre.cofhe.createClientWithBatteries(seller);
    const buyOrderId = await placeOrder(dex, buyer, buyerClient, 2_000n * ONE, amount, true);
    const sellOrderId = await placeOrder(dex, seller, sellerClient, askPrice, amount, false);

    const matchId = await dex.nextMatchId();
    await dex.tryMatch(buyOrderId, sellOrderId);
    await dex.setRiskLimits(3n * ONE, 0, 0);

    const result = await finalizeFrom(buyerClient, dex, matchId);
    expect(result.matchedPlaintext).to.equal(true);
    expect(await dex.baseBalance(buyer.address)).to.equal(amount);
  });

  it("rejects matched fills whose quote payment rounds to zero", async function () {
    const { base, quote, dex } = await deployFixture();

    await fundAndDeposit(base, quote, dex, buyer, 0n, 1n);
    await fundAndDeposit(base, quote, dex, seller, 1n, 0n);

    const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
    const sellerClient = await hre.cofhe.createClientWithBatteries(seller);
    const buyOrderId = await placeOrder(dex, buyer, buyerClient, 1n, 1n, true);
    const sellOrderId = await placeOrder(dex, seller, sellerClient, 1n, 1n, false);

    const matchId = await dex.nextMatchId();
    await dex.tryMatch(buyOrderId, sellOrderId);
    const result = await decryptMatch(buyerClient, dex, matchId);

    await expect(
      dex.finalizeMatch(
        matchId,
        result.matchedPlaintext,
        result.matched.signature,
        result.fillAmount.decryptedValue,
        result.fillAmount.signature,
        result.fillPrice.decryptedValue,
        result.fillPrice.signature,
        result.buyFilledPlaintext,
        result.buyFilled.signature,
        result.sellFilledPlaintext,
        result.sellFilled.signature,
      ),
    ).to.be.revertedWithCustomError(dex, "AmountZero");
  });

  it("enforces keeper permissions when permissionless matching is disabled", async function () {
    const { base, quote, dex } = await deployFixture();

    const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
    const sellerClient = await hre.cofhe.createClientWithBatteries(seller);

    await fundAndDeposit(base, quote, dex, buyer, 0n, 5_000n * ONE);
    await fundAndDeposit(base, quote, dex, seller, 1n * ONE, 0n);

    const buyOrderId = await placeOrder(dex, buyer, buyerClient, 2_000n * ONE, 1n * ONE, true);
    const sellOrderId = await placeOrder(dex, seller, sellerClient, 1_990n * ONE, 1n * ONE, false);

    await dex.setPermissionlessMatching(false);
    await expect(dex.connect(secondSeller).tryMatch(buyOrderId, sellOrderId)).to.be.revertedWithCustomError(
      dex,
      "MatchingRestricted",
    );

    await dex.setKeeper(keeper.address, true);
    await expect(dex.connect(keeper).tryMatch(buyOrderId, sellOrderId)).to.emit(dex, "MatchPrepared");
  });

  it("requires configured batches to close before batch matching", async function () {
    const { base, quote, dex } = await deployFixture();

    await dex.setBatchDuration(60);

    const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
    const sellerClient = await hre.cofhe.createClientWithBatteries(seller);

    await fundAndDeposit(base, quote, dex, buyer, 0n, 5_000n * ONE);
    await fundAndDeposit(base, quote, dex, seller, 1n * ONE, 0n);

    const latest = await hre.ethers.provider.getBlock("latest");
    if (!latest) throw new Error("Latest block unavailable");
    await hre.ethers.provider.send("evm_setNextBlockTimestamp", [
      latest.timestamp - (latest.timestamp % 60) + 61,
    ]);

    const buyOrderId = await placeOrder(dex, buyer, buyerClient, 2_000n * ONE, 1n * ONE, true);
    const sellOrderId = await placeOrder(dex, seller, sellerClient, 1_990n * ONE, 1n * ONE, false);
    const batchId = (await dex.getOrderMeta(buyOrderId)).batchId;
    expect((await dex.getOrderMeta(sellOrderId)).batchId).to.equal(batchId);

    await expect(dex.setBatchDuration(120)).to.be.revertedWithCustomError(dex, "InvalidConfig");
    await expect(dex.tryBatchMatch(batchId, buyOrderId, sellOrderId)).to.be.revertedWithCustomError(dex, "BatchOpen");

    await hre.ethers.provider.send("evm_increaseTime", [61]);
    await hre.ethers.provider.send("evm_mine", []);

    await expect(dex.tryBatchMatch(batchId, buyOrderId, sellOrderId)).to.emit(dex, "MatchPrepared");
  });

  it("lets a trader cancel a partially filled encrypted order", async function () {
    const { base, quote, dex } = await deployFixture();

    const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
    const sellerClient = await hre.cofhe.createClientWithBatteries(seller);

    const buyAmount = 3n * ONE;
    const sellAmount = 1n * ONE;
    await fundAndDeposit(base, quote, dex, buyer, 0n, 8_000n * ONE);
    await fundAndDeposit(base, quote, dex, seller, sellAmount, 0n);

    const buyOrderId = await placeOrder(dex, buyer, buyerClient, 2_000n * ONE, buyAmount, true);
    const sellOrderId = await placeOrder(dex, seller, sellerClient, 1_990n * ONE, sellAmount, false);

    const matchId = await dex.nextMatchId();
    await dex.tryMatch(buyOrderId, sellOrderId);
    await finalizeFrom(buyerClient, dex, matchId);

    await expect(dex.connect(buyer).cancelOrder(buyOrderId))
      .to.emit(dex, "OrderCancelled")
      .withArgs(buyOrderId, buyer.address, sellAmount);

    const meta = await dex.getOrderMeta(buyOrderId);
    expect(meta.cancelled).to.equal(true);
    expect(meta.filled).to.equal(false);
  });
});
