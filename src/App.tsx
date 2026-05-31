import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  Ban,
  CheckCircle2,
  CircleDot,
  Eye,
  HandCoins,
  KeyRound,
  Layers3,
  ListChecks,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { arbitrumSepolia, baseSepolia, hardhat, sepolia } from "viem/chains";
import type { CofheClient } from "@cofhe/sdk";
import {
  configuredAddresses,
  configuredChainId,
  darkPoolDexAbi,
  generatedMarket,
  generatedNetworkName,
  hasAllAddresses,
  mockTokenAbi,
  type AppAbi,
  type ContractAddresses,
} from "./lib/contracts";

const darkPoolDexContractAbi = darkPoolDexAbi as AppAbi;
const mockTokenContractAbi = mockTokenAbi as AppAbi;

type ActivityTone = "run" | "ok" | "warn";

type Activity = {
  id: number;
  tone: ActivityTone;
  label: string;
  detail: string;
};

type WalletState = {
  account: Address;
  chainId: number;
  publicClient: PublicClient;
  walletClient: WalletClient;
  cofheClient: CofheClient;
};

type Balances = {
  baseEscrow: bigint;
  quoteEscrow: bigint;
  baseReserved: bigint;
  quoteReserved: bigint;
  baseWallet: bigint;
  quoteWallet: bigint;
  baseAllowance: bigint;
  quoteAllowance: bigint;
  nextOrderId: bigint;
  nextMatchId: bigint;
};

type MarketState = {
  owner: Address | "";
  feeRecipient: Address | "";
  paused: boolean;
  baseDecimals: number;
  quoteDecimals: number;
  baseUnit: bigint;
  batchDuration: bigint;
  currentBatchId: bigint;
  makerFeeBps: number;
  takerFeeBps: number;
  minFillAmount: bigint;
  maxFillAmount: bigint;
  maxQuoteValue: bigint;
  protocolQuoteFees: bigint;
  permissionlessMatching: boolean;
  publicFillReveal: boolean;
};

type SettlementPreview = {
  matchId: string;
  matched: boolean;
  amount: bigint;
  price: bigint;
  quotePaid: bigint;
  makerFee: bigint;
  takerFee: bigint;
  buyFilled: boolean;
  sellFilled: boolean;
};

type OrderSummary = {
  id: bigint;
  expiry: bigint;
  batchId: bigint;
  cancelled: boolean;
  filled: boolean;
  totalFilled: bigint;
};

type AddressDraft = Record<keyof ContractAddresses, string>;
type ViewId = "trade" | "orders" | "market" | "admin";

const UINT128_MAX = (1n << 128n) - 1n;
const RECENT_ORDER_SCAN_LIMIT = 120n;
const SUPPORTED_CHAINS: Record<number, Chain> = {
  [hardhat.id]: hardhat,
  [sepolia.id]: sepolia,
  [arbitrumSepolia.id]: arbitrumSepolia,
  [baseSepolia.id]: baseSepolia,
};

const INITIAL_BALANCES: Balances = {
  baseEscrow: 0n,
  quoteEscrow: 0n,
  baseReserved: 0n,
  quoteReserved: 0n,
  baseWallet: 0n,
  quoteWallet: 0n,
  baseAllowance: 0n,
  quoteAllowance: 0n,
  nextOrderId: 1n,
  nextMatchId: 1n,
};

const INITIAL_MARKET: MarketState = {
  owner: "",
  feeRecipient: generatedMarket.feeRecipient,
  paused: false,
  baseDecimals: generatedMarket.baseDecimals,
  quoteDecimals: generatedMarket.quoteDecimals,
  baseUnit: generatedMarket.baseUnit,
  batchDuration: generatedMarket.batchDuration,
  currentBatchId: 0n,
  makerFeeBps: generatedMarket.makerFeeBps,
  takerFeeBps: generatedMarket.takerFeeBps,
  minFillAmount: generatedMarket.minFillAmount,
  maxFillAmount: generatedMarket.maxFillAmount,
  maxQuoteValue: generatedMarket.maxQuoteValue,
  protocolQuoteFees: 0n,
  permissionlessMatching: generatedMarket.permissionlessMatching,
  publicFillReveal: generatedMarket.publicFillReveal,
};

