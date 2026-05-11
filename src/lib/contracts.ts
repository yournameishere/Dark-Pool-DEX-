import type { Abi, Address } from "viem";
import generatedDeployment from "../generated/deployment.json";
import { darkPoolDexAbi, mockTokenAbi } from "../generated/abis";

export { darkPoolDexAbi, mockTokenAbi };

export type ContractAddresses = {
  darkPoolDex: Address | "";
  baseToken: Address | "";
  quoteToken: Address | "";
};

export const DEFAULT_PRICE_SCALE = 10n ** 18n;

export const generatedAddresses: ContractAddresses = {
  darkPoolDex: (generatedDeployment.contracts.darkPoolDex || "") as Address | "",
  baseToken: (generatedDeployment.contracts.baseToken || "") as Address | "",
  quoteToken: (generatedDeployment.contracts.quoteToken || "") as Address | "",
};

export const configuredAddresses: ContractAddresses = {
  darkPoolDex:
    (import.meta.env.VITE_DARK_POOL_DEX_ADDRESS as Address | undefined) ??
    generatedAddresses.darkPoolDex,
  baseToken:
    (import.meta.env.VITE_BASE_TOKEN_ADDRESS as Address | undefined) ??
    generatedAddresses.baseToken,
  quoteToken:
    (import.meta.env.VITE_QUOTE_TOKEN_ADDRESS as Address | undefined) ??
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
