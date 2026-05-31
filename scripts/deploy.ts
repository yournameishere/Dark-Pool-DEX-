import hre from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DarkPoolDex } from "../typechain-types";

function envUint(name: string, fallback: bigint) {
  const raw = process.env[name];
  return raw && raw.trim() ? BigInt(raw) : fallback;
}

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  return raw && raw.trim() ? Number(raw) : fallback;
}

async function deployToken(name: string, symbol: string, faucetAmount: bigint) {
  const token = await hre.ethers.deployContract("MockToken", [name, symbol, faucetAmount]);
  await token.waitForDeployment();
  return token.getAddress();
}

async function wait(label: string, tx: Promise<{ wait: () => Promise<unknown> }>) {
  const response = await tx;
  await response.wait();
  console.log(`${label}: confirmed`);
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();

  console.log(`Deploying Dark Pool DEX to ${hre.network.name} (${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const baseToken =
    process.env.BASE_TOKEN_ADDRESS ??
    (await deployToken("Wave 5 Mock ETH", "w5ETH", envUint("BASE_FAUCET_AMOUNT", 10n * 10n ** 18n)));
  const quoteToken =
    process.env.QUOTE_TOKEN_ADDRESS ??
    (await deployToken("Wave 5 Mock USD", "w5USD", envUint("QUOTE_FAUCET_AMOUNT", 50_000n * 10n ** 18n)));

  const dex = (await hre.ethers.deployContract("DarkPoolDex", [baseToken, quoteToken])) as unknown as DarkPoolDex;
  await dex.waitForDeployment();
  const darkPoolDex = await dex.getAddress();

  const makerFeeBps = envNumber("MAKER_FEE_BPS", 5);
  const takerFeeBps = envNumber("TAKER_FEE_BPS", 15);
  const feeRecipient = process.env.FEE_RECIPIENT ?? deployer.address;
  const minFillAmount = envUint("MIN_FILL_AMOUNT", 1n);
  const maxFillAmount = envUint("MAX_FILL_AMOUNT", 0n);
  const maxQuoteValue = envUint("MAX_QUOTE_VALUE", 0n);
  const isLocalNetwork = hre.network.name === "hardhat" || hre.network.name === "localhost";
  const batchDuration = envNumber("BATCH_DURATION_SECONDS", isLocalNetwork ? 0 : 60);
  const permissionlessMatching = (process.env.PERMISSIONLESS_MATCHING ?? "true").toLowerCase() !== "false";
  const publicFillReveal = (process.env.PUBLIC_FILL_REVEAL ?? "true").toLowerCase() !== "false";

  await wait("Fee config", dex.setFeeConfig(makerFeeBps, takerFeeBps, feeRecipient));
  await wait("Risk limits", dex.setRiskLimits(minFillAmount, maxFillAmount, maxQuoteValue));
  await wait("Batch duration", dex.setBatchDuration(batchDuration));

  if (!permissionlessMatching) {
    await wait("Permissionless matching", dex.setPermissionlessMatching(false));
  }
  if (!publicFillReveal) {
    await wait("Public fill reveal", dex.setPublicFillReveal(false));
  }

  const keeperAddresses = (process.env.KEEPER_ADDRESSES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const keeper of keeperAddresses) {
    await wait(`Keeper ${keeper}`, dex.setKeeper(keeper, true));
  }

  const deployment = {
    app: "Dark Pool DEX",
    wave: 5,
    network: hre.network.name,
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    contracts: {
      darkPoolDex,
      baseToken,
      quoteToken,
    },
    tokenDecimals: {
      base: Number(await dex.baseTokenDecimals()),
      quote: Number(await dex.quoteTokenDecimals()),
    },
    priceScale: "1000000000000000000",
    baseUnit: (await dex.baseUnit()).toString(),
    market: {
      makerFeeBps,
      takerFeeBps,
      feeRecipient,
      minFillAmount: minFillAmount.toString(),
      maxFillAmount: maxFillAmount.toString(),
      maxQuoteValue: maxQuoteValue.toString(),
      batchDuration,
      permissionlessMatching,
      publicFillReveal,
      keepers: keeperAddresses,
    },
    createdAt: new Date().toISOString(),
  };

  const deploymentsDir = path.join(process.cwd(), "deployments");
  await mkdir(deploymentsDir, { recursive: true });
  await writeFile(
    path.join(deploymentsDir, `${hre.network.name}.json`),
    `${JSON.stringify(deployment, null, 2)}\n`,
  );

  const generatedDir = path.join(process.cwd(), "src", "generated");
  await mkdir(generatedDir, { recursive: true });
  await writeFile(
    path.join(generatedDir, "deployment.json"),
    `${JSON.stringify(deployment, null, 2)}\n`,
  );

  console.log("DarkPoolDex:", darkPoolDex);
  console.log("Base token:", baseToken);
  console.log("Quote token:", quoteToken);
  console.log(`Saved deployments/${hre.network.name}.json and src/generated/deployment.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
