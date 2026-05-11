import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  CircleDot,
  EyeOff,
  KeyRound,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Send,
  ShieldCheck,
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
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/web";
import { Encryptable, type CofheClient } from "@cofhe/sdk";
import { chains as cofheChains } from "@cofhe/sdk/chains";
import {
  configuredAddresses,
  darkPoolDexAbi,
  DEFAULT_PRICE_SCALE,
  hasAllAddresses,
  mockTokenAbi,
  type ContractAddresses,
} from "./lib/contracts";

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
  baseWallet: bigint;
  quoteWallet: bigint;
  nextOrderId: bigint;
  nextMatchId: bigint;
};

type SettlementPreview = {
  matchId: string;
  matched: boolean;
  amount: bigint;
  price: bigint;
  quotePaid: bigint;
};

type AddressDraft = Record<keyof ContractAddresses, string>;

const SUPPORTED_CHAINS: Record<number, Chain> = {
  [hardhat.id]: hardhat,
  [sepolia.id]: sepolia,
  [arbitrumSepolia.id]: arbitrumSepolia,
  [baseSepolia.id]: baseSepolia,
};

const COFHE_SUPPORTED_CHAINS = [
  cofheChains.hardhat,
  cofheChains.localcofhe,
  cofheChains.sepolia,
  cofheChains.arbSepolia,
  cofheChains.baseSepolia,
];

const INITIAL_BALANCES: Balances = {
  baseEscrow: 0n,
  quoteEscrow: 0n,
  baseWallet: 0n,
  quoteWallet: 0n,
  nextOrderId: 1n,
  nextMatchId: 1n,
};

