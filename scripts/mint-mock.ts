import hre from "hardhat";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MockToken } from "../typechain-types";

type Deployment = {
  contracts: {
    baseToken: string;
    quoteToken: string;
  };
  tokenDecimals?: {
    base?: number;
    quote?: number;
  };
};

function envAmount(name: string, fallback: string, decimals: number) {
  return hre.ethers.parseUnits(process.env[name]?.trim() || fallback, decimals);
}

async function readDeployment() {
  const deploymentPath = path.join(process.cwd(), "deployments", `${hre.network.name}.json`);
  const raw = await readFile(deploymentPath, "utf8");
  return JSON.parse(raw) as Deployment;
}

async function mintToken(label: string, tokenAddress: string, to: string, amount: bigint, decimals: number) {
  if (amount === 0n) {
    console.log(`${label}: skipped`);
    return;
  }

  const token = (await hre.ethers.getContractAt("MockToken", tokenAddress)) as unknown as MockToken;
  const tx = await token.mint(to, amount);
  await tx.wait();
  console.log(`${label}: minted ${hre.ethers.formatUnits(amount, decimals)} to ${to}`);
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const deployment = await readDeployment();
  const recipient = hre.ethers.getAddress(process.env.MINT_TO?.trim() || signer.address);
  const baseDecimals = deployment.tokenDecimals?.base ?? 18;
  const quoteDecimals = deployment.tokenDecimals?.quote ?? 18;
  const baseAmount = envAmount("MINT_BASE_AMOUNT", "10", baseDecimals);
  const quoteAmount = envAmount("MINT_QUOTE_AMOUNT", "50000", quoteDecimals);

  console.log(`Minting mock tokens on ${hre.network.name}`);
  console.log(`Signer: ${signer.address}`);
  console.log(`Recipient: ${recipient}`);

  await mintToken("Base", deployment.contracts.baseToken, recipient, baseAmount, baseDecimals);
  await mintToken("Quote", deployment.contracts.quoteToken, recipient, quoteAmount, quoteDecimals);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
