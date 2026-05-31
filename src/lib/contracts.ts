import { getAddress, isAddress, type Abi, type Address } from "viem";
import generatedDeployment from "../generated/deployment.json";
import { darkPoolDexAbi, mockTokenAbi } from "../generated/abis";

export { darkPoolDexAbi, mockTokenAbi };

export type ContractAddresses = {
  darkPoolDex: Address | "";
  baseToken: Address | "";
  quoteToken: Address | "";
};

export const DEFAULT_PRICE_SCALE = 10n ** 18n;

function normalizeAddress(value: string | undefined): Address | "" {
  return value && isAddress(value) ? getAddress(value) : "";
}

function normalizeChainId(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export const generatedNetworkName = generatedDeployment.network ?? "unknown";
export const generatedChainId = normalizeChainId(generatedDeployment.chainId);
export const configuredChainId = normalizeChainId(import.meta.env.VITE_CHAIN_ID) || generatedChainId;

export const generatedAddresses: ContractAddresses = {
  darkPoolDex: normalizeAddress(generatedDeployment.contracts.darkPoolDex),
  baseToken: normalizeAddress(generatedDeployment.contracts.baseToken),
  quoteToken: normalizeAddress(generatedDeployment.contracts.quoteToken),
};

export const generatedMarket = {
  baseDecimals: Number(generatedDeployment.tokenDecimals?.base ?? 18),
  quoteDecimals: Number(generatedDeployment.tokenDecimals?.quote ?? 18),
  baseUnit: BigInt(generatedDeployment.baseUnit ?? DEFAULT_PRICE_SCALE.toString()),
  batchDuration: BigInt(generatedDeployment.market?.batchDuration ?? 0),
  makerFeeBps: Number(generatedDeployment.market?.makerFeeBps ?? 0),
  takerFeeBps: Number(generatedDeployment.market?.takerFeeBps ?? 0),
  feeRecipient: normalizeAddress(generatedDeployment.market?.feeRecipient),
  minFillAmount: BigInt(generatedDeployment.market?.minFillAmount ?? "1"),
  maxFillAmount: BigInt(generatedDeployment.market?.maxFillAmount ?? "0"),
  maxQuoteValue: BigInt(generatedDeployment.market?.maxQuoteValue ?? "0"),
  permissionlessMatching: Boolean(generatedDeployment.market?.permissionlessMatching ?? true),
  publicFillReveal: Boolean(generatedDeployment.market?.publicFillReveal ?? true),
};

export const configuredAddresses: ContractAddresses = {
  darkPoolDex:
    normalizeAddress(import.meta.env.VITE_DARK_POOL_DEX_ADDRESS) ||
    generatedAddresses.darkPoolDex,
  baseToken:
    normalizeAddress(import.meta.env.VITE_BASE_TOKEN_ADDRESS) ||
    generatedAddresses.baseToken,
  quoteToken:
    normalizeAddress(import.meta.env.VITE_QUOTE_TOKEN_ADDRESS) ||
    generatedAddresses.quoteToken,
};

export function hasAllAddresses(addresses: ContractAddresses): addresses is {
  darkPoolDex: Address;
  baseToken: Address;
  quoteToken: Address;
} {
  return Boolean(addresses.darkPoolDex && addresses.baseToken && addresses.quoteToken);
}

export type AppAbi = Abi;