function shortAddress(address?: string) {
  if (!address) return "Not connected";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatAmount(value: bigint, decimals = 18, digits = 4) {
  const formatted = formatUnits(value, decimals);
  const [whole, fraction = ""] = formatted.split(".");
  const trimmed = fraction.slice(0, digits).replace(/0+$/, "");
  if (value !== 0n && whole === "0" && !trimmed && fraction.replace(/0/g, "")) {
    return `<0.${"0".repeat(Math.max(digits - 1, 0))}1`;
  }
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function formatTimestamp(seconds: bigint) {
  const millis = Number(seconds) * 1000;
  if (!Number.isFinite(millis)) return seconds.toString();
  return new Date(millis).toLocaleString();
}

function getErrorMessage(error: unknown) {
  if (typeof error === "object" && error && "shortMessage" in error) {
    return String((error as { shortMessage: unknown }).shortMessage);
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function safeAddress(value: string): Address | "" {
  return isAddress(value) ? getAddress(value) : "";
}

function parsePositiveUnits(value: string, label: string, decimals = 18) {
  const parsed = parseUnits(value || "0", decimals);
  if (parsed <= 0n) throw new Error(`${label} must be greater than zero`);
  return parsed;
}

function getErrorCode(error: unknown) {
  return typeof error === "object" && error && "code" in error ? Number((error as { code: unknown }).code) : 0;
}

function parseNonNegativeUnits(value: string, label: string, decimals = 18) {
  const parsed = parseUnits(value || "0", decimals);
  if (parsed < 0n) throw new Error(`${label} must be zero or greater`);
  return parsed;
}

function parseBasisPoints(value: string, label: string) {
  const parsed = Number(value || "0");
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000) {
    throw new Error(`${label} must be an integer from 0 to 1000`);
  }
  return parsed;
}

function toContractInput<T extends { signature: string }>(input: T): T & { signature: `0x${string}` } {
  return { ...input, signature: input.signature as `0x${string}` };
}

async function decryptForSettlement(
  client: CofheClient,
  handle: bigint | string,
  usePublicReveal: boolean,
) {
  const request = client.decryptForTx(handle);
  return usePublicReveal ? request.withoutPermit().execute() : request.withPermit().execute();
}

export default function App() {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [addresses, setAddresses] = useState<ContractAddresses>(configuredAddresses);
  const [addressDraft, setAddressDraft] = useState<AddressDraft>({
    darkPoolDex: configuredAddresses.darkPoolDex,
    baseToken: configuredAddresses.baseToken,
    quoteToken: configuredAddresses.quoteToken,
  });
  const [balances, setBalances] = useState<Balances>(INITIAL_BALANCES);
  const [market, setMarket] = useState<MarketState>(INITIAL_MARKET);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderPrice, setOrderPrice] = useState("2000");
  const [orderAmount, setOrderAmount] = useState("1");
  const [expiryMinutes, setExpiryMinutes] = useState("60");
  const [depositBaseAmount, setDepositBaseAmount] = useState("1");
  const [depositQuoteAmount, setDepositQuoteAmount] = useState("5000");
  const [buyOrderId, setBuyOrderId] = useState("1");
  const [sellOrderId, setSellOrderId] = useState("2");
  const [batchId, setBatchId] = useState("0");
  const [matchId, setMatchId] = useState("1");
  const [cancelOrderId, setCancelOrderId] = useState("1");
  const [disclosureOrderId, setDisclosureOrderId] = useState("1");
  const [disclosureMatchId, setDisclosureMatchId] = useState("1");
  const [disclosureViewer, setDisclosureViewer] = useState("");
  const [adminMakerFeeBps, setAdminMakerFeeBps] = useState(String(generatedMarket.makerFeeBps));
  const [adminTakerFeeBps, setAdminTakerFeeBps] = useState(String(generatedMarket.takerFeeBps));
  const [adminFeeRecipient, setAdminFeeRecipient] = useState<string>(generatedMarket.feeRecipient);
  const [adminMinFillAmount, setAdminMinFillAmount] = useState(
    formatUnits(generatedMarket.minFillAmount, generatedMarket.baseDecimals),
  );
  const [adminMaxFillAmount, setAdminMaxFillAmount] = useState(
    generatedMarket.maxFillAmount === 0n ? "0" : formatUnits(generatedMarket.maxFillAmount, generatedMarket.baseDecimals),
  );
  const [adminMaxQuoteValue, setAdminMaxQuoteValue] = useState(
    generatedMarket.maxQuoteValue === 0n ? "0" : formatUnits(generatedMarket.maxQuoteValue, generatedMarket.quoteDecimals),
  );
  const [adminKeeper, setAdminKeeper] = useState("");
  const [adminKeeperActive, setAdminKeeperActive] = useState(true);
  const [adminWithdrawQuote, setAdminWithdrawQuote] = useState("0");
  const [busy, setBusy] = useState<string | null>(null);
  const [encryptStage, setEncryptStage] = useState("Idle");
  const [settlementPreview, setSettlementPreview] = useState<SettlementPreview | null>(null);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [activeView, setActiveView] = useState<ViewId>("trade");
  const [activity, setActivity] = useState<Activity[]>([
    {
      id: 1,
      tone: "ok",
      label: "Wave 5 console",
      detail: "Partial fills, keeper matching, batches, fees, and disclosure controls loaded.",
    },
  ]);

  const ready = hasAllAddresses(addresses);
  const currentChain = wallet ? SUPPORTED_CHAINS[wallet.chainId] : null;
  const expectedChain = SUPPORTED_CHAINS[configuredChainId] ?? null;
  const chainReady = !wallet || wallet.chainId === configuredChainId;
  const canTransact = Boolean(wallet && ready && chainReady);
  const canAdmin = Boolean(
    wallet &&
      canTransact &&
      market.owner &&
      wallet.account.toLowerCase() === market.owner.toLowerCase(),
  );

  const addressValidity = useMemo(
    () => ({
      darkPoolDex: isAddress(addressDraft.darkPoolDex),
      baseToken: isAddress(addressDraft.baseToken),
      quoteToken: isAddress(addressDraft.quoteToken),
    }),
    [addressDraft],
  );

  const pushActivity = useCallback((tone: ActivityTone, label: string, detail: string) => {
    setActivity((items) => [{ id: Date.now(), tone, label, detail }, ...items].slice(0, 7));
  }, []);

  const requireWallet = useCallback(() => {
    if (!wallet) throw new Error("Connect wallet first");
    if (!ready) throw new Error("Set contract addresses first");
    if (wallet.chainId !== configuredChainId) {
      throw new Error(`Switch wallet to ${expectedChain?.name ?? generatedNetworkName} (${configuredChainId})`);
    }
    return wallet;
  }, [expectedChain?.name, ready, wallet]);

  const waitForTx = useCallback(
    async (publicClient: PublicClient, hash: Hash, label: string) => {
      pushActivity("run", label, hash);
      await publicClient.waitForTransactionReceipt({ hash });
      pushActivity("ok", label, "Confirmed on-chain");
    },
    [pushActivity],
  );

  const runAction = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusy(label);
      try {
        await action();
      } catch (error) {
        pushActivity("warn", label, getErrorMessage(error));
      } finally {
        setBusy(null);
      }
    },
    [pushActivity],
  );

  const connectWallet = useCallback(async () => {
    await runAction("Connect wallet", async () => {
      if (!window.ethereum) throw new Error("No injected wallet found");

      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      const chainHex = (await window.ethereum.request({ method: "eth_chainId" })) as string;
      const chainId = Number(BigInt(chainHex));
      const chain = SUPPORTED_CHAINS[chainId];
      if (!chain) throw new Error(`Unsupported chain ${chainId}`);

      const account = getAddress(accounts[0]);
      const publicClient = createPublicClient({
        chain,
        transport: custom(window.ethereum),
      });
      const walletClient = createWalletClient({
        account,
        chain,
        transport: custom(window.ethereum),
      });

      const [{ createCofheClient, createCofheConfig }, { chains: cofheChains }] = await Promise.all([
        import("@cofhe/sdk/web"),
        import("@cofhe/sdk/chains"),
      ]);
      const cofheClient = createCofheClient(
        createCofheConfig({
          supportedChains: [
            cofheChains.hardhat,
            cofheChains.localcofhe,
            cofheChains.sepolia,
            cofheChains.arbSepolia,
            cofheChains.baseSepolia,
          ],
          useWorkers: true,
        }),
      );
      await cofheClient.connect(publicClient, walletClient);

      setWallet({ account, chainId, publicClient, walletClient, cofheClient });
      pushActivity("ok", "Wallet connected", `${shortAddress(account)} on ${chain.name}`);
    });
  }, [pushActivity, runAction]);

  const switchToExpectedChain = useCallback(async () => {
    await runAction("Switch network", async () => {
      if (!window.ethereum) throw new Error("No injected wallet found");
      if (!configuredChainId) throw new Error("Deployment chain is not configured");

      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${configuredChainId.toString(16)}` }],
      }).catch(async (error: unknown) => {
        if (getErrorCode(error) !== 4902 || !expectedChain) throw error;
        await window.ethereum?.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: `0x${configuredChainId.toString(16)}`,
              chainName: expectedChain.name,
              nativeCurrency: expectedChain.nativeCurrency,
              rpcUrls: expectedChain.rpcUrls.default.http,
              blockExplorerUrls: expectedChain.blockExplorers?.default
                ? [expectedChain.blockExplorers.default.url]
                : undefined,
            },
          ],
        });
      });
      setWallet(null);
      setBalances(INITIAL_BALANCES);
      setOrders([]);
      pushActivity("ok", "Network switched", `Reconnect on ${expectedChain?.name ?? generatedNetworkName}`);
    });
  }, [expectedChain?.name, pushActivity, runAction]);

  useEffect(() => {
    if (!window.ethereum?.on) return;

    const resetWallet = () => {
      setWallet(null);
      setBalances(INITIAL_BALANCES);
      setOrders([]);
      pushActivity("warn", "Wallet changed", "Reconnect wallet to refresh chain and account state");
    };

    window.ethereum.on("accountsChanged", resetWallet);
    window.ethereum.on("chainChanged", resetWallet);
    return () => {
      window.ethereum?.removeListener?.("accountsChanged", resetWallet);
      window.ethereum?.removeListener?.("chainChanged", resetWallet);
    };
  }, [pushActivity]);

  const applyAddresses = useCallback(() => {
    const next = {
      darkPoolDex: safeAddress(addressDraft.darkPoolDex),
      baseToken: safeAddress(addressDraft.baseToken),
      quoteToken: safeAddress(addressDraft.quoteToken),
    };
    setAddresses(next);
    pushActivity(
      hasAllAddresses(next) ? "ok" : "warn",
      "Contracts updated",
      hasAllAddresses(next) ? "Ready for transactions" : "One or more addresses are invalid",
    );
  }, [addressDraft, pushActivity]);

  const refreshBalances = useCallback(async () => {
    await runAction("Refresh state", async () => {
      const active = requireWallet();
      if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

      const [
        baseEscrow,
        quoteEscrow,
        baseReserved,
        quoteReserved,
        baseWallet,
        quoteWallet,
        baseAllowance,
        quoteAllowance,
        nextOrderId,
        nextMatchId,
        baseDecimals,
        quoteDecimals,
        baseUnit,
        batchDuration,
        currentBatchId,
        makerFeeBps,
        takerFeeBps,
        minFillAmount,
        maxFillAmount,
        maxQuoteValue,
        protocolQuoteFees,
        permissionlessMatching,
        publicFillReveal,
        owner,
        feeRecipient,
        paused,
      ] =
        await Promise.all([
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "baseBalance",
            args: [active.account],
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "quoteBalance",
            args: [active.account],
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "reservedBaseBalance",
            args: [active.account],
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "reservedQuoteBalance",
            args: [active.account],
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.baseToken,
            abi: mockTokenContractAbi,
            functionName: "balanceOf",
            args: [active.account],
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.quoteToken,
            abi: mockTokenContractAbi,
            functionName: "balanceOf",
            args: [active.account],
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.baseToken,
            abi: mockTokenContractAbi,
            functionName: "allowance",
            args: [active.account, addresses.darkPoolDex],
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.quoteToken,
            abi: mockTokenContractAbi,
            functionName: "allowance",
            args: [active.account, addresses.darkPoolDex],
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "nextOrderId",
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "nextMatchId",
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "baseTokenDecimals",
          }) as Promise<number>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "quoteTokenDecimals",
          }) as Promise<number>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "baseUnit",
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "batchDuration",
          }) as Promise<number>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "currentBatchId",
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "makerFeeBps",
          }) as Promise<number>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "takerFeeBps",
          }) as Promise<number>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "minFillAmount",
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "maxFillAmount",
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "maxQuoteValue",
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "protocolQuoteFees",
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "permissionlessMatching",
          }) as Promise<boolean>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "publicFillReveal",
          }) as Promise<boolean>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "owner",
          }) as Promise<Address>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "feeRecipient",
          }) as Promise<Address>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "paused",
          }) as Promise<boolean>,
        ]);

      setBalances({
        baseEscrow,
        quoteEscrow,
        baseReserved,
        quoteReserved,
        baseWallet,
        quoteWallet,
        baseAllowance,
        quoteAllowance,
        nextOrderId,
        nextMatchId,
      });
      setMarket({
        owner,
        feeRecipient,
        paused,
        baseDecimals,
        quoteDecimals,
        baseUnit,
        batchDuration: BigInt(batchDuration),
        currentBatchId,
        makerFeeBps,
        takerFeeBps,
        minFillAmount,
        maxFillAmount,
        maxQuoteValue,
        protocolQuoteFees,
        permissionlessMatching,
        publicFillReveal,
      });
      setAdminMakerFeeBps(String(makerFeeBps));
      setAdminTakerFeeBps(String(takerFeeBps));
      setAdminFeeRecipient(feeRecipient);
      setAdminMinFillAmount(formatUnits(minFillAmount, baseDecimals));
      setAdminMaxFillAmount(maxFillAmount === 0n ? "0" : formatUnits(maxFillAmount, baseDecimals));
      setAdminMaxQuoteValue(maxQuoteValue === 0n ? "0" : formatUnits(maxQuoteValue, quoteDecimals));
      setBatchId(currentBatchId.toString());

      const firstOrderId = nextOrderId > RECENT_ORDER_SCAN_LIMIT ? nextOrderId - RECENT_ORDER_SCAN_LIMIT : 1n;
      const orderIds: bigint[] = [];
      for (let id = firstOrderId; id < nextOrderId; id += 1n) orderIds.push(id);
      const recentOrders = await Promise.all(
        orderIds.map(async (id) => {
          const meta = (await active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexContractAbi,
            functionName: "getOrderMeta",
            args: [id],
          })) as readonly [Address, bigint, bigint, bigint, bigint, boolean, boolean, bigint, bigint, bigint];
          if (meta[0].toLowerCase() !== active.account.toLowerCase()) return null;
          return {
            id,
            expiry: meta[1],
            batchId: meta[4],
            cancelled: meta[5],
            filled: meta[6],
            totalFilled: meta[7],
          } satisfies OrderSummary;
        }),
      );
      setOrders(recentOrders.filter((order): order is OrderSummary => Boolean(order)).reverse());
      pushActivity("ok", "State refreshed", `Next order ${nextOrderId.toString()}`);
    });
  }, [addresses, pushActivity, requireWallet, runAction]);

  useEffect(() => {
    if (!wallet || !ready || !chainReady) return;
    void refreshBalances();
  }, [chainReady, ready, refreshBalances, wallet]);

  const deposit = useCallback(
    async (asset: "base" | "quote") => {
      await runAction(`Deposit ${asset}`, async () => {
        const active = requireWallet();
        if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

        const token = asset === "base" ? addresses.baseToken : addresses.quoteToken;
        const allowance = asset === "base" ? balances.baseAllowance : balances.quoteAllowance;
        const amount = parsePositiveUnits(
          asset === "base" ? depositBaseAmount : depositQuoteAmount,
          "Deposit amount",
          asset === "base" ? market.baseDecimals : market.quoteDecimals,
        );

        if (allowance < amount) {
          const approveHash = await active.walletClient.writeContract({
            address: token,
            abi: mockTokenContractAbi,
            functionName: "approve",
            args: [addresses.darkPoolDex, amount],
            account: active.account,
            chain: undefined,
          });
          await waitForTx(active.publicClient, approveHash, "Approve escrow");
        }

        const depositHash = await active.walletClient.writeContract({
          address: addresses.darkPoolDex,
          abi: darkPoolDexContractAbi,
          functionName: asset === "base" ? "depositBase" : "depositQuote",
          args: [amount],
          account: active.account,
          chain: undefined,
        });
        await waitForTx(active.publicClient, depositHash, "Deposit escrow");
        await refreshBalances();
      });
    },
    [
      addresses,
      balances.baseAllowance,
      balances.quoteAllowance,
      depositBaseAmount,
      depositQuoteAmount,
      market.baseDecimals,
      market.quoteDecimals,
      refreshBalances,
      requireWallet,
      runAction,
      waitForTx,
    ],
  );

  const withdraw = useCallback(
    async (asset: "base" | "quote") => {
      await runAction(`Withdraw ${asset}`, async () => {
        const active = requireWallet();
        if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

        const amount = parsePositiveUnits(
          asset === "base" ? depositBaseAmount : depositQuoteAmount,
          "Withdraw amount",
          asset === "base" ? market.baseDecimals : market.quoteDecimals,
        );

        const hash = await active.walletClient.writeContract({
          address: addresses.darkPoolDex,
          abi: darkPoolDexContractAbi,
          functionName: asset === "base" ? "withdrawBase" : "withdrawQuote",
          args: [amount],
          account: active.account,
          chain: undefined,
        });
        await waitForTx(active.publicClient, hash, "Withdraw escrow");
        await refreshBalances();
      });
    },
    [
      addresses,
      depositBaseAmount,
      depositQuoteAmount,
      market.baseDecimals,
      market.quoteDecimals,
      refreshBalances,
      requireWallet,
      runAction,
      waitForTx,
    ],
  );

  const claimFaucet = useCallback(
    async (asset: "base" | "quote") => {
      await runAction(`Claim ${asset} faucet`, async () => {
        const active = requireWallet();
        if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

        const token = asset === "base" ? addresses.baseToken : addresses.quoteToken;
        const hash = await active.walletClient.writeContract({
          address: token,
          abi: mockTokenContractAbi,
          functionName: "claimFaucet",
          account: active.account,
          chain: undefined,
        });
        await waitForTx(active.publicClient, hash, `Claim ${asset} faucet`);
        await refreshBalances();
      });
    },
    [addresses, refreshBalances, requireWallet, runAction, waitForTx],
  );

  const placeOrder = useCallback(async () => {
    await runAction("Place encrypted order", async () => {
      const active = requireWallet();
      if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

      const price = parsePositiveUnits(orderPrice, "Price", market.quoteDecimals);
      const amount = parsePositiveUnits(orderAmount, "Amount", market.baseDecimals);
      const minutes = BigInt(Number(expiryMinutes || "0"));
      if (minutes <= 0n) throw new Error("Expiry must be greater than zero");
      const pendingOrderId = (await active.publicClient.readContract({
        address: addresses.darkPoolDex,
        abi: darkPoolDexContractAbi,
        functionName: "nextOrderId",
      })) as bigint;

      try {
        const { Encryptable } = await import("@cofhe/sdk");
        setEncryptStage("Encrypting price, amount, side");
        const [encryptedPrice, encryptedAmount, encryptedSide] = await active.cofheClient
          .encryptInputs([Encryptable.uint128(price), Encryptable.uint128(amount), Encryptable.bool(side === "buy")])
          .onStep((step, ctx) => {
            if (ctx?.isStart) setEncryptStage(String(step));
          })
          .execute();

        const latestBlock = await active.publicClient.getBlock();
        const expiry = BigInt(latestBlock.timestamp) + minutes * 60n;
        const hash = await active.walletClient.writeContract({
          address: addresses.darkPoolDex,
          abi: darkPoolDexContractAbi,
          functionName: "placeOrder",
          args: [
            toContractInput(encryptedPrice),
            toContractInput(encryptedAmount),
            toContractInput(encryptedSide),
            expiry,
          ],
          account: active.account,
          chain: undefined,
        });
        await waitForTx(active.publicClient, hash, "Submit encrypted order");
        const orderMeta = (await active.publicClient.readContract({
          address: addresses.darkPoolDex,
          abi: darkPoolDexContractAbi,
          functionName: "getOrderMeta",
          args: [pendingOrderId],
        })) as readonly [Address, bigint, bigint, bigint, bigint, boolean, boolean, bigint, bigint, bigint];
        setBatchId(orderMeta[4].toString());
        if (side === "buy") {
          setBuyOrderId(pendingOrderId.toString());
        } else {
          setSellOrderId(pendingOrderId.toString());
        }
        pushActivity("ok", "Order linked", `Order ${pendingOrderId.toString()} in batch ${orderMeta[4].toString()}`);
        await refreshBalances();
      } finally {
        setEncryptStage("Ready");
      }
    });
  }, [
    addresses,
    expiryMinutes,
    market.baseDecimals,
    market.quoteDecimals,
    orderAmount,
    orderPrice,
    pushActivity,
    refreshBalances,
    requireWallet,
    runAction,
    side,
    waitForTx,
  ]);

  const prepareMatch = useCallback(async (mode: "single" | "batch" = "single") => {
    await runAction(mode === "batch" ? "Prepare batch match" : "Prepare match", async () => {
      const active = requireWallet();
      if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

      const pendingMatchId = (await active.publicClient.readContract({
        address: addresses.darkPoolDex,
        abi: darkPoolDexContractAbi,
        functionName: "nextMatchId",
      })) as bigint;
      const hash = await active.walletClient.writeContract({
        address: addresses.darkPoolDex,
        abi: darkPoolDexContractAbi,
        functionName: mode === "batch" ? "tryBatchMatch" : "tryMatch",
        args:
          mode === "batch"
            ? [BigInt(batchId), BigInt(buyOrderId), BigInt(sellOrderId)]
            : [BigInt(buyOrderId), BigInt(sellOrderId)],
        account: active.account,
        chain: undefined,
      });
      await waitForTx(active.publicClient, hash, "FHE match");
      setMatchId(pendingMatchId.toString());
      await refreshBalances();
    });
  }, [
    addresses,
    balances.nextMatchId,
    batchId,
    buyOrderId,
    refreshBalances,
    requireWallet,
    runAction,
    sellOrderId,
    waitForTx,
  ]);

  const finalizeMatch = useCallback(async () => {
    await runAction("Finalize match", async () => {
      const active = requireWallet();
      if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

      const handles = (await active.publicClient.readContract({
        address: addresses.darkPoolDex,
        abi: darkPoolDexContractAbi,
        functionName: "getMatchHandles",
        args: [BigInt(matchId)],
      })) as readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`];
      const meta = (await active.publicClient.readContract({
        address: addresses.darkPoolDex,
        abi: darkPoolDexContractAbi,
        functionName: "getMatchMeta",
        args: [BigInt(matchId)],
      })) as readonly [bigint, bigint, bigint, bigint, boolean, boolean, number, number, boolean, bigint, bigint, bigint];

      pushActivity("run", "Decrypt fill", `Match ${matchId}`);
      const matchPublicFillReveal = meta[8];
      if (!matchPublicFillReveal) {
        await active.cofheClient.permits.getOrCreateSelfPermit();
      }
      const matched = await decryptForSettlement(active.cofheClient, handles[0], matchPublicFillReveal);
      const fillAmount = await decryptForSettlement(active.cofheClient, handles[1], matchPublicFillReveal);
      const fillPrice = await decryptForSettlement(active.cofheClient, handles[2], matchPublicFillReveal);
      const buyFilled = await decryptForSettlement(active.cofheClient, handles[3], matchPublicFillReveal);
      const sellFilled = await decryptForSettlement(active.cofheClient, handles[4], matchPublicFillReveal);
      const matchedPlaintext = matched.decryptedValue !== 0n;
      const buyFilledPlaintext = buyFilled.decryptedValue !== 0n;
      const sellFilledPlaintext = sellFilled.decryptedValue !== 0n;
      const quotePaid = (fillAmount.decryptedValue * fillPrice.decryptedValue) / market.baseUnit;
      const makerFee = (quotePaid * BigInt(meta[6])) / 10_000n;
      const takerFee = (quotePaid * BigInt(meta[7])) / 10_000n;

      setSettlementPreview({
        matchId,
        matched: matchedPlaintext,
        amount: fillAmount.decryptedValue,
        price: fillPrice.decryptedValue,
        quotePaid,
        makerFee,
        takerFee,
        buyFilled: buyFilledPlaintext,
        sellFilled: sellFilledPlaintext,
      });

      const hash = await active.walletClient.writeContract({
        address: addresses.darkPoolDex,
        abi: darkPoolDexContractAbi,
        functionName: "finalizeMatch",
        args: [
          BigInt(matchId),
          matchedPlaintext,
          matched.signature,
          fillAmount.decryptedValue,
          fillAmount.signature,
          fillPrice.decryptedValue,
          fillPrice.signature,
          buyFilledPlaintext,
          buyFilled.signature,
          sellFilledPlaintext,
          sellFilled.signature,
        ],
        account: active.account,
        chain: undefined,
      });
      await waitForTx(active.publicClient, hash, meta[5] ? "Settle taker fill" : "Settle maker fill");
      await refreshBalances();
    });
  }, [
    addresses,
    market.baseUnit,
    matchId,
    pushActivity,
    refreshBalances,
    requireWallet,
    runAction,
    waitForTx,
  ]);

  const cancelOrder = useCallback(async () => {
    await runAction("Cancel order", async () => {
      const active = requireWallet();
      if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

      const hash = await active.walletClient.writeContract({
        address: addresses.darkPoolDex,
        abi: darkPoolDexContractAbi,
        functionName: "cancelOrder",
        args: [BigInt(cancelOrderId)],
        account: active.account,
        chain: undefined,
      });
      await waitForTx(active.publicClient, hash, "Cancel order");
      await refreshBalances();
    });
  }, [addresses, cancelOrderId, refreshBalances, requireWallet, runAction, waitForTx]);

  const grantDisclosure = useCallback(
    async (scope: "order" | "match") => {
      await runAction(`Grant ${scope} disclosure`, async () => {
        const active = requireWallet();
        if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");
        const viewer = safeAddress(disclosureViewer);
        if (!viewer) throw new Error("Viewer must be a valid address");

        const hash = await active.walletClient.writeContract({
          address: addresses.darkPoolDex,
          abi: darkPoolDexContractAbi,
          functionName: scope === "order" ? "grantOrderDisclosure" : "grantMatchDisclosure",
          args: [BigInt(scope === "order" ? disclosureOrderId : disclosureMatchId), viewer],
          account: active.account,
          chain: undefined,
        });
        await waitForTx(active.publicClient, hash, "Grant disclosure");
      });
    },
    [
      addresses,
      disclosureMatchId,
      disclosureOrderId,
      disclosureViewer,
      requireWallet,
      runAction,
      waitForTx,
    ],
  );

  const setMarketPaused = useCallback(
    async (paused: boolean) => {
      await runAction(paused ? "Pause market" : "Open market", async () => {
        const active = requireWallet();
        if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

        const hash = await active.walletClient.writeContract({
          address: addresses.darkPoolDex,
          abi: darkPoolDexContractAbi,
          functionName: "setPaused",
          args: [paused],
          account: active.account,
          chain: undefined,
        });
        await waitForTx(active.publicClient, hash, paused ? "Pause market" : "Open market");
        await refreshBalances();
      });
    },
    [addresses, refreshBalances, requireWallet, runAction, waitForTx],
  );

  const setPermissionless = useCallback(
    async (enabled: boolean) => {
      await runAction("Set matchers", async () => {
        const active = requireWallet();
        if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

        const hash = await active.walletClient.writeContract({
          address: addresses.darkPoolDex,
          abi: darkPoolDexContractAbi,
          functionName: "setPermissionlessMatching",
          args: [enabled],
          account: active.account,
          chain: undefined,
        });
        await waitForTx(active.publicClient, hash, "Set matchers");
        await refreshBalances();
      });
    },
    [addresses, refreshBalances, requireWallet, runAction, waitForTx],
  );

  const setPublicReveal = useCallback(
    async (enabled: boolean) => {
      await runAction("Set fill reveal", async () => {
        const active = requireWallet();
        if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

        const hash = await active.walletClient.writeContract({
          address: addresses.darkPoolDex,
          abi: darkPoolDexContractAbi,
          functionName: "setPublicFillReveal",
          args: [enabled],
          account: active.account,
          chain: undefined,
        });
        await waitForTx(active.publicClient, hash, "Set fill reveal");
        await refreshBalances();
      });
    },
    [addresses, refreshBalances, requireWallet, runAction, waitForTx],
  );

  const updateFeeConfig = useCallback(async () => {
    await runAction("Update fees", async () => {
      const active = requireWallet();
      if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

      const makerBps = parseBasisPoints(adminMakerFeeBps, "Maker fee");
      const takerBps = parseBasisPoints(adminTakerFeeBps, "Taker fee");
      const feeRecipient = safeAddress(adminFeeRecipient) || market.feeRecipient || active.account;
      if (!feeRecipient) throw new Error("Fee recipient must be a valid address");

      const hash = await active.walletClient.writeContract({
        address: addresses.darkPoolDex,
        abi: darkPoolDexContractAbi,
        functionName: "setFeeConfig",
        args: [makerBps, takerBps, feeRecipient],
        account: active.account,
        chain: undefined,
      });
      await waitForTx(active.publicClient, hash, "Update fees");
      await refreshBalances();
    });
  }, [
    addresses,
    adminFeeRecipient,
    adminMakerFeeBps,
    adminTakerFeeBps,
    market.feeRecipient,
    refreshBalances,
    requireWallet,
    runAction,
    waitForTx,
  ]);

  const updateRiskLimits = useCallback(async () => {
    await runAction("Update risk", async () => {
      const active = requireWallet();
      if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

      const minFillAmount = parseNonNegativeUnits(adminMinFillAmount, "Minimum fill", market.baseDecimals);
      const maxFillAmount = parseNonNegativeUnits(adminMaxFillAmount, "Maximum fill", market.baseDecimals);
      const maxQuoteValue = parseNonNegativeUnits(adminMaxQuoteValue, "Maximum quote value", market.quoteDecimals);
      if (minFillAmount > UINT128_MAX || maxFillAmount > UINT128_MAX) {
        throw new Error("Base fill limits exceed uint128");
      }
      if (maxFillAmount !== 0n && maxFillAmount < minFillAmount) {
        throw new Error("Maximum fill must be zero or at least the minimum fill");
      }

      const hash = await active.walletClient.writeContract({
        address: addresses.darkPoolDex,
        abi: darkPoolDexContractAbi,
        functionName: "setRiskLimits",
        args: [minFillAmount, maxFillAmount, maxQuoteValue],
        account: active.account,
        chain: undefined,
      });
      await waitForTx(active.publicClient, hash, "Update risk");
      await refreshBalances();
    });
  }, [
    addresses,
    adminMaxFillAmount,
    adminMaxQuoteValue,
    adminMinFillAmount,
    market.baseDecimals,
    market.quoteDecimals,
    refreshBalances,
    requireWallet,
    runAction,
    waitForTx,
  ]);

  const updateKeeper = useCallback(async () => {
    await runAction("Update keeper", async () => {
      const active = requireWallet();
      if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

      const keeper = safeAddress(adminKeeper);
      if (!keeper) throw new Error("Keeper must be a valid address");

      const hash = await active.walletClient.writeContract({
        address: addresses.darkPoolDex,
        abi: darkPoolDexContractAbi,
        functionName: "setKeeper",
        args: [keeper, adminKeeperActive],
        account: active.account,
        chain: undefined,
      });
      await waitForTx(active.publicClient, hash, "Update keeper");
      await refreshBalances();
    });
  }, [
    addresses,
    adminKeeper,
    adminKeeperActive,
    refreshBalances,
    requireWallet,
    runAction,
    waitForTx,
  ]);

  const withdrawProtocolQuoteFees = useCallback(async () => {
    await runAction("Withdraw fees", async () => {
      const active = requireWallet();
      if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

      const quoteAmount = parsePositiveUnits(adminWithdrawQuote, "Protocol fee amount", market.quoteDecimals);
      const recipient = market.feeRecipient || active.account;
      const hash = await active.walletClient.writeContract({
        address: addresses.darkPoolDex,
        abi: darkPoolDexContractAbi,
        functionName: "withdrawProtocolFees",
        args: [recipient, 0n, quoteAmount],
        account: active.account,
        chain: undefined,
      });
      await waitForTx(active.publicClient, hash, "Withdraw fees");
      await refreshBalances();
    });
  }, [
    addresses,
    adminWithdrawQuote,
    market.feeRecipient,
    market.quoteDecimals,
    refreshBalances,
    requireWallet,
    runAction,
    waitForTx,
  ]);

  const isBusy = Boolean(busy);
  const activeOrderCount = orders.filter((order) => !order.cancelled && !order.filled).length;
  const navItems: { id: ViewId; label: string; icon: React.ReactNode }[] = [
    { id: "trade", label: "Trade", icon: <ArrowRightLeft size={17} /> },
    { id: "orders", label: "Orders", icon: <ListChecks size={17} /> },
    { id: "market", label: "Market", icon: <Layers3 size={17} /> },
    { id: "admin", label: "Admin", icon: <SlidersHorizontal size={17} /> },
  ];

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-symbol" aria-hidden="true">
            <LockKeyhole size={20} />
          </span>
          <div>
            <h1>Dark Pool DEX</h1>
            <p>Confidential exchange console</p>
          </div>
        </div>

        <nav className="view-tabs" aria-label="App sections">
          {navItems.map((item) => (
            <button
              className={activeView === item.id ? "active" : ""}
              key={item.id}
              type="button"
              onClick={() => setActiveView(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>

        <div className="top-actions">
          <button className="icon-button" type="button" onClick={refreshBalances} disabled={!canTransact || isBusy} title="Refresh">
            <RefreshCw size={18} />
          </button>
          <button className="wallet-button" type="button" onClick={connectWallet} disabled={isBusy}>
            <Wallet size={18} />
            {wallet ? shortAddress(wallet.account) : "Connect"}
          </button>
          {wallet && !chainReady && (
            <button className="wallet-button" type="button" onClick={switchToExpectedChain} disabled={isBusy}>
              <CircleDot size={18} />
              Switch
            </button>
          )}
        </div>
      </header>

      <section className="status-strip">
        <StatusPill icon={<ShieldCheck size={16} />} label={ready ? "Contracts linked" : "Contracts missing"} tone={ready ? "ok" : "warn"} />
        <StatusPill icon={<CircleDot size={16} />} label={currentChain ? currentChain.name : "No chain"} tone={currentChain && chainReady ? "ok" : "warn"} />
        <StatusPill icon={<ShieldCheck size={16} />} label={`Target ${expectedChain?.name ?? generatedNetworkName}`} tone={chainReady ? "ok" : "warn"} />
        <StatusPill icon={<LockKeyhole size={16} />} label={encryptStage} tone={encryptStage === "Idle" ? "warn" : "ok"} />
        <StatusPill icon={<Layers3 size={16} />} label={market.batchDuration > 0n ? `Batch ${wallet ? market.currentBatchId.toString() : "--"}` : "Continuous"} tone="ok" />
        <StatusPill icon={<ListChecks size={16} />} label={`${activeOrderCount} open orders`} tone={activeOrderCount ? "ok" : "warn"} />
        <StatusPill icon={<SlidersHorizontal size={16} />} label={market.paused ? "Market paused" : "Market open"} tone={market.paused ? "warn" : "ok"} />
      </section>

      <section className="app-grid">
        <aside className="control-rail">
          <section className="panel">
            <PanelTitle icon={<KeyRound size={18} />} label="Contracts" />
            <AddressField label="DEX" value={addressDraft.darkPoolDex} valid={addressValidity.darkPoolDex} onChange={(value) => setAddressDraft((draft) => ({ ...draft, darkPoolDex: value }))} />
            <AddressField label="Base" value={addressDraft.baseToken} valid={addressValidity.baseToken} onChange={(value) => setAddressDraft((draft) => ({ ...draft, baseToken: value }))} />
            <AddressField label="Quote" value={addressDraft.quoteToken} valid={addressValidity.quoteToken} onChange={(value) => setAddressDraft((draft) => ({ ...draft, quoteToken: value }))} />
            <button className="wide-button quiet" type="button" onClick={applyAddresses}>Apply</button>
          </section>

          <section className="panel">
            <PanelTitle icon={<Wallet size={18} />} label="Balances" />
            <div className="metric-stack">
              <Metric label="Wallet base" value={formatAmount(balances.baseWallet, market.baseDecimals)} />
              <Metric label="Escrow base" value={formatAmount(balances.baseEscrow, market.baseDecimals)} />
              <Metric label="Available base" value={formatAmount(balances.baseEscrow - balances.baseReserved, market.baseDecimals)} />
              <Metric label="Wallet quote" value={formatAmount(balances.quoteWallet, market.quoteDecimals)} />
              <Metric label="Escrow quote" value={formatAmount(balances.quoteEscrow, market.quoteDecimals)} />
              <Metric label="Available quote" value={formatAmount(balances.quoteEscrow - balances.quoteReserved, market.quoteDecimals)} />
              <Metric label="Decimals" value={`${market.baseDecimals}/${market.quoteDecimals}`} />
            </div>
          </section>
        </aside>

        <section className="view-panel">
          {activeView === "trade" && (
            <div className="view-stack">
              <div className="view-heading">
                <div>
                  <span>Trade</span>
                  <h2>Encrypted order ticket</h2>
                </div>
                <div className="summary-grid">
                  <Metric label="Next order" value={balances.nextOrderId.toString()} />
                  <Metric label="Next match" value={balances.nextMatchId.toString()} />
                  <Metric label="Fees" value={`${market.makerFeeBps}/${market.takerFeeBps} bps`} />
                </div>
              </div>

              <div className="trade-grid">
                <section className="panel surface-panel">
                  <PanelTitle icon={<Send size={18} />} label="Order ticket" />
                  <div className="segmented">
                    <button className={side === "buy" ? "active" : ""} type="button" onClick={() => setSide("buy")}>Buy</button>
                    <button className={side === "sell" ? "active" : ""} type="button" onClick={() => setSide("sell")}>Sell</button>
                  </div>
                  <div className="form-grid">
                    <NumberField label="Price" value={orderPrice} onChange={setOrderPrice} />
                    <NumberField label="Amount" value={orderAmount} onChange={setOrderAmount} />
                    <NumberField label="Expiry min" value={expiryMinutes} onChange={setExpiryMinutes} />
                  </div>
                  <button className="wide-button primary" type="button" onClick={placeOrder} disabled={!canTransact || isBusy}>
                    {busy === "Place encrypted order" ? <Loader2 className="spin" size={17} /> : <Send size={17} />}
                    Place order
                  </button>
                </section>

                <section className="panel surface-panel">
                  <PanelTitle icon={<ArrowRightLeft size={18} />} label="Escrow" />
                  <div className="asset-grid">
                    <div className="asset-row">
                      <NumberField label="Base amount" value={depositBaseAmount} onChange={setDepositBaseAmount} />
                      <div className="button-row">
                        <button type="button" onClick={() => claimFaucet("base")} disabled={!canTransact || isBusy}><HandCoins size={16} /> Claim</button>
                        <button type="button" onClick={() => deposit("base")} disabled={!canTransact || isBusy}><ArrowDownToLine size={16} /> Deposit</button>
                        <button type="button" onClick={() => withdraw("base")} disabled={!canTransact || isBusy}><ArrowUpFromLine size={16} /> Withdraw</button>
                      </div>
                    </div>
                    <div className="asset-row">
                      <NumberField label="Quote amount" value={depositQuoteAmount} onChange={setDepositQuoteAmount} />
                      <div className="button-row">
                        <button type="button" onClick={() => claimFaucet("quote")} disabled={!canTransact || isBusy}><HandCoins size={16} /> Claim</button>
                        <button type="button" onClick={() => deposit("quote")} disabled={!canTransact || isBusy}><ArrowDownToLine size={16} /> Deposit</button>
                        <button type="button" onClick={() => withdraw("quote")} disabled={!canTransact || isBusy}><ArrowUpFromLine size={16} /> Withdraw</button>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="panel surface-panel wide-surface">
                  <PanelTitle icon={<ShieldCheck size={18} />} label="Match controls" />
                  <div className="match-grid">
                    <NumberField label="Buy ID" value={buyOrderId} onChange={setBuyOrderId} />
                    <NumberField label="Sell ID" value={sellOrderId} onChange={setSellOrderId} />
                    <NumberField label="Batch ID" value={batchId} onChange={setBatchId} />
                    <NumberField label="Match ID" value={matchId} onChange={setMatchId} />
                    <NumberField label="Cancel ID" value={cancelOrderId} onChange={setCancelOrderId} />
                  </div>
                  <div className="button-row strong-row">
                    <button type="button" onClick={() => prepareMatch("single")} disabled={!canTransact || isBusy}><ArrowRightLeft size={16} /> Prepare</button>
                    <button type="button" onClick={() => prepareMatch("batch")} disabled={!canTransact || isBusy}><Layers3 size={16} /> Batch</button>
                    <button type="button" onClick={finalizeMatch} disabled={!canTransact || isBusy}><CheckCircle2 size={16} /> Finalize</button>
                    <button type="button" onClick={cancelOrder} disabled={!canTransact || isBusy}><Ban size={16} /> Cancel</button>
                  </div>
                </section>
              </div>
            </div>
          )}

          {activeView === "orders" && (
            <div className="view-stack">
              <div className="view-heading">
                <div>
                  <span>Orders</span>
                  <h2>Wallet order book</h2>
                </div>
              </div>
              <section className="panel surface-panel">
                <PanelTitle icon={<ListChecks size={18} />} label="My orders" />
                {orders.length === 0 ? (
                  <p className="empty-state">No orders found for this wallet.</p>
                ) : (
                  <div className="order-list">
                    {orders.map((order) => {
                      const status = order.cancelled ? "Cancelled" : order.filled ? "Filled" : "Open";
                      return (
                        <div className="order-item" key={order.id.toString()}>
                          <div>
                            <strong>Order {order.id.toString()}</strong>
                            <span>{status} · batch {order.batchId.toString()} · filled {formatAmount(order.totalFilled, market.baseDecimals)}</span>
                            <span>Expires {formatTimestamp(order.expiry)}</span>
                          </div>
                          <div className="order-actions">
                            <button type="button" onClick={() => setBuyOrderId(order.id.toString())}>Buy ID</button>
                            <button type="button" onClick={() => setSellOrderId(order.id.toString())}>Sell ID</button>
                            <button type="button" onClick={() => setCancelOrderId(order.id.toString())} disabled={order.cancelled || order.filled}>Cancel ID</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="panel surface-panel">
                <PanelTitle icon={<Eye size={18} />} label="Disclosure" />
                <div className="disclosure-grid">
                  <AddressField label="Viewer" value={disclosureViewer} valid={!disclosureViewer || isAddress(disclosureViewer)} onChange={setDisclosureViewer} />
                  <NumberField label="Order ID" value={disclosureOrderId} onChange={setDisclosureOrderId} />
                  <NumberField label="Match ID" value={disclosureMatchId} onChange={setDisclosureMatchId} />
                </div>
                <div className="button-row">
                  <button type="button" onClick={() => grantDisclosure("order")} disabled={!canTransact || isBusy}><Eye size={16} /> Grant order</button>
                  <button type="button" onClick={() => grantDisclosure("match")} disabled={!canTransact || isBusy}><Eye size={16} /> Grant match</button>
                </div>
              </section>
            </div>
          )}

          {activeView === "market" && (
            <div className="view-stack">
              <div className="view-heading">
                <div>
                  <span>Market</span>
                  <h2>Live protocol state</h2>
                </div>
              </div>
              <div className="market-grid">
                <section className="panel surface-panel">
                  <PanelTitle icon={<SlidersHorizontal size={18} />} label="Market" />
                  <div className="metric-stack">
                    <Metric label="Batch seconds" value={market.batchDuration.toString()} />
                    <Metric label="Current batch" value={wallet ? market.currentBatchId.toString() : "--"} />
                    <Metric label="Risk min/max" value={`${formatAmount(market.minFillAmount, market.baseDecimals)}/${market.maxFillAmount === 0n ? "open" : formatAmount(market.maxFillAmount, market.baseDecimals)}`} />
                    <Metric label="Protocol fees" value={formatAmount(market.protocolQuoteFees, market.quoteDecimals)} />
                    <Metric label="Matchers" value={market.permissionlessMatching ? "permissionless" : "keepers"} />
                    <Metric label="Fill reveal" value={market.publicFillReveal ? "public" : "permitted"} />
                    <Metric label="Owner" value={shortAddress(market.owner)} />
                    <Metric label="Fee recipient" value={shortAddress(market.feeRecipient)} />
                  </div>
                </section>

                <section className="panel surface-panel">
                  <PanelTitle icon={<AlertTriangle size={18} />} label={busy ? busy : "Activity"} />
                  <div className="activity-list">
                    {activity.map((item) => (
                      <div className={`activity-item ${item.tone}`} key={item.id}>
                        <span />
                        <div>
                          <strong>{item.label}</strong>
                          <p>{item.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                {settlementPreview && (
                  <section className="panel surface-panel wide-surface">
                    <PanelTitle icon={<CheckCircle2 size={18} />} label="Last settlement" />
                    <div className="settlement-readout">
                      <strong>{settlementPreview.matched ? "Matched" : "No fill"}</strong>
                      <span>Match {settlementPreview.matchId}</span>
                      <span>{formatAmount(settlementPreview.amount, market.baseDecimals)} base</span>
                      <span>{formatAmount(settlementPreview.price, market.quoteDecimals)} quote/base</span>
                      <span>{formatAmount(settlementPreview.quotePaid, market.quoteDecimals)} quote paid</span>
                      <span>{formatAmount(settlementPreview.makerFee + settlementPreview.takerFee, market.quoteDecimals)} quote fees</span>
                    </div>
                  </section>
                )}
              </div>
            </div>
          )}

          {activeView === "admin" && (
            <div className="view-stack">
              <div className="view-heading">
                <div>
                  <span>Admin</span>
                  <h2>Market controls</h2>
                </div>
              </div>
              <section className="panel surface-panel">
                <PanelTitle icon={<SlidersHorizontal size={18} />} label="Owner actions" />
                <div className="admin-grid">
                  <NumberField label="Maker bps" value={adminMakerFeeBps} onChange={setAdminMakerFeeBps} />
                  <NumberField label="Taker bps" value={adminTakerFeeBps} onChange={setAdminTakerFeeBps} />
                  <AddressField label="Fee recipient" value={adminFeeRecipient} valid={!adminFeeRecipient || isAddress(adminFeeRecipient)} onChange={setAdminFeeRecipient} />
                  <button className="wide-button quiet" type="button" onClick={updateFeeConfig} disabled={!canAdmin || isBusy}>Update fees</button>
                  <NumberField label="Min fill" value={adminMinFillAmount} onChange={setAdminMinFillAmount} />
                  <NumberField label="Max fill" value={adminMaxFillAmount} onChange={setAdminMaxFillAmount} />
                  <NumberField label="Max quote" value={adminMaxQuoteValue} onChange={setAdminMaxQuoteValue} />
                  <button className="wide-button quiet" type="button" onClick={updateRiskLimits} disabled={!canAdmin || isBusy}>Update risk</button>
                  <AddressField label="Keeper" value={adminKeeper} valid={!adminKeeper || isAddress(adminKeeper)} onChange={setAdminKeeper} />
                  <ToggleField label="Keeper active" checked={adminKeeperActive} onChange={setAdminKeeperActive} disabled={!canAdmin || isBusy} />
                  <button className="wide-button quiet" type="button" onClick={updateKeeper} disabled={!canAdmin || isBusy}>Update keeper</button>
                  <ToggleField label="Permissionless" checked={market.permissionlessMatching} onChange={setPermissionless} disabled={!canAdmin || isBusy} />
                  <ToggleField label="Public fills" checked={market.publicFillReveal} onChange={setPublicReveal} disabled={!canAdmin || isBusy} />
                  <button className="wide-button quiet" type="button" onClick={() => setMarketPaused(!market.paused)} disabled={!canAdmin || isBusy}>{market.paused ? "Open market" : "Pause market"}</button>
                  <NumberField label="Quote fees" value={adminWithdrawQuote} onChange={setAdminWithdrawQuote} />
                  <button className="wide-button quiet" type="button" onClick={withdrawProtocolQuoteFees} disabled={!canAdmin || isBusy || market.protocolQuoteFees === 0n}>Withdraw fees</button>
                </div>
              </section>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

function StatusPill({ icon, label, tone }: { icon: React.ReactNode; label: string; tone: ActivityTone }) {
  return (
    <div className={`status-pill ${tone}`}>
      {icon}
      <span>{label}</span>
    </div>
  );
}

function PanelTitle({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="panel-title">
      {icon}
      <span>{label}</span>
    </div>
  );
}

function AddressField({
  label,
  value,
  valid,
  onChange,
}: {
  label: string;
  value: string;
  valid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field address-field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
      <i className={valid ? "valid" : "invalid"} />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ToggleField({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="toggle-field">
      <span>{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

