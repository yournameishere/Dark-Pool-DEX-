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

  const amount = 2n * ONE;
  const bidPrice = 2_000n * ONE;
  const askPrice = 1_990n * ONE;
  const quoteDeposit = 5_000n * ONE;

  await base.connect(deployer).mint(seller.address, amount);
  await quote.connect(deployer).mint(buyer.address, quoteDeposit);
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

  const latestBlock = await hre.ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("Latest block unavailable");
  const expiry = BigInt(latestBlock.timestamp) + 3_600n;

  const buyOrderId = await dex.nextOrderId();
  await dex.connect(buyer).placeOrder(encBidPrice, encBidAmount, encBuySide, expiry);
  const sellOrderId = await dex.nextOrderId();
  await dex.connect(seller).placeOrder(encAskPrice, encAskAmount, encSellSide, expiry);

  const matchId = await dex.nextMatchId();
  await dex.tryMatch(buyOrderId, sellOrderId);

  const handles = await dex.getMatchHandles(matchId);
  const matched = await buyerClient.decryptForTx(handles.matched).withoutPermit().execute();
  const fillAmount = await buyerClient.decryptForTx(handles.fillAmount).withoutPermit().execute();
  const fillPrice = await buyerClient.decryptForTx(handles.fillPrice).withoutPermit().execute();

  await dex.finalizeMatch(
    matchId,
    matched.decryptedValue !== 0n,
    matched.signature,
    fillAmount.decryptedValue,
    fillAmount.signature,
    fillPrice.decryptedValue,
    fillPrice.signature,
  );

  console.log(`Demo matched: ${matched.decryptedValue !== 0n}`);
  console.log(`Buy order: ${buyOrderId.toString()}, sell order: ${sellOrderId.toString()}, match: ${matchId.toString()}`);
  console.log(`Buyer base escrow: ${(await dex.baseBalance(buyer.address)).toString()}`);
  console.log(`Seller quote escrow: ${(await dex.quoteBalance(seller.address)).toString()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
