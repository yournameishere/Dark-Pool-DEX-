import hre from "hardhat";
import { expect } from "chai";
import { Encryptable } from "@cofhe/sdk";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { DarkPoolDex, MockToken } from "../typechain-types";

const ONE = 10n ** 18n;

function toBool(value: bigint): boolean {
  return value !== 0n;
}

describe("DarkPoolDex", function () {
  let deployer: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;
  let seller: HardhatEthersSigner;

  async function deployFixture() {
    [deployer, buyer, seller] = await hre.ethers.getSigners();

    const base = (await hre.ethers.deployContract("MockToken", [
      "Mock Wrapped Ether",
      "mWETH",
    ], deployer)) as unknown as MockToken;
    const quote = (await hre.ethers.deployContract("MockToken", [
      "Mock USD",
      "mUSD",
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

  it("places encrypted buy/sell orders, matches them with FHE ops, and settles with decryptForTx proofs", async function () {
    const { base, quote, dex } = await deployFixture();

    const amount = 2n * ONE;
    const bidPrice = 2_000n * ONE;
    const askPrice = 1_990n * ONE;
    const quoteDeposit = 5_000n * ONE;
    const quotePaid = (amount * askPrice) / ONE;

    await base.mint(seller.address, amount);
    await quote.mint(buyer.address, quoteDeposit);

    await base.connect(seller).approve(await dex.getAddress(), amount);
    await quote.connect(buyer).approve(await dex.getAddress(), quoteDeposit);
    await dex.connect(seller).depositBase(amount);
    await dex.connect(buyer).depositQuote(quoteDeposit);

    const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
    const sellerClient = await hre.cofhe.createClientWithBatteries(seller);

    const [encBidPrice, encBidAmount, encBuySide] = await buyerClient
      .encryptInputs([Encryptable.uint128(bidPrice), Encryptable.uint128(amount), Encryptable.bool(true)])
      .execute();
    const [encAskPrice, encAskAmount, encSellSide] = await sellerClient
      .encryptInputs([Encryptable.uint128(askPrice), Encryptable.uint128(amount), Encryptable.bool(false)])
      .execute();

    const now = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
    const expiry = now + 3_600n;

    await dex.connect(buyer).placeOrder(encBidPrice, encBidAmount, encBuySide, expiry);
    await dex.connect(seller).placeOrder(encAskPrice, encAskAmount, encSellSide, expiry);

    await dex.tryMatch(1, 2);

    const matchHandles = await dex.getMatchHandles(1);
    const matched = await buyerClient.decryptForTx(matchHandles.matched).withoutPermit().execute();
    const fillAmount = await buyerClient.decryptForTx(matchHandles.fillAmount).withoutPermit().execute();
    const fillPrice = await buyerClient.decryptForTx(matchHandles.fillPrice).withoutPermit().execute();

    expect(toBool(matched.decryptedValue)).to.equal(true);
    expect(fillAmount.decryptedValue).to.equal(amount);
    expect(fillPrice.decryptedValue).to.equal(askPrice);

    await expect(
      dex.finalizeMatch(
        1,
        toBool(matched.decryptedValue),
        matched.signature,
        fillAmount.decryptedValue,
        fillAmount.signature,
        fillPrice.decryptedValue,
        fillPrice.signature,
      ),
    )
      .to.emit(dex, "MatchFinalized")
      .withArgs(1, 1, 2, true, amount, askPrice, quotePaid);

    expect(await dex.baseBalance(buyer.address)).to.equal(amount);
    expect(await dex.baseBalance(seller.address)).to.equal(0n);
    expect(await dex.quoteBalance(buyer.address)).to.equal(quoteDeposit - quotePaid);
    expect(await dex.quoteBalance(seller.address)).to.equal(quotePaid);

    const buyMeta = await dex.getOrderMeta(1);
    const sellMeta = await dex.getOrderMeta(2);
    expect(buyMeta.filled).to.equal(true);
    expect(sellMeta.filled).to.equal(true);
  });

  it("finalizes a non-crossing pair without moving escrow", async function () {
    const { base, quote, dex } = await deployFixture();

    const amount = 1n * ONE;
    const bidPrice = 1_900n * ONE;
    const askPrice = 2_000n * ONE;
    const quoteDeposit = 3_000n * ONE;

    await base.mint(seller.address, amount);
    await quote.mint(buyer.address, quoteDeposit);
    await base.connect(seller).approve(await dex.getAddress(), amount);
    await quote.connect(buyer).approve(await dex.getAddress(), quoteDeposit);
    await dex.connect(seller).depositBase(amount);
    await dex.connect(buyer).depositQuote(quoteDeposit);

    const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
    const sellerClient = await hre.cofhe.createClientWithBatteries(seller);

    const [encBidPrice, encBidAmount, encBuySide] = await buyerClient
      .encryptInputs([Encryptable.uint128(bidPrice), Encryptable.uint128(amount), Encryptable.bool(true)])
      .execute();
    const [encAskPrice, encAskAmount, encSellSide] = await sellerClient
      .encryptInputs([Encryptable.uint128(askPrice), Encryptable.uint128(amount), Encryptable.bool(false)])
      .execute();

    const now = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
    const expiry = now + 3_600n;

    await dex.connect(buyer).placeOrder(encBidPrice, encBidAmount, encBuySide, expiry);
    await dex.connect(seller).placeOrder(encAskPrice, encAskAmount, encSellSide, expiry);
    await dex.tryMatch(1, 2);

    const matchHandles = await dex.getMatchHandles(1);
    const matched = await buyerClient.decryptForTx(matchHandles.matched).withoutPermit().execute();
    const fillAmount = await buyerClient.decryptForTx(matchHandles.fillAmount).withoutPermit().execute();
    const fillPrice = await buyerClient.decryptForTx(matchHandles.fillPrice).withoutPermit().execute();

    expect(toBool(matched.decryptedValue)).to.equal(false);

    await dex.finalizeMatch(
      1,
      toBool(matched.decryptedValue),
      matched.signature,
      fillAmount.decryptedValue,
      fillAmount.signature,
      fillPrice.decryptedValue,
      fillPrice.signature,
    );

    expect(await dex.baseBalance(seller.address)).to.equal(amount);
    expect(await dex.quoteBalance(buyer.address)).to.equal(quoteDeposit);
  });

  it("lets a trader cancel an open encrypted order", async function () {
    const { dex } = await deployFixture();
    const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
    const [encPrice, encAmount, encSide] = await buyerClient
      .encryptInputs([Encryptable.uint128(2_000n * ONE), Encryptable.uint128(ONE), Encryptable.bool(true)])
      .execute();
    const now = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);

    await dex.connect(buyer).placeOrder(encPrice, encAmount, encSide, now + 3_600n);
    await expect(dex.connect(buyer).cancelOrder(1)).to.emit(dex, "OrderCancelled").withArgs(1, buyer.address);

    const meta = await dex.getOrderMeta(1);
    expect(meta.cancelled).to.equal(true);
  });
});
