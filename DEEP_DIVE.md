# DEEP_DIVE.md — Architecture & Security Deep Dive

## Overview

The Agent Wallet Runtime is an autonomous wallet infrastructure that lets AI agents hold SOL and SPL tokens, make adaptive transaction decisions, and interact with on-chain programs on Solana devnet. This document explains the architectural design, security model, and production readiness of the system.

### Why HD Derivation Over Random Keypairs

Hierarchical Deterministic (HD) derivation using BIP44 paths (`m/44'/501'/{agentId}'/0'`) provides three critical properties:

1. **Reproducibility**: From a single master mnemonic, all agent keypairs can be regenerated deterministically. No need to backup individual keys — the mnemonic is the single source of truth.

2. **Single Secret Surface**: Only one secret (the mnemonic) needs to be protected, encrypted, and managed. This dramatically reduces the attack surface compared to managing N independent keypairs for N agents.

3. **Auditability**: Given the mnemonic and an agent ID, any auditor can independently derive the same keypair and verify the agent's on-chain history. The derivation path encodes the agent's identity (`/0'/0'` for ALPHA, `/1'/0'` for BETA, etc.).

4. **Infinite Scalability**: Adding a new agent requires no key generation ceremony — just derive path `m/44'/501'/{N}'/0'`. The derivation is pure math, not a network call.

### Why Agent-Wallet Separation of Concerns

The fundamental architectural decision is the **intent boundary**: agent logic is untrusted, signing logic is trusted.

```
┌─────────────────┐    Intent (unsigned)     ┌─────────────────────┐
│   Agent Logic    │ ─────────────────────── │   Wallet Runtime     │
│  (untrusted)     │                         │   (trusted)          │
│                  │    ExecutionResult       │   - Policy Engine    │
│  decideIntent()  │ ◄────────────────────── │   - Simulator        │
│                  │                         │   - Signer           │
└─────────────────┘                          └─────────────────────┘
```

An agent producing bad intents (malicious or buggy) cannot bypass policy checks, skip simulation, or sign without validation. The worst an agent can do is produce intents that get rejected — it can never drain a wallet beyond policy limits.

### Why Simulation-Before-Sign Is Non-Negotiable

Every transaction is simulated on-chain before the runtime signs and broadcasts it. This is enforced architecturally (Steps 4 and 5 in the 10-step pipeline) and cannot be bypassed by any agent.

Simulation catches:
- Insufficient balance to cover the transaction + fees
- Invalid instruction data that would fail on-chain
- Programs that would return errors
- Account ownership violations

Signing an unsimulated transaction is equivalent to writing a blank check — the outcome is unpredictable. In an autonomous system where no human reviews transactions, simulation is the last automated safety net before real funds move.

---

## 2. THREAT MODEL

### Threat 1: Compromised Agent Logic (Buggy or Adversarial Decision-Making)

**Risk**: An agent's `decideIntent()` method contains a bug that returns intents with excessive amounts, wrong recipients, or at runaway frequency.

**Mitigation**:
- **Per-transaction spending cap** in PolicyEngine (`maxSolPerTransaction`) catches single over-spend attempts.
- **Rolling 24-hour cap** (`maxDailySpendSol`) prevents a tight loop from draining funds.
- **Spend tracking in SQLite** ensures the policy engine has accurate spend history even across runtime restarts.
- **Agent interval enforcement** (`intervalMs`) rate-limits how frequently `decideIntent()` is called.

### Threat 2: Private Key Exfiltration

**Risk**: Agent code attempts to read, log, or transmit the private key.

**Mitigation**:
- `AgentWalletRuntime.deriveAgentKeypair()` is the only method that accesses keys, and it returns a `Keypair` object that is used internally by the `TransactionSigner`. While the `Keypair` object is technically accessible, agents don't receive it — they receive a `TransactionSigner` reference that only accepts intents.
- **No getter for secret key bytes** exists on the runtime.
- **Winston logger** is configured to never log key material. The signer logs signatures and public keys only.
- **Keystore encryption** (AES-256-GCM) ensures the mnemonic is never stored in plaintext on disk.

### Threat 3: Replay Attacks

**Risk**: A previously signed transaction is captured and rebroadcast.

