import hre from "hardhat";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Encryptable } from "@cofhe/sdk";
import type { DarkPoolDex, MockToken } from "../typechain-types";

const ONE = 10n ** 18n;

type Deployment = {
  contracts: {
    darkPoolDex: string;
    baseToken: string;
    quoteToken: string;
  };
};

function toBool(value: bigint) {
  return value !== 0n;
}

async function main() {
  const deployment = JSON.parse(
    await readFile(path.join(process.cwd(), "deployments", "localhost.json"), "utf8"),
  ) as Deployment;

  const [deployer, buyer, seller] = await hre.ethers.getSigners();
  const dex = (await hre.ethers.getContractAt(
    "DarkPoolDex",
    deployment.contracts.darkPoolDex,
  )) as unknown as DarkPoolDex;
  const base = (await hre.ethers.getContractAt(
    "MockToken",
    deployment.contracts.baseToken,
  )) as unknown as MockToken;
  const quote = (await hre.ethers.getContractAt(
    "MockToken",
    deployment.contracts.quoteToken,
  )) as unknown as MockToken;

  const buyAmount = 3n * ONE;
  const sellAmount = 2n * ONE;
  const bidPrice = 2_000n * ONE;
  const askPrice = 1_990n * ONE;
  const quoteDeposit = 7_000n * ONE;

  await base.connect(deployer).mint(seller.address, sellAmount);
  await quote.connect(deployer).mint(buyer.address, quoteDeposit);
  await base.connect(seller).approve(await dex.getAddress(), sellAmount);
  await quote.connect(buyer).approve(await dex.getAddress(), quoteDeposit);
  await dex.connect(seller).depositBase(sellAmount);
  await dex.connect(buyer).depositQuote(quoteDeposit);

  const buyerClient = await hre.cofhe.createClientWithBatteries(buyer);
  const sellerClient = await hre.cofhe.createClientWithBatteries(seller);

  const [encBidPrice, encBidAmount, encBuySide] = await buyerClient
    .encryptInputs([Encryptable.uint128(bidPrice), Encryptable.uint128(buyAmount), Encryptable.bool(true)])
    .execute();
  const [encAskPrice, encAskAmount, encSellSide] = await sellerClient
    .encryptInputs([Encryptable.uint128(askPrice), Encryptable.uint128(sellAmount), Encryptable.bool(false)])
    .execute();

  const latestBlock = await hre.ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("Latest block unavailable");
  const expiry = BigInt(latestBlock.timestamp) + 3_600n;

  const buyOrderId = await dex.nextOrderId();
  await dex.connect(buyer).placeOrder(encBidPrice, encBidAmount, encBuySide, expiry);
  const sellOrderId = await dex.nextOrderId();
  await dex.connect(seller).placeOrder(encAskPrice, encAskAmount, encSellSide, expiry);

  const matchId = await dex.nextMatchId();
  const batchDuration = await dex.batchDuration();
  if (batchDuration === 0n) {
    await dex.tryMatch(buyOrderId, sellOrderId);
  } else {
    const buyMeta = await dex.getOrderMeta(buyOrderId);
    const sellMeta = await dex.getOrderMeta(sellOrderId);
    if (buyMeta.batchId !== sellMeta.batchId) {
      throw new Error(`Demo orders landed in different batches: ${buyMeta.batchId} and ${sellMeta.batchId}`);
    }

    const batchId = buyMeta.batchId;
    await hre.ethers.provider.send("evm_increaseTime", [Number(batchDuration) + 1]);
    await hre.ethers.provider.send("evm_mine", []);
    await dex.tryBatchMatch(batchId, buyOrderId, sellOrderId);
  }

  const handles = await dex.getMatchHandles(matchId);
  const matched = await buyerClient.decryptForTx(handles.matched).withoutPermit().execute();
  const fillAmount = await buyerClient.decryptForTx(handles.fillAmount).withoutPermit().execute();
  const fillPrice = await buyerClient.decryptForTx(handles.fillPrice).withoutPermit().execute();
  const buyFilled = await buyerClient.decryptForTx(handles.buyFilled).withoutPermit().execute();
  const sellFilled = await buyerClient.decryptForTx(handles.sellFilled).withoutPermit().execute();

  await dex.finalizeMatch(
    matchId,
    toBool(matched.decryptedValue),
    matched.signature,
    fillAmount.decryptedValue,
    fillAmount.signature,
    fillPrice.decryptedValue,
    fillPrice.signature,
    toBool(buyFilled.decryptedValue),
    buyFilled.signature,
    toBool(sellFilled.decryptedValue),
    sellFilled.signature,
  );

  console.log(`Demo matched: ${toBool(matched.decryptedValue)}`);
  console.log(`Buy order: ${buyOrderId.toString()}, sell order: ${sellOrderId.toString()}, match: ${matchId.toString()}`);
  console.log(`Fill amount: ${fillAmount.decryptedValue.toString()}, buy filled: ${toBool(buyFilled.decryptedValue)}`);
  console.log(`Buyer base escrow: ${(await dex.baseBalance(buyer.address)).toString()}`);
  console.log(`Seller quote escrow: ${(await dex.quoteBalance(seller.address)).toString()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
