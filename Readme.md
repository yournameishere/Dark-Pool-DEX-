# Dark Pool DEX — MEV-Proof Private Exchange

A **sealed-order decentralized exchange** where limit orders live as **FHE-encrypted ciphertexts** on-chain. The matching logic runs on **encrypted state** using [Fhenix](https://fhenix.io) **CoFHE** (Co-processor for FHE). Price and quantity are not readable from the public ledger until a match is finalized—addressing **MEV at the architectural level**, not with another mempool patch.

This repository is being built for the **[Privacy-by-Design dApp Buildathon](https://fhenix.io)** (“Build the Encrypted Fhenix Ecosystem”), which funds teams building **privacy-native** protocols on **Fully Homomorphic Encryption (FHE)** so confidentiality is a **primitive**, not a retrofit.

---

## Wave 4 implementation status

Wave 4 is now implemented as a working Hardhat + React app:

- `DarkPoolDex.sol` stores encrypted price, amount, and side using CoFHE encrypted inputs.
- `tryMatch` computes crossing logic with FHE operations (`gte`, `and`, `not`, `min`, `select`) without exposing resting order data.
- `finalizeMatch` verifies `decryptForTx` threshold signatures for the fill result before moving escrowed ERC-20 balances.
- The React UI connects a wallet, links deployed addresses, approves/deposits escrow, places encrypted orders, prepares matches, decrypts fill handles, and finalizes settlement.
- The test suite covers matched settlement, non-crossing settlement, and cancellation through CoFHE Hardhat mocks.

### Wave 5 production hardening roadmap

Wave 4 proves the encrypted order lifecycle end to end. Wave 5 is where the prototype becomes production-grade:

- **Partial fills and remaining balances** — replace current whole-order fill accounting with encrypted remaining quantity, multiple fills per order, and safe cancellation of partially filled orders.
- **Production keeper / matcher network** — move from manual pair submission to a reliable keeper flow with retrying, monitoring, fair pair selection, and clear liveness guarantees.
- **Batch auctions** — add batch-based matching to reduce timing leakage, improve fairness, and make order ordering less exploitable.
- **Real token support** — replace demo tokens with configured live pairs, token decimal handling, allowance UX, and per-market risk limits.
- **Fees and protocol accounting** — add maker/taker fees, fee withdrawal controls, and transparent fee events that do not reveal private order data.
- **Stronger privacy controls** — reduce metadata leakage, add selective disclosure flows, and tighten permit/decryption policy for users, counterparties, and auditors.
- **Security review** — formal threat model, invariant tests, fuzzing, gas griefing analysis, reentrancy/escrow review, and an external audit before mainnet funds.
- **Production deployment ops** — funded testnet/mainnet deployer, verified contracts, Vercel production env vars, monitoring, runbooks, and incident response.

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
| `npm run deploy:arb-sepolia` | Deploy to Arbitrum Sepolia using `PRIVATE_KEY`. |
| `npm run deploy:vercel` | Deploy the frontend to Vercel production. |
| `npm run export:abi` | Export contract ABIs to the frontend. |

## Deployment

Create a local `.env` file when deploying. Do not commit it.

```bash
PRIVATE_KEY=0x...
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
```

Then run:

```bash
npm run deploy:arb-sepolia
```

The deploy script writes `deployments/<network>.json` and `src/generated/deployment.json`. The frontend also accepts:

```bash
VITE_DARK_POOL_DEX_ADDRESS=0x...
VITE_BASE_TOKEN_ADDRESS=0x...
VITE_QUOTE_TOKEN_ADDRESS=0x...
```

The provided Wave 4 deployment attempt reached Arbitrum Sepolia but could not complete because the deployer account had no test ETH for gas.

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
| **Order storage** | Orders live in contract storage as **encrypted fields** (`euint128`, `ebool`, etc.), tied to owner and expiry. |
| **Matching** | Encrypted checks (e.g. **buy price ≥ sell price**), **fill size** as homomorphic **min** of sizes, **fill price** derived under encryption (e.g. midpoint or taker price—product decision). |
| **Settlement** | When a match is valid, **decrypt** only the **fill** path for token transfers and events—not necessarily every historical order field. |
| **Frontend** | Users use **CoFHE client flows** (encrypt before `placeOrder`, permits/decrypt where the design allows) for a **privacy-aware UX**. |

### What “MEV-proof” means here (honest framing)

- **Architectural**: mempool observers **cannot** read plaintext prices/sizes off the **encrypted** order representation the way they do on a public order book.
- **Wave 1** focuses on **proving the concept** (encrypted orders + match path + settlement demo), not full production **on-chain** matching at scale. Later waves can move matching **on-chain**, add **batch auctions**, and harden **selective disclosure** and **permits**.

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

**How this project helps:** **Wave 1** delivers a **minimal vertical slice**: deploy **encrypted** `placeOrder`, **match** with FHE ops, **settle** with controlled decrypt—exactly the **story** the buildathon rewards.

### Use-case summary

| Use case | Primary pain | What we optimize for |
|----------|----------------|----------------------|
| Retail DeFi | Sandwiches, front-running | Unreadable **order content** pre-fill |
| Pros / MMs | Quote & inventory leakage | **Dark pool**-style **sealed** book |
| Treasuries | Size signaling | **Hidden** size/price **before** match |
| Institutions | Public flow / compliance | **Selective** disclosure path (roadmap) |
| Ecosystem | Composability | **Reusable** encrypted order primitive |
| Buildathon | Demo + narrative | **End-to-end** CoFHE **proof** |

---

## How it works (end-to-end)

### 1. Normal DEX vs this design

**Typical DEX / CLOB on-chain:**  
Order or swap intent is **visible** (or inferable) **before** execution → bots **react**.

**Dark Pool DEX:**  
Orders are **ciphertexts**; **matching** runs on **encrypted state**. Outsiders don’t get plaintext **prices and sizes** for free off the book.

### 2. Smart contract layers (target architecture)

The implementation is organized around **three logical contracts** (names may map to one or more `.sol` files in the repo):

1. **`OrderBook.sol`** — **Encrypted order registry**  
   - Stores `Order` structs with `euint128 price`, `euint128 amount`, `ebool isBuy`, `owner`, `expiry`.  
   - `placeOrder` accepts **client-encrypted** inputs (`inEuint128`, `inEbool`), converts via `FHE.asEuint128` / `FHE.asEbool`, assigns IDs, and sets **FHE permissions** (`allowThis`, `allow` to owner) for later operations.

2. **`MatchingEngine.sol`** — **Encrypted matching**  
   - Takes candidate order pairs (Wave 1 may use a **simple off-chain script** calling `tryMatch` for demos).  
   - Uses **`FHE.gte`**, **`FHE.min`**, **`FHE.select`** so **comparisons and fills** stay **encrypted** until you deliberately decrypt for settlement.  
   - If prices don’t cross, **no meaningful fill**—without revealing either side’s plaintext.

3. **`Settlement.sol`** — **Selective decryption & transfers**  
   - Decrypts **fill price** and **fill amount** (and match flag) when appropriate.  
   - Executes **ERC-20** transfers between counterparties.  
   - Emits events that reflect **fills** (design goal: **not** broadcasting full resting book).

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
| **Verifiability** | Logic runs **on-chain** under Fhenix rules; users do not rely on a **single** off-chain operator for **correctness** of the contract path (Wave 1 may still use a matcher **caller** for pairing). |
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
│  Orchestration (Wave 1 — optional off-chain)                 │
│  Matcher script / keeper / bot                               │
│  · Select (buyId, sellId) pairs (naive loop, scoring, etc.)  │
│  · Call tryMatch(buyId, sellId) on-chain                     │
│  Later: replaced or augmented by on-chain matching / auctions│
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
| **Settlement** | **Decrypt** allowed values for **transfer**; emit **Fill** events; update balances / order remaining (future) | **Matched** fills → **token movements** between owners |
| **Matcher (Wave 1)** | **Off-chain** process that proposes pairs—**does not** need to see plaintext if it only passes **IDs** (it may still see **public** metadata like IDs and timing depending on implementation) | Chain of `tryMatch` calls |

### Data flows

**A. Place order**

1. User enters **price**, **amount**, **side** in the UI.  
2. Client runs **CoFHE encrypt** for each field (correct **FheUType**).  
3. User signs **`placeOrder`**; tx lands on-chain.  
4. Contract stores **ciphertext handles**; **`FHE.allowThis`** / **`FHE.allow`** wire **future** matching and **user** decryption policy.  
5. Observers may still see **that** an order exists depending on what is public (e.g. **order ID**, **owner**, **expiry**)—**minimizing metadata leakage** is a **product/engineering** choice for later iterations.

**B. Match (Wave 1: off-chain caller)**

1. Matcher chooses **`buyId`**, **`sellId`** (e.g. FIFO, random pair for demo, or scoring).  
2. Contract **`tryMatch`**: loads **encrypted** fields, runs **`FHE.gte`**, **`FHE.min`**, **`FHE.select`**, etc.  
3. If not crossing, **fill** path stays **empty/zero** under encryption—**no** need to reveal raw bid/ask.  
4. If crossing, **encrypted** fill price/qty feed **`_settle`**.

**C. Settle**

1. **`_settle`** decrypts **only** what the contract allows for **transfer** (fill price, fill amount, match bit).  
2. **ERC-20** transfers execute **quote** and **base** legs.  
3. **`Fill`** event may expose **executed** price and size (trade-off: **transparency of execution** vs **hiding** even fills—product decision for later versions).

### Trust boundaries

| Zone | Trusted for what |
|------|-------------------|
| **User’s browser / wallet** | Correct **encryption** of user intent; **key safety**; not tampering with client code |
| **Chain + Fhenix CoFHE** | **Correct execution** of contract logic and **FHE** semantics; **finality** of state |
| **Matcher (Wave 1)** | **Liveness** and **pair selection**—which matches get attempted **first**; should **not** be able to **decrypt** orders **unless** given keys (default: matcher only sends **IDs**) |
| **Counterparty** | Sees **fill** outcome and tokens as in any trade—**not** the same as seeing your full **historical** resting book if that stays encrypted |

### Threat and privacy notes (engineering honesty)

- **Metadata:** Even with **encrypted** fields, **timestamps**, **gas patterns**, or **public** **owner** addresses may leak **some** information—mitigations include **batching**, **delayed revelation**, and **minimal** public fields.  
- **Fill transparency:** If **every** fill is **public** on-chain, **post-trade** information still exists; the **main win** is **pre-trade** book **opacity**.  
- **MEV:** **Architectural** hiding of **order content** is the **focus**; **ordering** of txs in the **same** block can still be a topic for **advanced** designs.

### Wave 1 vs later waves (system evolution)

| Aspect | Wave 1 (demo) | Later waves |
|--------|----------------|-------------|
| **Pair selection** | Off-chain script | On-chain loop, **batch auctions**, or **solver** networks |
| **Liquidity** | Thin / test tokens | Real pairs, **fees**, **LP** incentives |
| **UX** | Place + match + fill view | Full **order book** **metadata** strategy, **cancel**, **partial fills** |
| **Security review** | Best-effort | Audits, **formal** threat modeling |

### Design principles (recap)

1. **Minimize decryption surface** — decrypt **fills** and **user-owned** views under **permits**, not the entire book.  
2. **Clear separation** — **storage** (OrderBook) vs **matching** (MatchingEngine) vs **asset movement** (Settlement).  
3. **Wave 1 honesty** — off-chain **pairing** + on-chain **FHE** **truth** for **match/settle** is enough for a **strong** hackathon story.  
4. **Future-proofing** — same **encrypted order** core extends to **auctions** and **institutional** **disclosure** flows.

### Tech stack (reference)

| Layer | Technology |
|-------|--------------|
| **FHE on-chain** | `@fhenixprotocol/cofhe/contracts/FHE.sol`, Solidity encrypted types |
| **Client** | `@cofhe/react` (`useEncrypt`, `useWrite`, `useDecrypt`) |
| **Network (buildathon)** | **Arbitrum Sepolia** (also: Sepolia, Base Sepolia per Fhenix docs) |
| **Tooling** | Hardhat + Fhenix CoFHE plugin for local/dev workflows |

**Official resources:** [Fhenix docs](https://docs.fhenix.io), [CoFHE quick start](https://cofhe-docs.fhenix.zone/fhe-library/introduction/quick-start), [CoFHE architecture overview](https://cofhe-docs.fhenix.zone/deep-dive/cofhe-components/overview), [Awesome Fhenix](https://github.com/FhenixProtocol/awesome-fhenix).

---

## Buildathon alignment (Wavehack / Fhenix Buildathon)

This project fits the buildathon’s **Confidential DeFi** theme:

- **Private positions, sealed-bid style mechanics, MEV-protected execution** — exactly the narrative in the program materials.
- **Privacy-by-design** — confidentiality is **in the architecture** (encrypted order book + FHE matching), not an add-on.

### Wave 1 target (minimal scoring submission)

1. Deploy **`OrderBook.sol`** on **Arbitrum Sepolia** with **encrypted** `placeOrder` working.  
2. A **simple off-chain script** that calls **`tryMatch`** for candidate pairs.  
3. A **minimal React UI**: place order → encrypted submission → show **fill** via permitted decryption.  
4. Documentation (this README) explaining **MEV resistance** and the **market framing** ($500M+ MEV / institutional gap).

### Later waves (roadmap direction)

- **On-chain** matching and **batch auctions**  
- **Real order book UI** (depth, cancellations, better UX)  
- **Hardening**: permissions, griefing, economic and latency constraints

Exact dates and grants follow the **Privacy-by-Design dApp Buildathon** schedule (Wave 1 → Wave 2 → …); see official announcements for current milestones.

---

## Who is this for?

- **Traders** who want **less predictable exploitation** of resting liquidity.  
- **Protocols and institutions** evaluating **confidential DeFi** primitives.  
- **Builders** who want **infrastructure-grade** privacy (encrypted compute on-chain), not a single-feature hack.

---

## Summary

| Question | Answer |
|----------|--------|
| **What is it?** | A **FHE-based dark pool DEX** prototype: encrypted orders, encrypted matching logic, selective decryption at settlement. |
| **What does it do?** | Lets users **place hidden limit orders** and **match/settle** without broadcasting plaintext order book data like a traditional on-chain CLOB. |
| **Why?** | **MEV** and **strategy leakage** on transparent DEXes; **institutional** demand for **confidential** execution. |
| **Who uses it?** | **Retail** (sandwich resistance), **pros/MMs** (less quote leakage), **treasuries** (size not advertised), **institutions** (selective disclosure path), **other protocols** (composable sealed orders). See [Use cases](#use-cases). |
| **How?** | **Fhenix CoFHE** in Solidity + **@cofhe/react** on the client; **place → match → settle** data flows; **OrderBook + MatchingEngine + Settlement** separation. |
| **System design?** | **Client → (optional matcher) → on-chain FHE contracts**; **trust boundaries** for wallet, chain, matcher; **Wave 1** off-chain pairing + on-chain **truth**. See [System design](#system-design). |
| **Best architecture?** | **Encrypted state** first, **minimal decryption**, **modular contracts**, **Wave 1** off-chain matcher → **later** on-chain scaling and auctions. |

---

## License

Specify your license here once you choose one (e.g. MIT, Apache-2.0).

## Connect / credits

- **Fhenix:** [fhenix.io](https://fhenix.io) · [X @fhenix](https://x.com/fhenix)  
- **Buildathon:** see official Telegram and [docs.fhenix.io](https://docs.fhenix.io) for the latest program links.

---

*Built for the encrypted Fhenix ecosystem — privacy as a primitive, not a patch.*