**Mitigation**:
- Solana transactions include a **recent blockhash** that expires after ~60 seconds. Replayed transactions with stale blockhashes are rejected by the network.
- The runtime fetches a fresh blockhash for every transaction (Step 2 in the pipeline).

### Threat 4: Simulation Bypass

**Risk**: Attacker modifies the runtime to skip simulation and sign directly.

**Mitigation**:
- The `executeIntent()` method is a single code path with simulation at Step 5. There is no alternative signing method.
- Production hardening would move simulation into an independent service or on-chain program that must be called before signing.

### Threat 5: Excessive Spend from Runaway Agent Loop

**Risk**: An agent enters a tight loop and submits hundreds of intents per minute.

**Mitigation**:
- **Rolling 24h limit** (`maxDailySpendSol`) caps total damage regardless of frequency.
- **Per-transaction limit** ensures each individual transaction is bounded.
- **Interval-based scheduling** in `BaseAgent.start()` prevents faster-than-intended execution.
- **SQLite logging** provides forensic data to identify and diagnose runaway behavior.

### Threat 6: Devnet-to-Mainnet Accidental Broadcast

**Risk**: The runtime connects to mainnet instead of devnet, causing real fund loss.

**Mitigation**:
- Connection URL defaults to `clusterApiUrl('devnet')` — mainnet is never the default.
- Environment variable `SOLANA_NETWORK=devnet` makes the configuration explicit.
- Transaction amounts are calibrated for devnet (0.001–0.05 SOL range) — meaninglessly small on mainnet.
- Production deployment would add an explicit network assertion: read the genesis hash and verify it matches devnet.

---

## 3. COMPONENT BREAKDOWN

| Module | Responsibility | Boundary Rationale |
|--------|---------------|-------------------|
| `wallet/keystore.ts` | Encrypt/decrypt master mnemonic | Isolates cryptographic storage from runtime logic |
| `wallet/runtime.ts` | HD derivation, keypair management, ATA derivation, token balances | Centralizes all key material and token account management |
| `wallet/policy.ts` | Spending limits and validation | Separates security rules from transaction mechanics |
| `wallet/signer.ts` | Build, simulate, sign, broadcast (SOL, SPL, Program calls) | Single controlled signing path — the only code that touches keys for signing |
| `agents/base-agent.ts` | Run cycle abstraction | Standardizes agent lifecycle without coupling to specific strategies |
| `agents/alpha-agent.ts` | Momentum market maker | Adapts send probability and amount from DB success rate |
| `agents/beta-agent.ts` | Smart accumulator | Tracks balance trend, forwards excess proportionally |
| `agents/gamma-agent.ts` | Need-score rebalancer | Queries all agents' performance, funds neediest |
| `simulation/orchestrator.ts` | Multi-agent lifecycle + dashboard | Coordinates startup, shutdown, and live TUI rendering |
| `ui/dashboard.ts` | ANSI terminal dashboard | Zero-dependency real-time TUI with agent cards and tx feed |
| `db/index.ts` | SQLite ledger + performance queries | Persistent audit trail and adaptive strategy data source |
| `logger/index.ts` | Structured logging with dashboard mode | Observability layer — mutes console when TUI is active |
| `cli/index.ts` | User interface | CLI with `--dashboard` flag and password validation |

