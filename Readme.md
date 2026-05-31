# Dark Pool DEX — MEV-Proof Private Exchange

A **sealed-order decentralized exchange** where limit orders live as **FHE-encrypted ciphertexts** on-chain. The matching logic runs on **encrypted state** using [Fhenix](https://fhenix.io) **CoFHE** (Co-processor for FHE). Price and quantity are not readable from the public ledger until a match is finalized—addressing **MEV at the architectural level**, not with another mempool patch.

This repository is being built for the **[Privacy-by-Design dApp Buildathon](https://fhenix.io)** (“Build the Encrypted Fhenix Ecosystem”), which funds teams building **privacy-native** protocols on **Fully Homomorphic Encryption (FHE)** so confidentiality is a **primitive**, not a retrofit.

---

## Wave 5 implementation status

Wave 5 is implemented as a testnet-ready Hardhat + React app with the full encrypted order lifecycle:

- `DarkPoolDex.sol` stores encrypted price, original amount, remaining amount, and side using CoFHE encrypted inputs.
- `tryMatch`, `tryBatchMatch`, and `tryBatchMatches` compute crossing, fill size, fill price, and post-fill closed flags with FHE operations (`gte`, `and`, `not`, `min`, `select`, `sub`, `eq`) without exposing resting order data.
- `finalizeMatch` verifies `decryptForTx` threshold signatures for match state, fill amount, fill price, and per-order filled flags before moving ERC-20 escrow.
- Partial fills are supported across multiple counterparties with encrypted remaining balances, stale-match nonce protection, and cancellation of partially filled orders.
- Order-specific public reserve amounts were removed so order placement no longer broadcasts side-specific size/notional collateral. Settlement now verifies live escrow availability and invalidates orders whose escrow is no longer available.
- Keeper operations are supported with permissionless or allowlisted matcher modes, retrying keeper script, deterministic FIFO pair attempts, batch-window checks, and finalized-pair replay protection.
- Batch auctions are supported through configurable batch duration and closed-batch matching.
- Real-token readiness includes ERC-20 metadata decimals, allowance-aware deposits, configured token addresses, per-match risk-limit snapshots, and dynamic frontend formatting.
- Maker/taker fees accrue in quote escrow, emit transparent fill-fee events, and can be withdrawn by the owner through protocol accounting controls.
- Selective disclosure helpers let traders or approved operators grant order/match ciphertext access to counterparties, auditors, or keepers without making resting order data public.
- The React app includes owner-only market controls for pause/open, matcher policy, fill reveal policy, fee config, risk limits, keeper allowlisting, and fee withdrawal.
- The test suite covers partial fills, non-crossing settlement, stale prepared matches, fee accounting, keeper permissions, batch closure, zero-quote rejection, risk snapshots, escrow invalidation, and partial cancellation through CoFHE Hardhat mocks.

Mainnet funds still require an external audit and production incident process. The current target is public testnet deployment for Wavehack judging.

## Quick start

```bash
npm install
npm run check
npm run dev
```

The dev app runs at `http://127.0.0.1:5173`.

Useful commands:

| Command | Purpose |
|---------|---------|
| `npm run compile` | Compile Solidity and generate TypeChain bindings. |
| `npm test` | Run CoFHE mock end-to-end contract tests. |
| `npm run build` | Build the production React client. |
| `npm run deploy:local` | Deploy mock base token, mock quote token, and `DarkPoolDex` to a local Hardhat node. |
| `npm run demo:local` | Run an encrypted buy/sell match and settlement against the localhost deployment. |
| `npm run keeper:local` | Run one keeper tick against the localhost deployment. |
| `npm run deploy:sepolia` | Deploy to Ethereum Sepolia using `PRIVATE_KEY`. |
| `npm run deploy:arb-sepolia` | Deploy to Arbitrum Sepolia using `PRIVATE_KEY`. |
| `npm run deploy:base-sepolia` | Deploy to Base Sepolia using `PRIVATE_KEY`. |
| `npm run mint:sepolia` | Mint deployed mock base/quote tokens to the deployer or `MINT_TO`. |
| `npm run keeper:arb-sepolia` | Run one keeper tick against the Arbitrum Sepolia deployment. |
| `npm run deploy:vercel` | Deploy the frontend to Vercel production. |
| `npm run export:abi` | Export contract ABIs to the frontend. |

## Deployment

Create a local `.env` file when deploying. Do not commit it.

```bash
PRIVATE_KEY=0x...
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
MAKER_FEE_BPS=5
TAKER_FEE_BPS=15
BATCH_DURATION_SECONDS=60
```

Then run:

```bash
npm run deploy:arb-sepolia
```

The deploy script writes `deployments/<network>.json` and `src/generated/deployment.json` with Wave 5 market config, token decimals, risk limits, and keeper settings. The frontend also accepts:

```bash
VITE_DARK_POOL_DEX_ADDRESS=0x...
VITE_BASE_TOKEN_ADDRESS=0x...
VITE_QUOTE_TOKEN_ADDRESS=0x...
VITE_CHAIN_ID=11155111
```

Optional deploy-time controls:

```bash
BASE_TOKEN_ADDRESS=0x...        # use a live base token instead of deploying a mock
QUOTE_TOKEN_ADDRESS=0x...       # use a live quote token instead of deploying a mock
FEE_RECIPIENT=0x...
MIN_FILL_AMOUNT=1
MAX_FILL_AMOUNT=0              # 0 means no cap
MAX_QUOTE_VALUE=0              # 0 means no cap
PERMISSIONLESS_MATCHING=true
PUBLIC_FILL_REVEAL=true
KEEPER_ADDRESSES=0xabc...,0xdef...
```

Never commit a private key or `.env`.

### Mock token minting

Deployments that do not set `BASE_TOKEN_ADDRESS` and `QUOTE_TOKEN_ADDRESS` use demo mock ERC-20s with a one-claim-per-wallet faucet. Users can claim demo balances in the frontend, and the owner can still mint manually when needed:

```bash
PRIVATE_KEY=0x... MINT_TO=0x... MINT_BASE_AMOUNT=10 MINT_QUOTE_AMOUNT=50000 npm run mint:sepolia
```

Omit `MINT_TO` to mint to the deploying wallet. Use `MINT_BASE_AMOUNT=0` or `MINT_QUOTE_AMOUNT=0` to skip one side.

### Keeper operations

Run a single keeper tick:

```bash
npm run keeper:arb-sepolia
```

Run continuously:

```bash
KEEPER_RUN_FOREVER=true KEEPER_INTERVAL_MS=15000 npm run keeper:arb-sepolia
```

The keeper scans active public order IDs, attempts fair FIFO candidate pairs in both directions without plaintext order knowledge, finalizes public fill decryptions, skips finalized ordered pairs, and retries transient failures.

For local demos, start `npm run node`, rerun `npm run deploy:local` to create a fresh ignored `deployments/localhost.json`, then run `npm run demo:local` or `npm run keeper:local`.

### Vercel deployment

The frontend is Vercel-ready through `vercel.json`.

Production frontend: [https://dark-pool-dex.vercel.app](https://dark-pool-dex.vercel.app)

```bash
npm run build
npm run deploy:vercel
```

Set these Vercel environment variables after the contracts are deployed to a public testnet:

```bash
VITE_DARK_POOL_DEX_ADDRESS=0x...
VITE_BASE_TOKEN_ADDRESS=0x...
VITE_QUOTE_TOKEN_ADDRESS=0x...
```

Until those are configured, the hosted UI deliberately starts in a contract-unlinked state rather than shipping localhost addresses.

---

## What is this app?

**Dark Pool DEX** is a confidential DeFi primitive: a **dark pool**–style DEX where:

- **Orders are private by default** — bids and asks are stored as encrypted values; observers cannot read your price or size from chain state the way they can on a normal order book.
- **Matching uses encrypted comparisons** — the contract can ask “does this buy cross this sell?” and compute **fill price and size** using FHE operations **without decrypting** the resting orders for the world to see.
- **Settlement reveals only what’s necessary** — after a match, **fill outcome** (e.g. executed price and amount) can be decrypted for settlement and events, while the design goal is to **avoid leaking full order book intelligence** the way transparent DEXes do.

In one sentence: **it’s a DEX where your order isn’t public intelligence for bots the moment you submit it.**

---

## Why does this exist?

### The $500M+ MEV problem

Public blockchains made **transparency** the default. That enabled trustless verification—and also **predictable exploitation**:

- **MEV bots** watch the mempool and chain; they **front-run**, **sandwich**, and **back-run** your trades.
- Industry estimates often cite **hundreds of millions of dollars** in MEV extraction annually in DeFi; smaller trades are disproportionately hurt (**a large share of losses** hits trades under modest size).

**Faster execution** alone does not fix this: if your **intent and price** are visible before execution, adversaries can still react.

### The institutional and strategy gap

Many **institutions** and **professional traders** cannot treat a fully transparent order book as acceptable:

- **Compliance and counterparty risk** — showing full order flow publicly may be a non-starter.
- **Alpha leakage** — resting liquidity reveals **strategy**.

So the market isn’t only “retail getting sandwiched”; it’s also **participants who won’t use transparent rails at all**.

### Why FHE (and why not “just use a centralized dark pool”)?

- **Centralized** dark pools introduce **trust** in the operator.
- **On-chain transparency** fixes trust but **burns privacy**.

**Fully Homomorphic Encryption** lets smart contracts **compute on ciphertexts**: comparisons, min/max, conditional logic—**without decrypting** secret inputs on-chain. **Fhenix CoFHE** brings this to Solidity with encrypted types and a co-processor model suitable for **verifiable, decentralized** confidential execution.

This project uses that stack so **privacy and decentralization** are aligned: **MEV resistance** comes from **nothing useful to read** pre-settlement, not from a new relay trusted with your data.

---

## What does the app actually do?

### Core behaviors

| Aspect | Behavior |
|--------|----------|
| **Place order** | User encrypts price, amount, and side (buy/sell); submits ciphertexts to the contract. |
| **Order storage** | Orders store encrypted price, original amount, remaining amount, and side, tied to owner, expiry, fill nonce, and batch without side-specific public order reserves. |
| **Escrow model** | Users deposit ERC-20s into public escrow, while order placement avoids side-specific public reserve locks; settlement cancels orders if the required live escrow is unavailable. |
| **Matching** | Encrypted checks (`buy price >= sell price`), encrypted fill-size `min`, encrypted remaining-amount subtraction, and encrypted closed flags. |
| **Settlement** | `decryptForTx` reveals only fill outcome and closed flags needed for ERC-20 settlement, fee accounting, and stale-match safety. |
| **Frontend** | Wallet, CoFHE encryption/decryption, allowance-aware escrow, partial fill finalization, batch matching, cancellation, fees, and disclosure controls. |

### What “MEV-proof” means here (honest framing)

- **Architectural**: mempool observers **cannot** read plaintext prices/sizes off the **encrypted** order representation the way they do on a public order book.
- **Wave 5 scope** focuses on a production-grade public-testnet implementation: encrypted orders, encrypted partial fills, batch/keeper operations, fee accounting, and selective disclosure hooks. Mainnet deployment still requires external audit work.

---

## Use cases

This section describes **who benefits** and **concrete situations** where a **sealed-order, FHE-backed** exchange matters—not only abstract “privacy.”

### 1. Retail and active DeFi users (MEV and sandwich protection)

**Situation:** You place a swap or limit order on a public DEX. Bots see your **pending** or **resting** intent, move prices against you, or sandwich your trade.

**How this project helps:** Order **price and size** are not exposed as **plaintext chain state** in the same way as a normal on-chain order book. Matching logic runs on **ciphertexts**, so **pre-trade transparency** that feeds classic MEV strategies is **greatly reduced** by design. Execution fairness improves because **adversaries lack readable signals** they use today.

**Note:** Residual risks (e.g. metadata, timing, fill events) still need careful product and engineering choices; the **core thesis** is architectural hiding of **order content** until settlement rules allow disclosure.

### 2. Professional traders and market makers (strategy and inventory leakage)

**Situation:** Showing **full depth** and **your quotes** lets competitors **infer inventory**, **fade your quotes**, or **anticipate** your hedging.

**How this project helps:** A **dark pool** model—here implemented with **decentralized** matching—reduces **real-time leakage** of resting liquidity. Makers can supply liquidity with **less broadcast alpha**, which is closer to **TradFi dark pool** expectations than a fully transparent CLOB.

### 3. Treasury and protocol operations (large clips without advertising size)

**Situation:** A DAO or company treasury needs to **buy or sell** a large notional. **Transparent** orders **signal size** and move the market against the trade.

**How this project helps:** **Encrypted amounts** (and prices) make it harder for the public to **front-run a known whale order** purely from **readable book data**. Settlement still produces **fills** (often observable), but the **pre-trade** information asymmetry that bots exploit is narrowed.

### 4. Institutions and compliance-sensitive flows

**Situation:** Some firms **cannot** put **full order flow** on a **public** audit trail visible to everyone, or need **selective disclosure** to regulators rather than **global transparency**.

**How this project helps:** **FHE + permits** enable a path toward **selective decryption**—only **counterparties**, **auditors**, or **authorized parties** see what they must, instead of **every indexer** seeing everything. This aligns with **confidential DeFi** narratives in the Fhenix ecosystem (RWA, reporting, audits) as the stack matures.

### 5. Builders and downstream protocols (composable confidential execution)

**Situation:** Other protocols need **sealed bids**, **private auctions**, or **hidden limit logic** composable with **ERC-20** settlement.

**How this project helps:** The same **OrderBook → MatchingEngine → Settlement** pattern is **reusable infrastructure**: not only a standalone DEX but a **template** for **encrypted state + selective reveal** in other **Confidential DeFi** products.

### 6. Hackathon and research (proof of FHE on-chain)

**Situation:** Teams need a **clear, judge-friendly** demo that shows **Fhenix CoFHE** in production: encrypt → compute on ciphertext → decrypt where allowed.

**How this project helps:** **Wave 5** delivers a judge-friendly but production-grade testnet slice: deploy encrypted orders, match with FHE ops, settle partial fills with decrypt proofs, run keepers/batches, and show fee/risk/disclosure controls.

### Use-case summary

| Use case | Primary pain | What we optimize for |
|----------|----------------|----------------------|
| Retail DeFi | Sandwiches, front-running | Unreadable **order content** pre-fill |
| Pros / MMs | Quote & inventory leakage | **Dark pool**-style **sealed** book |
| Treasuries | Size signaling | **Hidden** size/price **before** match |
| Institutions | Public flow / compliance | **Selective** disclosure controls |
| Ecosystem | Composability | **Reusable** encrypted order primitive |
| Buildathon | Demo + narrative | **End-to-end** CoFHE **proof** |

---

## How it works (end-to-end)

### 1. Normal DEX vs this design

**Typical DEX / CLOB on-chain:**  
Order or swap intent is **visible** (or inferable) **before** execution → bots **react**.

**Dark Pool DEX:**
Orders are **ciphertexts**; **matching** runs on **encrypted state**. Outsiders don’t get plaintext **prices and sizes** for free off the book.

### 2. Smart contract layers (implementation architecture)

The implementation is a single deployable `DarkPoolDex.sol` with clear logical modules:

1. **`OrderBook.sol`** — **Encrypted order registry**
   - Stores `Order` structs with `euint128 price`, `euint128 originalAmount`, `euint128 remainingAmount`, `ebool isBuy`, `owner`, `expiry`, `batchId`, and `fillNonce`.
   - `placeOrder` accepts **client-encrypted** inputs (`inEuint128`, `inEbool`), converts via `FHE.asEuint128` / `FHE.asEbool`, assigns IDs, and sets **FHE permissions** (`allowThis`, `allow` to owner) for later operations.

2. **`MatchingEngine.sol`** — **Encrypted matching**
   - Takes candidate order pairs from users or keepers through `tryMatch`, `tryBatchMatch`, or `tryBatchMatches`.
   - Uses **`FHE.gte`**, **`FHE.min`**, **`FHE.select`**, **`FHE.sub`**, and **`FHE.eq`** so **comparisons, fills, remaining balances, and closed flags** stay encrypted until settlement.
   - If prices don’t cross, **no meaningful fill**—without revealing either side’s plaintext.

3. **`Settlement.sol`** — **Selective decryption & transfers**
   - Verifies `decryptForTx` proofs for match bit, fill price, fill amount, and closed flags.
   - Executes **ERC-20** transfers, maker/taker fee accounting, risk-limit checks, and nonce-based stale-match protection.
   - Emits events that reflect **fills** without revealing full resting orders.

### 3. Frontend (React + CoFHE)

- **`useEncrypt`**: encrypt `price`, `amount`, `side` before calling `placeOrder`.
- **`useWrite`**: submit transactions to the order book contract.
- **`useDecrypt`** (where permitted): show **fill results** or other **explicitly allowed** decrypted values to the user.

This mirrors common **wagmi-style** mental models but with an **encrypt → transact → decrypt (where allowed)** loop.

---

## System design

This section describes **how the system is structured**, **how data moves**, and **what each part is responsible for**—from hackathon MVP to a more complete mental model.

### Design goals

| Goal | Meaning |
|------|--------|
| **Confidentiality** | Order **price**, **amount**, and **side** are not plaintext in contract storage for arbitrary observers to read like a normal CLOB. |
| **Correctness** | Matching and settlement follow **explicit rules** (crossing prices, fill qty, asset conservation). |
| **Verifiability** | Logic runs **on-chain** under Fhenix rules; keepers propose pairs for liveness, but the contract verifies crossing, fill amount, remaining state, fees, and settlement. |
| **Minimal disclosure** | Only **fill-related** values and **authorized** views decrypt when the design allows—not the entire history of every resting order in plaintext. |
| **Evolvability** | **OrderBook / MatchingEngine / Settlement** can be extended (batching, fees, hooks) without collapsing into one unmaintainable contract. |

### High-level architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Application layer — Web client                             │
│  React · Wallet (EIP-1193) · @cofhe/react                   │
│  · Encrypt plaintext order fields locally                     │
│  · Submit txs to contracts                                  │
│  · Decrypt only what the protocol + permits allow           │
└────────────────────────────┬────────────────────────────────┘
                             │ JSON-RPC / wallet
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Orchestration (Wave 5 keeper)                               │
│  Matcher script / keeper / bot                               │
│  · Select FIFO candidate IDs without plaintext order content │
│  · Call tryMatch / tryBatchMatch on-chain                    │
│  · Finalize decrypt-proof fill settlement                    │
└────────────────────────────┬────────────────────────────────┘
                             │ transactions
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  On-chain — Fhenix CoFHE–enabled L2 (e.g. Arbitrum Sepolia)  │
│  ┌─────────────┐  ┌──────────────────┐  ┌─────────────────┐   │
│  │ OrderBook   │  │ MatchingEngine   │  │ Settlement      │   │
│  │ ciphertexts │→ │ FHE.gte/min/     │→ │ decrypt fill    │   │
│  │ + ACL       │  │ select …         │  │ ERC-20 transfer │   │
│  └─────────────┘  └──────────────────┘  └─────────────────┘   │
│         │                    │                    │            │
│         └────────────────────┴────────────────────┘            │
│                    FHE.sol · permissions · CoFHE coprocessor     │
└─────────────────────────────────────────────────────────────┘
```

**CoFHE’s role (conceptual):** Fhenix uses a **co-processor** model so **heavy FHE work** is not done naively inside every EVM opcode step. Contracts hold **handles** to encrypted values and invoke **supported** homomorphic operations; **decryption** is **gated** according to protocol rules and **permits**. Think: **encrypted state on-chain**, **specialized FHE execution** off the hot path of classic EVM, **verifiable linkage** to what the chain records.

### Logical components (responsibilities)

| Component | Responsibility | Inputs / outputs (conceptual) |
|-----------|----------------|----------------------------------|
| **Client** | UX, key management for encryption, tx submission | Plaintext order → **ciphertext** args; receives **tx receipts**, optional **decrypted** fills |
| **OrderBook** | Persistent **encrypted** orders, IDs, **expiry**, **owner**; **FHE.allow** for contract and user | `placeOrder(enc…)` → stored `Order`; exposes order **handles** to authorized callers |
| **MatchingEngine** | Given two order IDs, compute **encrypted** price match, **fill qty**, **fill price**; drive `_settle` when rules say so | Reads `orders[buyId]`, `orders[sellId]`; outputs **encrypted** fill + **match flag** |
| **Settlement** | **Decrypt** allowed fill values for **transfer**; emit fill/fee events; update encrypted remaining balances | **Matched** fills → token movement, fees, nonce updates |
| **Keeper** | **Off-chain** liveness process that proposes pairs without plaintext order content; can be permissionless or allowlisted | `tryMatch`, `tryBatchMatch`, `finalizeMatch` calls |

### Data flows

**A. Place order**

1. User enters **price**, **amount**, **side** in the UI.
2. Client runs **CoFHE encrypt** for each field (correct **FheUType**).
3. User signs **`placeOrder`**; tx lands on-chain.
4. Contract stores **ciphertext handles**; **`FHE.allowThis`** / **`FHE.allow`** wire matching, settlement, user view, keeper, and disclosure permissions.
5. Observers may still see **that** an order exists depending on what is public (e.g. **order ID**, **owner**, **expiry**)—**minimizing metadata leakage** is a **product/engineering** choice for later iterations.

**B. Match (keeper or user caller)**

1. Matcher chooses **`buyId`**, **`sellId`** using public IDs and batch metadata, not plaintext price/amount.
2. Contract **`tryMatch`** or **`tryBatchMatch`** loads **encrypted** fields, runs **`FHE.gte`**, **`FHE.min`**, **`FHE.select`**, **`FHE.sub`**, and **`FHE.eq`**.
3. If not crossing, **fill** path stays **empty/zero** under encryption—**no** need to reveal raw bid/ask.
4. If crossing, encrypted fill price/qty, encrypted remaining amounts, and encrypted closed flags feed **`finalizeMatch`**.

**C. Settle**

1. **`finalizeMatch`** verifies threshold signatures for **only** the fill values needed for transfer and order closure.
2. **ERC-20** transfers execute **quote** and **base** legs with maker/taker fees and risk-limit checks.
3. **`MatchFinalized`** exposes executed price, size, fees, and closed flags; the full resting order remains encrypted.

### Trust boundaries

| Zone | Trusted for what |
|------|-------------------|
| **User’s browser / wallet** | Correct **encryption** of user intent; **key safety**; not tampering with client code |
| **Chain + Fhenix CoFHE** | **Correct execution** of contract logic and **FHE** semantics; **finality** of state |
| **Keeper / matcher** | **Liveness** and **pair selection**—which matches get attempted **first**; should **not** be able to **decrypt** resting orders unless given disclosure permissions |
| **Counterparty** | Sees **fill** outcome and tokens as in any trade—**not** the same as seeing your full **historical** resting book if that stays encrypted |

### Threat and privacy notes (engineering honesty)

- **Metadata:** Even with **encrypted** fields, **timestamps**, **gas patterns**, escrow deposits, or **public** **owner** addresses may leak **some** information—mitigations include **batching**, **delayed revelation**, and **minimal** public fields.
- **Fill transparency:** If **every** fill is **public** on-chain, **post-trade** information still exists; the **main win** is **pre-trade** book **opacity**.  
- **MEV:** **Architectural** hiding of **order content** is the **focus**; **ordering** of txs in the **same** block can still be a topic for **advanced** designs.

### Wave 5 capabilities

| Aspect | Implemented behavior |
|--------|----------------------|
| **Pair selection** | Permissionless or allowlisted keeper flow with FIFO candidate attempts and replay protection |
| **Batching** | Configurable closed-batch matching through `tryBatchMatch` and `tryBatchMatches` |
| **Liquidity** | Configured ERC-20 pairs, token decimals, allowance-aware escrow, live escrow settlement checks, risk snapshots, and maker/taker fees |
| **UX** | Place, deposit, withdraw, match, finalize, cancel partial orders, inspect fees, and grant disclosure |
| **Security review** | Reentrancy guards, stale-match nonces, focused tests, and explicit external-audit requirement before mainnet funds |

### Design principles (recap)

1. **Minimize decryption surface** — decrypt **fills** and **user-owned** views under **permits**, not the entire book.
2. **Clear separation** — **storage** (OrderBook) vs **matching** (MatchingEngine) vs **asset movement** (Settlement).
3. **Operational liveness** — keepers can propose pairs, but cannot alter encrypted matching or settlement truth.
4. **Future-proofing** — the same **encrypted order** core extends to solver networks, richer auctions, and institutional disclosure flows.

### Tech stack (reference)

| Layer | Technology |
|-------|--------------|
| **FHE on-chain** | `@fhenixprotocol/cofhe/contracts/FHE.sol`, Solidity encrypted types |
| **Client** | `@cofhe/sdk` with React + viem wallet clients for encrypt → transact → decrypt-proof settlement |
| **Network (buildathon)** | **Arbitrum Sepolia** (also: Sepolia, Base Sepolia per Fhenix docs) |
| **Tooling** | Hardhat + Fhenix CoFHE plugin for local/dev workflows |

**Official resources:** [Fhenix docs](https://docs.fhenix.io), [CoFHE quick start](https://cofhe-docs.fhenix.zone/fhe-library/introduction/quick-start), [CoFHE architecture overview](https://cofhe-docs.fhenix.zone/deep-dive/cofhe-components/overview), [Awesome Fhenix](https://github.com/FhenixProtocol/awesome-fhenix).

---

## Buildathon alignment (Wavehack / Fhenix Buildathon)

This project fits the buildathon’s **Confidential DeFi** theme:

- **Private positions, sealed-bid style mechanics, MEV-protected execution** — exactly the narrative in the program materials.
- **Privacy-by-design** — confidentiality is **in the architecture** (encrypted order book + FHE matching), not an add-on.

### Wave 5 submission target

1. Deploy **`DarkPoolDex.sol`** on a CoFHE-supported public testnet with encrypted `placeOrder`, partial fills, fees, batch matching, and keeper permissions enabled.
2. Run the keeper script to propose FIFO candidate pairs, retry transient failures, finalize decrypt-proof settlement, and avoid duplicate finalized ordered pairs.
3. Use the React UI for wallet connection, real-token decimal display, allowance-aware escrow, encrypted orders, batch/manual match preparation, fill finalization, cancellation, and selective disclosure.
4. Present the test suite and README as the security narrative: stale-match nonce protection, reentrancy guards, risk limits, fee accounting, and remaining audit requirements.

Exact dates and grants follow the **Privacy-by-Design dApp Buildathon** schedule; see official announcements for current milestones.

---

## Who is this for?

- **Traders** who want **less predictable exploitation** of resting liquidity.  
- **Protocols and institutions** evaluating **confidential DeFi** primitives.  
- **Builders** who want **infrastructure-grade** privacy (encrypted compute on-chain), not a single-feature hack.

---

## Summary

| Question | Answer |
|----------|--------|
| **What is it?** | A **FHE-based dark pool DEX**: encrypted orders, encrypted partial-fill matching logic, selective decryption at settlement. |
| **What does it do?** | Lets users **place hidden limit orders**, partially fill them across counterparties, and settle without broadcasting plaintext order book data like a traditional on-chain CLOB. |
| **Why?** | **MEV** and **strategy leakage** on transparent DEXes; **institutional** demand for **confidential** execution. |
| **Who uses it?** | **Retail** (sandwich resistance), **pros/MMs** (less quote leakage), **treasuries** (size not advertised), **institutions** (selective disclosure path), **other protocols** (composable sealed orders). See [Use cases](#use-cases). |
| **How?** | **Fhenix CoFHE** in Solidity + **@cofhe/sdk** on the client; **place → match/batch → decrypt proof → settle** data flows. |
| **System design?** | **Client → keeper/user matcher → on-chain FHE contract**; trust boundaries for wallet, chain, keeper, and selective disclosure. See [System design](#system-design). |
| **Best architecture?** | **Encrypted state** first, **minimal decryption**, keeper liveness without plaintext order access, batch fairness, and explicit audit requirements. |

---

## License

Specify your license here once you choose one (e.g. MIT, Apache-2.0).

## Connect / credits

- **Fhenix:** [fhenix.io](https://fhenix.io) · [X @fhenix](https://x.com/fhenix)  
- **Buildathon:** see official Telegram and [docs.fhenix.io](https://docs.fhenix.io) for the latest program links.

---

*Built for the encrypted Fhenix ecosystem — privacy as a primitive, not a patch.*
