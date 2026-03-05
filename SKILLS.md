# SKILLS.md — Agent Wallet Runtime Capability Manifest

version: 2.0.0
network: solana-devnet
runtime: agent-wallet-runtime

## CAPABILITY: wallet.derive

Description: Derives a deterministic wallet keypair for a given agent ID using BIP44 HD path.
Inputs:
  - agentId: number (0–4294967295)
  - mnemonic: string (BIP39, loaded from encrypted keystore)
Outputs:
  - publicKey: string (base58 Solana address)
  - derivationPath: string
Side Effects: None. Derivation is deterministic and stateless.
Security: Private key never leaves runtime memory. No serialization.

## CAPABILITY: wallet.executeIntent

Description: Validates, simulates, signs, and broadcasts a transaction from a structured intent.
Inputs:
  - intent: TransactionIntent { type, toAddress?, amountSol?, mintAddress?, amountTokens?, decimals?, programId?, instructionData?, memo?, inputMint?, outputMint?, slippageBps? }
  - agentId: number
Outputs:
  - ExecutionResult { success, signature?, slot?, fee?, error?, simulationLogs?, policyViolation?, explorerUrl?, retriesUsed? }
Supported Intent Types:
  - TRANSFER_SOL: Native SOL transfers via System Program
  - TRANSFER_SPL: SPL token transfers with automatic ATA derivation and idempotent account creation
  - PROGRAM_CALL: Arbitrary on-chain program calls (e.g., Memo Program at MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr)
  - SWAP_TOKEN: Token swaps via Jupiter DEX aggregator (v6 API). Supports VersionedTransaction (v0 + ALTs).
Guarantees:
  - Policy check runs before signing (cannot be bypassed)
  - Simulation runs before signing (cannot be bypassed)
  - Retry with exponential backoff on transient failures (max 3 attempts)
  - All executions logged to SQLite

## CAPABILITY: wallet.getBalance

Description: Returns current SOL balance for an agent's wallet on devnet.
Inputs: { agentId: number }
Outputs: { sol: number, lamports: number, publicKey: string }

## CAPABILITY: wallet.getTokenBalance

Description: Returns SPL token balance for an agent's wallet given a mint address.
Inputs: { agentId: number, mintAddress: string }
Outputs: { amount: number (raw smallest units) }
Notes: Returns 0 if ATA does not exist.

## CAPABILITY: wallet.getOrCreateATA

Description: Derives and optionally creates an Associated Token Account for an agent + SPL mint pair.
Inputs: { agentId: number, mintAddress: string }
Outputs: { ataAddress: string }
Side Effects: If the ATA does not exist, creates it on-chain (costs ~0.002 SOL rent).

## CAPABILITY: wallet.airdrop

Description: Requests devnet SOL airdrop for a given agent. Retries with backoff.
Inputs: { agentId: number, amountSol: number (max 2.0) }
Outputs: { success: boolean, signature?: string, error?: string }

## CAPABILITY: policy.validate

Description: Checks a proposed transaction against an agent's wallet policy before execution.
Inputs: { agentId: number, estimatedAmountSol: number, programId?: string }
Outputs: { allowed: boolean, reason: string }

## CAPABILITY: db.getHistory

Description: Returns logged action history for a specific agent.
Inputs: { agentId: number, limit: number }
Outputs: Array of AgentAction records with full intent, result, and balance data

## CAPABILITY: db.getRecentPerformance

Description: Returns adaptive strategy metrics from recent transaction history.
Inputs: { agentId: number, windowSize: number }
Outputs: { successRate: number, totalActions: number, avgAmount: number, maxAmount: number, balanceTrend: 'rising' | 'falling' | 'stable' }
Used by: ALPHA (momentum regime), BETA (trend detection), GAMMA (need scoring)

## CAPABILITY: db.getSummaryStats

Description: Returns aggregate statistics across all agents.
Outputs: { totalTxs, successRate, totalSolMoved, agentBreakdown[] }

## AGENT REGISTRY

Agent 0: ALPHA — Momentum Market Maker (derivation: m/44'/501'/0'/0')
  Strategy: Adjusts send probability (25-95%) and amounts based on success rate from DB.
  Hot regime (≥70% success): aggressive. Cold regime (≤30%): conservative.

Agent 1: BETA  — Smart Accumulator + Jupiter Trader (derivation: m/44'/501'/1'/0')
  Strategy: Tracks balance baseline. Forwards 20% of excess on rising trend.
  Every 5th active cycle: swaps 0.01 SOL → USDC via Jupiter DEX (SWAP_TOKEN intent).

Agent 2: GAMMA — Need-Score Rebalancer (derivation: m/44'/501'/2'/0')
  Strategy: Calculates need scores for all agents. Funds neediest proportionally.

## SECURITY CONSTRAINTS

- Master seed stored encrypted (AES-256-GCM, PBKDF2 key derivation)
- Private keys held in memory only, never written to disk or logs
- All transactions simulated before signing
- Per-agent spend limits enforced at runtime, cannot be overridden by agent logic
- Agents interact through intents only — no direct signing access
- Retry with exponential backoff on transient network failures
- Graceful shutdown ensures in-progress cycles complete before exit

## PROTOCOL INTERACTIONS

- System Program: Native SOL transfers (TRANSFER_SOL)
- SPL Token Program: Token transfers with ATA management (TRANSFER_SPL)
- Memo Program: On-chain structured logging (PROGRAM_CALL)
- Jupiter v6 API: DEX aggregated swaps across Raydium, Orca, Meteora, Phoenix (SWAP_TOKEN)
- Custom programs: Supported via PROGRAM_CALL with custom instructionData

## CAPABILITY: wallet.swapToken

Description: Swaps tokens via Jupiter DEX aggregator. Agent specifies inputMint, outputMint, and amount — the runtime fetches the best route, builds a VersionedTransaction, simulates, signs, and broadcasts.
Inputs:
  - inputMint: string (token mint address, defaults to wrapped SOL)
  - outputMint: string (target token mint address, e.g. USDC)
  - amountLamports: number (amount in smallest units)
  - slippageBps: number (max slippage in basis points, e.g. 50 = 0.5%)
Outputs:
  - ExecutionResult (same as wallet.executeIntent)
API Calls:
  - GET https://quote-api.jup.ag/v6/quote (route discovery)
  - POST https://quote-api.jup.ag/v6/swap (transaction assembly)
Security:
  - Only userPublicKey is sent to Jupiter API — private key never leaves runtime
  - Full simulation runs on the assembled VersionedTransaction before signing
  - Policy engine validates the SOL value against per-tx and daily limits
Limitations:
  - Devnet has sparse liquidity — swaps may fail with "no route" on devnet
  - Mainnet-ready: identical code path, just needs funded mainnet wallet + RPC endpoint
