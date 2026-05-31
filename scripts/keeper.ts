import hre from "hardhat";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CofheClient } from "@cofhe/sdk";
import type { DarkPoolDex } from "../typechain-types";

type Deployment = {
  contracts: {
    darkPoolDex: string;
  };
};

type ActiveOrder = {
  id: bigint;
  batchId: bigint;
  createdAt: bigint;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  return raw && raw.trim() ? Number(raw) : fallback;
}

function toBool(value: bigint) {
  return value !== 0n;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(label: string, action: () => Promise<T>, retries = 2): Promise<T | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; ++attempt) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`${label} attempt ${attempt + 1} failed: ${message}`);
      if (attempt < retries) await sleep(1_000 * (attempt + 1));
    }
  }

  console.warn(`${label} skipped after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  return null;
}

async function loadDeployment() {
  const file = path.join(process.cwd(), "deployments", `${hre.network.name}.json`);
  return JSON.parse(await readFile(file, "utf8")) as Deployment;
}

async function getActiveOrders(dex: DarkPoolDex): Promise<ActiveOrder[]> {
  const latest = await hre.ethers.provider.getBlock("latest");
  if (!latest) throw new Error("Latest block unavailable");

  const nextOrderId = await dex.nextOrderId();
  const active: ActiveOrder[] = [];

  for (let id = 1n; id < nextOrderId; ++id) {
    const meta = await dex.getOrderMeta(id);
    const trader = String(meta.trader).toLowerCase();
    if (trader === ZERO_ADDRESS) continue;
    if (meta.cancelled || meta.filled) continue;
    if (BigInt(meta.expiry) <= BigInt(latest.timestamp)) continue;
    if (!(await dex.isBatchClosed(meta.batchId))) continue;

    active.push({
      id,
      batchId: BigInt(meta.batchId),
      createdAt: BigInt(meta.createdAt),
    });
  }

  return active.sort((left, right) => {
    if (left.batchId !== right.batchId) return left.batchId < right.batchId ? -1 : 1;
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
    return left.id < right.id ? -1 : 1;
  });
}

async function finalizeMatch(dex: DarkPoolDex, client: CofheClient, matchId: bigint) {
  const handles = await dex.getMatchHandles(matchId);
  const meta = await dex.getMatchMeta(matchId);
  const usePublicReveal = meta.matchPublicFillReveal;
  if (!usePublicReveal) {
    await client.permits.getOrCreateSelfPermit();
  }

  const decrypt = (handle: bigint | string) => {
    const request = client.decryptForTx(handle);
    return usePublicReveal ? request.withoutPermit().execute() : request.withPermit().execute();
  };
  const matched = await decrypt(handles.matched);
  const fillAmount = await decrypt(handles.fillAmount);
  const fillPrice = await decrypt(handles.fillPrice);
  const buyFilled = await decrypt(handles.buyFilled);
  const sellFilled = await decrypt(handles.sellFilled);

  const tx = await dex.finalizeMatch(
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
  await tx.wait();

  return {
    matched: toBool(matched.decryptedValue),
    fillAmount: fillAmount.decryptedValue,
    fillPrice: fillPrice.decryptedValue,
    buyFilled: toBool(buyFilled.decryptedValue),
    sellFilled: toBool(sellFilled.decryptedValue),
  };
}

async function pairAlreadyFinalized(dex: DarkPoolDex, buyOrderId: bigint, sellOrderId: bigint) {
  const pairKey = hre.ethers.solidityPackedKeccak256(["uint256", "uint256"], [buyOrderId, sellOrderId]);
  return dex.finalizedPairAttempts(pairKey);
}

async function tryPair(dex: DarkPoolDex, client: CofheClient, buy: ActiveOrder, sell: ActiveOrder) {
  if (await pairAlreadyFinalized(dex, buy.id, sell.id)) return false;

  const batchDuration = await dex.batchDuration();
  const useBatch = batchDuration !== 0n && buy.batchId === sell.batchId;
  const matchId = await dex.nextMatchId();

  const prepared = await withRetry(`prepare ${buy.id}->${sell.id}`, async () => {
    const tx = useBatch ? await dex.tryBatchMatch(buy.batchId, buy.id, sell.id) : await dex.tryMatch(buy.id, sell.id);
    await tx.wait();
    return true;
  });
  if (!prepared) return false;

  const result = await withRetry(`finalize match ${matchId}`, () => finalizeMatch(dex, client, matchId));
  if (!result) return false;

  console.log(
    `match ${matchId}: ${buy.id}->${sell.id} matched=${result.matched} amount=${result.fillAmount.toString()} price=${result.fillPrice.toString()} buyFilled=${result.buyFilled} sellFilled=${result.sellFilled}`,
  );
  return result.matched;
}

async function keeperTick(dex: DarkPoolDex, client: CofheClient) {
  const maxAttempts = envNumber("MAX_MATCH_ATTEMPTS_PER_TICK", 10);
  const orders = await getActiveOrders(dex);
  let attempts = 0;

  for (let i = 0; i < orders.length && attempts < maxAttempts; ++i) {
    for (let j = i + 1; j < orders.length && attempts < maxAttempts; ++j) {
      attempts += 1;
      await tryPair(dex, client, orders[i], orders[j]);
      if (attempts >= maxAttempts) break;

      attempts += 1;
      await tryPair(dex, client, orders[j], orders[i]);
    }
  }

  console.log(`keeper tick complete: ${orders.length} active orders, ${attempts} attempts`);
}

async function main() {
  const deployment = await loadDeployment();
  const [keeper] = await hre.ethers.getSigners();
  const dex = (await hre.ethers.getContractAt(
    "DarkPoolDex",
    deployment.contracts.darkPoolDex,
  )) as unknown as DarkPoolDex;
  const client = await hre.cofhe.createClientWithBatteries(keeper);
  const intervalMs = envNumber("KEEPER_INTERVAL_MS", 15_000);
  const runForever = (process.env.KEEPER_RUN_FOREVER ?? "false").toLowerCase() === "true";

  console.log(`Keeper ${keeper.address} watching ${await dex.getAddress()} on ${hre.network.name}`);

  do {
    await keeperTick(dex, client);
    if (runForever) await sleep(intervalMs);
  } while (runForever);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