The key boundary is between **agents/** and **wallet/**: agents produce intents (data), wallet processes intents (with enforcement). This boundary is the security perimeter.

---

## 4. TRANSACTION LIFECYCLE

Complete flow from "agent decides to act" to "transaction confirmed on-chain":

```
Agent.runCycle()
   │
   ├─ 1. Check own SOL balance via connection.getBalance()
   │     └─ FAILURE: Log error, skip cycle, return
   │
   ├─ 2. Call decideIntent() → TransactionIntent | null
   │     ├─ null: Log idle, record to SQLite, return
   │     └─ intent: Continue
   │
   └─ 3. Call signer.executeIntent(intent, agentId)
          │
          ├─ Step 1: Build Transaction from intent fields
          │    └─ FAILURE: NetworkError (missing fields) → return error
          │
          ├─ Step 2: Fetch recent blockhash from connection
          │    └─ FAILURE: RPC timeout → return error
          │
          ├─ Step 3: Set feePayer to agent's public key
          │
          ├─ Step 4: PolicyEngine.validate(tx, estimatedSol)  ← MANDATORY
          │    ├─ REJECTED: Return { policyViolation: reason }
          │    └─ ALLOWED: Continue
          │
          ├─ Step 5: connection.simulateTransaction(tx)  ← MANDATORY
          │    ├─ FAILED: Log simulation logs, insert SimulationRecord, return error
          │    └─ PASSED: Insert SimulationRecord, continue
          │
          ├─ Step 6+7: Sign with keypair + sendAndConfirmTransaction
          │    └─ FAILURE: Network error, timeout → return error
          │
          ├─ Step 8: PolicyEngine.recordSpend(agentId, amount, signature)
          │
          ├─ Step 9: Log full result via Winston
          │
          └─ Step 10: Return ExecutionResult { success: true, signature, ... }
```

At **every failure point**, the system:
1. Logs the failure with context (agentId, intent details, error message)
2. Records the attempt in SQLite (action_taken=1, tx_success=0)
3. Returns a structured `ExecutionResult` with the error — never throws unhandled

---

## 5. SCALABILITY ANALYSIS

### Agent Count Scaling

**Current capacity**: Unlimited agents can be derived (HD derivation supports 2³² agent IDs). In practice:

- **10–50 agents**: Works well with current SQLite + single-process design.
- **50–200 agents**: SQLite write contention becomes the bottleneck. WAL mode helps, but concurrent writers on the same DB will serialize.
- **200+ agents**: Devnet RPC rate limits become the primary constraint. Each agent cycle makes 1–3 RPC calls (getBalance, simulate, send).

### What Breaks First at Scale

1. **Devnet RPC rate limits** (~10 req/s for free tier). At 20 agents with 8s intervals, that's ~7.5 req/s — already close to limits.
2. **SQLite write contention**. Every cycle writes to `agent_actions`, and every successful tx writes to `spend_log`. WAL mode allows concurrent reads but serializes writes.
3. **Single-process memory**. Each derived keypair is cached in memory (~128 bytes each). 1M agents = ~128MB of cached keys — manageable.

### Production Replacements

| Component | Current | Production |
|-----------|---------|------------|
| Database | SQLite (single file) | PostgreSQL with connection pooling |
| Signing | In-process Keypair | HSM (Hardware Security Module) or MPC/TSS |
| Policy | Runtime assertion | On-chain Solana program (immutable policy) |
| RPC | Public devnet endpoint | Dedicated RPC node (Helius, Triton, etc.) |
| Orchestration | Single Node.js process | Kubernetes pods with agent-per-container |
| Logging | Winston → file | ELK stack / Datadog with structured events |

---

## 6. PRODUCTION READINESS GAP

### What This Prototype Doesn't Have

1. **MPC/TSS Signing**: Currently, the master mnemonic exists as a single secret. Multi-Party Computation or Threshold Signature Schemes would distribute key shares across multiple machines.

2. **On-Chain Spending Limits**: Policy enforcement happens at the runtime level (software). A compromised runtime could bypass policies. Production should enforce limits on-chain via a custom Solana program.

3. **Agent Authentication**: Any code with access to the `TransactionSigner` can submit intents as any agent. Production requires agent identity verification (e.g., capability tokens, mutual TLS).

4. **Formal Verification of Policy Engine**: The `PolicyEngine.validate()` function is ~40 lines of TypeScript. For real value at stake, this logic should be formally verified.

5. **Circuit Breakers**: No automatic agent disabling after N consecutive failures.

6. **Transaction Priority Fees**: All transactions use default fee settings. Mainnet congestion requires dynamic priority fee estimation.

7. **Multi-Network Support**: Hardcoded to devnet. Production needs network switching with strict mainnet safeguards.

8. **Monitoring and Alerting**: No health checks, no anomaly detection. An agent silently failing would go unnoticed.

---

## 7. ADAPTIVE AGENT STRATEGIES

All three agents query the SQLite transaction history via `db.getRecentPerformance()` to make data-driven decisions. No random dice rolls.

### ALPHA — Momentum Market Maker

Queries last 10 actions. Success rate ≥ 70% → "hot" regime (85% send probability, balance-scaled amounts). Success rate ≤ 30% → "cold" regime (25% probability, minimum amounts). Streak bonuses/penalties for 3+ consecutive results.

### BETA — Smart Accumulator

Tracks starting balance as baseline. When balance trend is "rising" and excess > 0.01 SOL, forwards 20% of excess to GAMMA. When balance doubles baseline, forwards 30% of overshoot. Holds during stable or falling periods.

### GAMMA — Need-Score Rebalancer

Calculates `needScore = (balanceNeed × 0.6 + failureNeed × 0.4) × activityMultiplier` for ALPHA and BETA. Low balance + high failure rate + high activity = highest need. Funds the neediest agent proportionally to GAMMA's available reserves.

---

## 8. PROTOCOL INTERACTIONS — HOW AGENTS INTERACT WITH ON-CHAIN PROGRAMS

A key requirement for agentic wallets is the ability to interact with on-chain protocols, not just transfer native tokens. The runtime interacts with three distinct Solana programs:

### Program 1: System Program (TRANSFER_SOL)

The baseline — native SOL transfers between agent wallets via `SystemProgram.transfer()`. This is direct value movement without any protocol interaction.

### Program 2: SPL Token Program (TRANSFER_SPL) — Primary Protocol Interaction

This is a **real, multi-step protocol interaction** with the SPL Token Program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) and Associated Token Account Program (`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`). Each `TRANSFER_SPL` intent triggers the following on-chain operations:

**Step 1 — ATA Derivation (off-chain PDA computation)**

The runtime derives the Associated Token Account address for both sender and recipient using program-derived address (PDA) seeds: `[owner_pubkey, TOKEN_PROGRAM_ID, mint_pubkey]`. This is the same derivation every Solana DeFi protocol uses internally.

**Step 2 — Idempotent ATA Creation (on-chain CPI)**

Before transferring tokens, the signer adds a `createAssociatedTokenAccountIdempotentInstruction`. This instruction calls the Associated Token Account Program, which:
- Checks if the ATA already exists
- If not, creates a new token account with correct ownership and mint association
- If yes, is a no-op (costs no rent)

This is a **Cross-Program Invocation (CPI)** — the same pattern used by Jupiter, Raydium, and every DEX on Solana. Our agents are performing the exact same account setup that any DeFi protocol interaction requires.

**Step 3 — Token Transfer (on-chain instruction)**

The `createTransferInstruction` calls the SPL Token Program to move tokens from the sender's ATA to the recipient's ATA. This requires the sender's signature as the token account authority — the same authority model used in lending protocols, AMMs, and token vaults.

**Why this matters**: A `TRANSFER_SPL` intent is not just "send tokens." It's a multi-instruction transaction that interacts with two on-chain programs (Token Program + Associated Token Account Program), performs PDA derivation, handles conditional account creation, and manages token authority — the same building blocks every Solana DeFi protocol is built on.

```
TRANSFER_SPL Transaction (single atomic tx):
  ┌────────────────────────────────────────────────────────────┐
  │ Instruction 1: AssociatedTokenAccount.createIdempotent()   │
  │   → program: ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL│
  │   → creates recipient ATA if needed                       │
  ├────────────────────────────────────────────────────────────┤
  │ Instruction 2: TokenProgram.transfer()                     │
  │   → program: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA  │
  │   → moves tokens from sender ATA to recipient ATA         │
  │   → requires sender signature as authority                 │
  └────────────────────────────────────────────────────────────┘
```

### Program 3: Memo Program (PROGRAM_CALL) — Arbitrary Program Interaction

The `PROGRAM_CALL` intent type demonstrates that agents can call **any on-chain program**, not just token transfers. The default target is the Solana Memo Program (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`), which:
- Accepts arbitrary UTF-8 data as instruction input
- Logs the data on-chain (visible in transaction logs on Explorer)
- Requires the sender's signature (proving agent identity on-chain)

The `PROGRAM_CALL` implementation is generic — it constructs a `TransactionInstruction` with the specified `programId`, the agent as a signer, and either custom `instructionData` or a UTF-8 encoded `memo` string. This can be pointed at any deployed program on Solana.

### The Agent-Protocol Lifecycle

```
Agent.decideIntent()
   │
   ├─ "I have excess tokens" → TRANSFER_SPL { mint, amount, to }
   │    └─ Signer: derive ATAs → create recipient ATA → transfer tokens
   │
   ├─ "I want to log my state" → PROGRAM_CALL { programId: Memo, memo }
   │    └─ Signer: encode memo → call Memo Program → on-chain log
   │
   ├─ "I want to swap tokens" → SWAP_TOKEN { inputMint, outputMint, amount }
   │    └─ Signer: Jupiter quote → VersionedTransaction → sign → broadcast
   │
   └─ "I need to rebalance SOL" → TRANSFER_SOL { amount, to }
        └─ Signer: SystemProgram.transfer → on-chain SOL movement
```

Every one of these paths goes through the same 10-step pipeline: **policy check → simulation → sign → broadcast → record**. The agent decides *what* to do; the runtime decides *whether* to allow it.

---

## 9. JUPITER DEX INTEGRATION

### Why Jupiter

Jupiter is Solana's dominant DEX aggregator — routing through Raydium, Orca, Meteora, Phoenix, and dozens of other liquidity sources to find the best swap rate. Instead of building a custom AMM or integrating a single DEX, agents use Jupiter's v6 API to access all liquidity in one call. This is the same infrastructure used by most Solana wallets and DeFi frontends.

From an agent's perspective, "swap tokens" is a single intent. From the runtime's perspective, it's a multi-program cross-DEX transaction that Jupiter assembles and the runtime signs.

### The 4-Step Swap Pipeline

```
BETA.decideIntent() → { type: 'SWAP_TOKEN', amountLamports: 10_000_000, outputMint: USDC }
        │
        ▼
┌─────────────────────────────────────────────────────┐
│ Step 1: GET /v6/quote                               │
│   inputMint=So1111...  outputMint=EPjFW...  amount=10_000_000
│   slippageBps=100                                   │
│   → Returns best route across all DEXs             │
│   → outAmount: how many USDC tokens returned        │
│   → priceImpactPct: market impact of this size     │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ Step 2: POST /v6/swap                               │
│   quoteResponse + userPublicKey + wrapAndUnwrapSol  │
│   → Returns: swapTransaction (base64)               │
│   → Jupiter builds the entire multi-DEX tx         │
│   → VersionedTransaction format (v0 with ALT)      │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ Step 3: Policy + Simulate (same pipeline)           │
│   → Policy validates against SOL spend limit       │
│   → connection.simulateTransaction(versionedTx)    │
│   → Rejects if simulation fails                    │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ Step 4: Sign + Broadcast                            │
│   versionedTx.sign([agentKeypair])                  │
│   connection.sendRawTransaction(serialized)         │
│   connection.confirmTransaction(sig, 'confirmed')   │
└──────────────────────────────────────────────────────┘
```

### VersionedTransaction vs Legacy Transaction

Jupiter v6 returns `VersionedTransaction` (Solana's v0 transaction format) which supports **Address Lookup Tables (ALTs)**. ALTs compress large account lists, allowing Jupiter's complex multi-DEX routes (which can reference 20+ accounts) to fit within Solana's transaction size limit.

The runtime handles both formats:
- **Legacy `Transaction`** — used by SOL transfer, SPL transfer, Memo: `sendAndConfirmTransaction()`
- **`VersionedTransaction`** — used by Jupiter swaps: `versionedTx.sign([keypair])` → `sendRawTransaction()`

Type-narrowing via `instanceof VersionedTransaction` selects the correct path at runtime.

### Security Properties of SWAP_TOKEN

| Property | Implementation |
|----------|---------------|
| **Policy enforcement** | Swap SOL value validated against `maxSolPerTransaction` |
| **Simulation gate** | `simulateTransaction()` called on the full Jupiter tx before signing |
| **Slippage protection** | `slippageBps` field (default 50 = 0.5%, configurable per agent) |
| **No key exposure** | Agent provides `userPublicKey` to Jupiter API — private key never touches the API |
| **Audit trail** | Swap recorded in SQLite with signature, same as SOL transfers |

### Devnet vs Mainnet

Jupiter devnet has sparse liquidity — most token pairs don't have active market makers on devnet. Swap attempts will fail simulation with "no route" if there's insufficient liquidity for the requested pair.

The implementation is **mainnet-ready**: the architecture, API calls, transaction handling, and signing path are identical. Deploying to mainnet requires:
1. A funded mainnet wallet (replace keystore with mainnet mnemonic)
2. A reliable RPC endpoint (Helius, QuickNode) to avoid rate limits
3. `SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY` in environment

Devnet constraint is documented and expected — this is the honest boundary between "architected for production" and "tested with real liquidity."