function shortAddress(address?: string) {
  if (!address) return "Not connected";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatAmount(value: bigint, digits = 4) {
  const formatted = formatUnits(value, 18);
  const [whole, fraction = ""] = formatted.split(".");
  const trimmed = fraction.slice(0, digits).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
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

function parsePositiveUnits(value: string, label: string) {
  const parsed = parseUnits(value || "0", 18);
  if (parsed <= 0n) throw new Error(`${label} must be greater than zero`);
  return parsed;
}

function toContractInput<T extends { signature: string }>(input: T): T & { signature: `0x${string}` } {
  return { ...input, signature: input.signature as `0x${string}` };
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
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderPrice, setOrderPrice] = useState("2000");
  const [orderAmount, setOrderAmount] = useState("1");
  const [expiryMinutes, setExpiryMinutes] = useState("60");
  const [depositBaseAmount, setDepositBaseAmount] = useState("1");
  const [depositQuoteAmount, setDepositQuoteAmount] = useState("5000");
  const [buyOrderId, setBuyOrderId] = useState("1");
  const [sellOrderId, setSellOrderId] = useState("2");
  const [matchId, setMatchId] = useState("1");
  const [busy, setBusy] = useState<string | null>(null);
  const [encryptStage, setEncryptStage] = useState("Idle");
  const [settlementPreview, setSettlementPreview] = useState<SettlementPreview | null>(null);
  const [activity, setActivity] = useState<Activity[]>([
    {
      id: 1,
      tone: "ok",
      label: "Wave 4 shell",
      detail: "Contracts, SDK client, escrow, and settlement console loaded.",
    },
  ]);

  const ready = hasAllAddresses(addresses);
  const currentChain = wallet ? SUPPORTED_CHAINS[wallet.chainId] : null;

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
    return wallet;
  }, [ready, wallet]);

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

      const cofheClient = createCofheClient(
        createCofheConfig({
          supportedChains: COFHE_SUPPORTED_CHAINS,
          useWorkers: true,
        }),
      );
      await cofheClient.connect(publicClient, walletClient);

      setWallet({ account, chainId, publicClient, walletClient, cofheClient });
      pushActivity("ok", "Wallet connected", `${shortAddress(account)} on ${chain.name}`);
    });
  }, [pushActivity, runAction]);

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

      const [baseEscrow, quoteEscrow, baseWallet, quoteWallet, nextOrderId, nextMatchId] =
        await Promise.all([
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexAbi,
            functionName: "baseBalance",
            args: [active.account],
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexAbi,
            functionName: "quoteBalance",
            args: [active.account],
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.baseToken,
            abi: mockTokenAbi,
            functionName: "balanceOf",
            args: [active.account],
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.quoteToken,
            abi: mockTokenAbi,
            functionName: "balanceOf",
            args: [active.account],
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexAbi,
            functionName: "nextOrderId",
          }) as Promise<bigint>,
          active.publicClient.readContract({
            address: addresses.darkPoolDex,
            abi: darkPoolDexAbi,
            functionName: "nextMatchId",
          }) as Promise<bigint>,
        ]);

      setBalances({ baseEscrow, quoteEscrow, baseWallet, quoteWallet, nextOrderId, nextMatchId });
      pushActivity("ok", "State refreshed", `Next order ${nextOrderId.toString()}`);
    });
  }, [addresses, pushActivity, requireWallet, runAction]);

  const deposit = useCallback(
    async (asset: "base" | "quote") => {
      await runAction(`Deposit ${asset}`, async () => {
        const active = requireWallet();
        if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

        const token = asset === "base" ? addresses.baseToken : addresses.quoteToken;
        const amount = parsePositiveUnits(
          asset === "base" ? depositBaseAmount : depositQuoteAmount,
          "Deposit amount",
        );

        const approveHash = await active.walletClient.writeContract({
          address: token,
          abi: mockTokenAbi,
          functionName: "approve",
          args: [addresses.darkPoolDex, amount],
          account: active.account,
          chain: undefined,
        });
        await waitForTx(active.publicClient, approveHash, "Approve escrow");

        const depositHash = await active.walletClient.writeContract({
          address: addresses.darkPoolDex,
          abi: darkPoolDexAbi,
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
      depositBaseAmount,
      depositQuoteAmount,
      refreshBalances,
      requireWallet,
      runAction,
      waitForTx,
    ],
  );

  const placeOrder = useCallback(async () => {
    await runAction("Place encrypted order", async () => {
      const active = requireWallet();
      if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

      const price = parsePositiveUnits(orderPrice, "Price");
      const amount = parsePositiveUnits(orderAmount, "Amount");
      const minutes = BigInt(Number(expiryMinutes || "0"));
      if (minutes <= 0n) throw new Error("Expiry must be greater than zero");

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
        abi: darkPoolDexAbi,
        functionName: "placeOrder",
        args: [toContractInput(encryptedPrice), toContractInput(encryptedAmount), toContractInput(encryptedSide), expiry],
        account: active.account,
        chain: undefined,
      });
      await waitForTx(active.publicClient, hash, "Submit encrypted order");
      setEncryptStage("Ready");
      await refreshBalances();
    });
  }, [
    addresses,
    expiryMinutes,
    orderAmount,
    orderPrice,
    refreshBalances,
    requireWallet,
    runAction,
    side,
    waitForTx,
  ]);

  const prepareMatch = useCallback(async () => {
    await runAction("Prepare match", async () => {
      const active = requireWallet();
      if (!hasAllAddresses(addresses)) throw new Error("Missing addresses");

      const hash = await active.walletClient.writeContract({
        address: addresses.darkPoolDex,
        abi: darkPoolDexAbi,
        functionName: "tryMatch",
        args: [BigInt(buyOrderId), BigInt(sellOrderId)],
        account: active.account,
        chain: undefined,
      });
      await waitForTx(active.publicClient, hash, "FHE match");
      setMatchId((balances.nextMatchId || 1n).toString());
      await refreshBalances();
    });
  }, [
    addresses,
    balances.nextMatchId,
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
        abi: darkPoolDexAbi,
        functionName: "getMatchHandles",
        args: [BigInt(matchId)],
      })) as readonly [`0x${string}`, `0x${string}`, `0x${string}`];

      pushActivity("run", "Decrypt fill", `Match ${matchId}`);
      const matched = await active.cofheClient.decryptForTx(handles[0]).withoutPermit().execute();
      const fillAmount = await active.cofheClient.decryptForTx(handles[1]).withoutPermit().execute();
      const fillPrice = await active.cofheClient.decryptForTx(handles[2]).withoutPermit().execute();
      const matchedPlaintext = matched.decryptedValue !== 0n;
      const quotePaid = (fillAmount.decryptedValue * fillPrice.decryptedValue) / DEFAULT_PRICE_SCALE;

      setSettlementPreview({
        matchId,
        matched: matchedPlaintext,
        amount: fillAmount.decryptedValue,
        price: fillPrice.decryptedValue,
        quotePaid,
      });

      const hash = await active.walletClient.writeContract({
        address: addresses.darkPoolDex,
        abi: darkPoolDexAbi,
        functionName: "finalizeMatch",
        args: [
          BigInt(matchId),
          matchedPlaintext,
          matched.signature,
          fillAmount.decryptedValue,
          fillAmount.signature,
          fillPrice.decryptedValue,
          fillPrice.signature,
        ],
        account: active.account,
        chain: undefined,
      });
      await waitForTx(active.publicClient, hash, "Settle fill");
      await refreshBalances();
    });
  }, [addresses, matchId, pushActivity, refreshBalances, requireWallet, runAction, waitForTx]);

  const isBusy = Boolean(busy);

  return (
    <main className="app-shell">
      <section className="topbar">
        <div className="brand-mark">
          <span className="brand-orbit" />
          <div>
            <p className="eyebrow">Wave 4</p>
            <h1>Dark Pool DEX</h1>
          </div>
        </div>

        <div className="top-actions">
          <button className="icon-button" type="button" onClick={refreshBalances} disabled={!wallet || !ready || isBusy} title="Refresh">
            <RefreshCw size={18} />
          </button>
          <button className="wallet-button" type="button" onClick={connectWallet} disabled={isBusy}>
            <Wallet size={18} />
            {wallet ? shortAddress(wallet.account) : "Connect"}
          </button>
        </div>
      </section>

      <section className="status-strip">
        <StatusPill
          icon={<ShieldCheck size={16} />}
          label={ready ? "Contracts linked" : "Contracts missing"}
          tone={ready ? "ok" : "warn"}
        />
        <StatusPill
          icon={<CircleDot size={16} />}
          label={currentChain ? currentChain.name : "No chain"}
          tone={currentChain ? "ok" : "warn"}
        />
        <StatusPill icon={<LockKeyhole size={16} />} label={encryptStage} tone={encryptStage === "Idle" ? "warn" : "ok"} />
      </section>

      <section className="workspace-grid">
        <aside className="left-rail">
          <PanelTitle icon={<KeyRound size={18} />} label="Contracts" />
          <AddressField
            label="DEX"
            value={addressDraft.darkPoolDex}
            valid={addressValidity.darkPoolDex}
            onChange={(value) => setAddressDraft((draft) => ({ ...draft, darkPoolDex: value }))}
          />
          <AddressField
            label="Base"
            value={addressDraft.baseToken}
            valid={addressValidity.baseToken}
            onChange={(value) => setAddressDraft((draft) => ({ ...draft, baseToken: value }))}
          />
          <AddressField
            label="Quote"
            value={addressDraft.quoteToken}
            valid={addressValidity.quoteToken}
            onChange={(value) => setAddressDraft((draft) => ({ ...draft, quoteToken: value }))}
          />
          <button className="wide-button quiet" type="button" onClick={applyAddresses}>
            Apply
          </button>

          <div className="metric-stack">
            <Metric label="Wallet base" value={formatAmount(balances.baseWallet)} />
            <Metric label="Escrow base" value={formatAmount(balances.baseEscrow)} />
            <Metric label="Wallet quote" value={formatAmount(balances.quoteWallet)} />
            <Metric label="Escrow quote" value={formatAmount(balances.quoteEscrow)} />
          </div>
        </aside>

        <section className="main-stage">
          <div className="stage-header">
            <div>
              <p className="eyebrow">Private order ticket</p>
              <h2>Encrypted intent, public settlement proof</h2>
            </div>
            <div className="flow-signal" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          </div>

          <div className="ticket-grid">
            <div className="ticket-column">
              <div className="segmented">
                <button className={side === "buy" ? "active" : ""} type="button" onClick={() => setSide("buy")}>
                  Buy
                </button>
                <button className={side === "sell" ? "active" : ""} type="button" onClick={() => setSide("sell")}>
                  Sell
                </button>
              </div>
              <NumberField label="Price" value={orderPrice} onChange={setOrderPrice} />
              <NumberField label="Amount" value={orderAmount} onChange={setOrderAmount} />
              <NumberField label="Expiry min" value={expiryMinutes} onChange={setExpiryMinutes} />
              <button className="wide-button primary" type="button" onClick={placeOrder} disabled={!wallet || !ready || isBusy}>
                {busy === "Place encrypted order" ? <Loader2 className="spin" size={17} /> : <Send size={17} />}
                Place encrypted order
              </button>
            </div>

            <div className="privacy-map">
              <div className="map-ring">
                <EyeOff size={28} />
                <span className="ring-one" />
                <span className="ring-two" />
              </div>
              <div className="map-rows">
                <FlowRow label="Encrypt" value="price + size + side" />
                <FlowRow label="Compute" value="gte + min + select" />
                <FlowRow label="Reveal" value="fill only" />
              </div>
            </div>
          </div>
        </section>

        <aside className="right-rail">
          <PanelTitle icon={<ArrowRightLeft size={18} />} label="Escrow" />
          <div className="deposit-row">
            <NumberField label="Base" value={depositBaseAmount} onChange={setDepositBaseAmount} />
            <button className="icon-action" type="button" onClick={() => deposit("base")} disabled={!wallet || !ready || isBusy} title="Deposit base">
              <ArrowRightLeft size={17} />
            </button>
          </div>
          <div className="deposit-row">
            <NumberField label="Quote" value={depositQuoteAmount} onChange={setDepositQuoteAmount} />
            <button className="icon-action" type="button" onClick={() => deposit("quote")} disabled={!wallet || !ready || isBusy} title="Deposit quote">
              <ArrowRightLeft size={17} />
            </button>
          </div>

          <PanelTitle icon={<ShieldCheck size={18} />} label="Match" />
          <div className="match-line">
            <NumberField label="Buy ID" value={buyOrderId} onChange={setBuyOrderId} />
            <NumberField label="Sell ID" value={sellOrderId} onChange={setSellOrderId} />
          </div>
          <button className="wide-button" type="button" onClick={prepareMatch} disabled={!wallet || !ready || isBusy}>
            Prepare FHE match
          </button>
          <div className="match-line">
            <NumberField label="Match ID" value={matchId} onChange={setMatchId} />
            <button className="icon-action" type="button" onClick={finalizeMatch} disabled={!wallet || !ready || isBusy} title="Finalize">
              <CheckCircle2 size={17} />
            </button>
          </div>

          {settlementPreview && (
            <div className="settlement-readout">
              <span>Match {settlementPreview.matchId}</span>
              <strong>{settlementPreview.matched ? "Matched" : "No fill"}</strong>
              <span>{formatAmount(settlementPreview.amount)} base</span>
              <span>{formatAmount(settlementPreview.price)} quote/base</span>
              <span>{formatAmount(settlementPreview.quotePaid)} quote paid</span>
            </div>
          )}
        </aside>
      </section>

      <section className="bottom-grid">
        <div className="activity-panel">
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
        </div>

        <div className="roadmap-panel">
          <PanelTitle icon={<LockKeyhole size={18} />} label="Wave Status" />
          <div className="roadmap-list">
            <Metric label="Next order" value={balances.nextOrderId.toString()} />
            <Metric label="Next match" value={balances.nextMatchId.toString()} />
            <Metric label="Wave 5" value="partial fills, auctions, real pairs" />
          </div>
        </div>
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function FlowRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flow-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
