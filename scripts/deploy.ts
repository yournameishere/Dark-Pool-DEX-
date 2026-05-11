import hre from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

async function deployToken(name: string, symbol: string) {
  const token = await hre.ethers.deployContract("MockToken", [name, symbol]);
  await token.waitForDeployment();
  return token.getAddress();
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();

  console.log(`Deploying Dark Pool DEX to ${hre.network.name} (${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const baseToken =
    process.env.BASE_TOKEN_ADDRESS ?? (await deployToken("Wave 4 Mock ETH", "w4ETH"));
  const quoteToken =
    process.env.QUOTE_TOKEN_ADDRESS ?? (await deployToken("Wave 4 Mock USD", "w4USD"));

  const dex = await hre.ethers.deployContract("DarkPoolDex", [baseToken, quoteToken]);
  await dex.waitForDeployment();
  const darkPoolDex = await dex.getAddress();

  const deployment = {
    app: "Dark Pool DEX",
    wave: 4,
    network: hre.network.name,
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    contracts: {
      darkPoolDex,
      baseToken,
      quoteToken,
    },
    priceScale: "1000000000000000000",
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
