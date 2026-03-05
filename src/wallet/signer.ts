import {
    Connection,
    Transaction,
    VersionedTransaction,
    TransactionInstruction,
    SystemProgram,
    PublicKey,
    LAMPORTS_PER_SOL,
    sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
    getAssociatedTokenAddress,
    createAssociatedTokenAccountIdempotentInstruction,
    createTransferInstruction,
} from '@solana/spl-token';
import { getQuote, buildSwapTransaction, swapSummary } from '../integrations/jupiter';
import { AgentWalletRuntime } from './runtime';
import { PolicyEngine, ValidationResult } from './policy';
import { AgentDatabase } from '../db';
import { createAgentLogger } from '../logger';

/**
 * Custom error for simulation failures.
 */
export class SimulationError extends Error {
    public readonly logs: string[];
    constructor(message: string, logs: string[] = []) {
        super(message);
        this.name = 'SimulationError';
        this.logs = logs;
    }
}

/**
 * Custom error for network/RPC failures.
 */
export class NetworkError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NetworkError';
    }
}

/**
 * Describes an agent's desired transaction without touching keys.
 */
export interface TransactionIntent {
    type: 'TRANSFER_SOL' | 'TRANSFER_SPL' | 'PROGRAM_CALL' | 'SWAP_TOKEN';
    toAddress?: string;
    amountSol?: number;
    amountLamports?: number;
    programId?: string;
    instructionData?: Buffer;
    memo?: string;
    /** SPL token mint address (required for TRANSFER_SPL) */
    mintAddress?: string;
    /** Raw token amount in smallest units (required for TRANSFER_SPL) */
    amountTokens?: number;
    /** Token decimals for display purposes */
    decimals?: number;
    // SWAP_TOKEN fields (Jupiter DEX)
    /** Input token mint — defaults to wrapped SOL */
    inputMint?: string;
    /** Output token mint — e.g. USDC */
    outputMint?: string;
    /** Max slippage in basis points (50 = 0.5%). Default: 50 */
    slippageBps?: number;
}

/**
 * Result of executing a transaction intent.
 */
export interface ExecutionResult {
    success: boolean;
    signature?: string;
    slot?: number;
    fee?: number;
    error?: string;
    simulationLogs?: string[];
    policyViolation?: string;
    explorerUrl?: string;
    retriesUsed?: number;
}

const DEVNET_EXPLORER = 'https://explorer.solana.com/tx';

/**
 * Returns a Solana Explorer URL for a given transaction signature.
 */
function explorerUrl(signature: string): string {
    return `${DEVNET_EXPLORER}/${signature}?cluster=devnet`;
}

/**
 * Signs, simulates, and broadcasts transactions for AI agents.
 * Enforces the mandatory 10-step execution flow:
 * build → blockhash → feePayer → policy → simulate → sign → send → record → log → return
 *
 * Steps 5-7 (simulate → sign → send) are wrapped in a retry loop with exponential backoff.
 */
export class TransactionSigner {
    private readonly runtime: AgentWalletRuntime;
    private readonly connection: Connection;
    private readonly policyEngines: Map<number, PolicyEngine> = new Map();
    private readonly db: AgentDatabase;

    constructor(runtime: AgentWalletRuntime, connection: Connection, db: AgentDatabase) {
        this.runtime = runtime;
        this.connection = connection;
        this.db = db;
    }

    /**
     * Registers a policy engine for a specific agent.
     */
    registerPolicy(agentId: number, engine: PolicyEngine): void {
        this.policyEngines.set(agentId, engine);
    }

    /**
     * Executes a transaction intent through the mandatory 10-step pipeline.
     * Steps 5-7 (simulate → sign → send) retry up to policy.maxRetries on transient failures.
     */
    async executeIntent(intent: TransactionIntent, agentId: number): Promise<ExecutionResult> {
        const agentLogger = createAgentLogger(agentId, `AGENT_${agentId}`);

        try {
            // Step 1: Build the Transaction object from intent fields
            const transaction = await this.buildTransaction(intent, agentId);

            agentLogger.info('Transaction built from intent', {
                event: 'TX_BUILT',
                data: { intentType: intent.type, toAddress: intent.toAddress, amountSol: intent.amountSol },
            });

            // Step 3: Get agent's keypair (for feePayer and signing)
            const keypair = this.runtime.deriveAgentKeypair(agentId);

            // Step 4: Policy validation — MANDATORY, cannot be bypassed
            const estimatedSol = intent.amountSol || (intent.amountLamports ? intent.amountLamports / LAMPORTS_PER_SOL : 0);
            const policyEngine = this.policyEngines.get(agentId);

            if (!policyEngine) {
                return {
                    success: false,
                    error: `No policy engine registered for agent ${agentId}`,
                    policyViolation: 'MISSING_POLICY',
                };
            }

            // We need a blockhash for legacy transactions. Jupiter's VersionedTransaction
            // already has blockhash embedded by the API.
            const isVersioned = transaction instanceof VersionedTransaction;

            if (!isVersioned) {
                const tempBlockhash = await this.connection.getLatestBlockhash('confirmed');
                (transaction as Transaction).recentBlockhash = tempBlockhash.blockhash;
                (transaction as Transaction).lastValidBlockHeight = tempBlockhash.lastValidBlockHeight;
                (transaction as Transaction).feePayer = keypair.publicKey;
            }

            const validation: ValidationResult = policyEngine.validate(
                isVersioned ? {} as Transaction : transaction as Transaction,
                estimatedSol
            );
            if (!validation.allowed) {
                agentLogger.warn('Transaction rejected by policy', {
                    event: 'POLICY_REJECTED',
                    data: { reason: validation.reason, estimatedSol },
                });
                return {
                    success: false,
                    policyViolation: validation.reason,
                };
            }

            agentLogger.info('Policy check passed', {
                event: 'POLICY_PASSED',
                data: { estimatedSol },
            });

            // Steps 5-7: Simulate → Sign → Send  (with retry loop)
            const maxRetries = policyEngine.getPolicy().maxRetries;
            let lastError: string = '';
            let lastSimLogs: string[] = [];

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    // Step 2 (re-fetch): Get fresh blockhash for legacy transactions
                    if (!isVersioned) {
                        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
                        (transaction as Transaction).recentBlockhash = blockhash;
                        (transaction as Transaction).lastValidBlockHeight = lastValidBlockHeight;
                        (transaction as Transaction).feePayer = keypair.publicKey;
                    }

                    if (attempt > 0) {
                        agentLogger.info(`Retry attempt ${attempt}/${maxRetries}`, {
                            event: 'TX_RETRY',
                            data: { attempt, maxRetries, lastError },
                        });
                    }

                    // Step 5: Simulate — MANDATORY
                    let simulationPassed: boolean;
                    let simulationLogs: string[];

                    if (isVersioned) {
                        const simResult = await this.connection.simulateTransaction(transaction as VersionedTransaction);
                        simulationPassed = simResult.value.err === null;
                        simulationLogs = simResult.value.logs || [];
                    } else {
                        const simResult = await this.connection.simulateTransaction(transaction as Transaction);
                        simulationPassed = simResult.value.err === null;
                        simulationLogs = simResult.value.logs || [];
                    }

                    this.db.insertSimulation({
                        agent_id: agentId,
                        timestamp: new Date().toISOString(),
                        passed: simulationPassed ? 1 : 0,
                        logs: JSON.stringify(simulationLogs),
                    });

                    if (!simulationPassed) {
                        lastError = `Simulation failed: ${JSON.stringify(simulationLogs)}`;
                        lastSimLogs = simulationLogs;
                        agentLogger.warn(`Simulation failed (attempt ${attempt + 1}/${maxRetries + 1})`, {
                            event: 'SIMULATION_FAILED',
                            data: { logs: simulationLogs, attempt },
                        });

                        // Don't retry simulation failures — they're deterministic
                        return {
                            success: false,
                            error: lastError,
                            simulationLogs,
                        };
                    }

                    agentLogger.info('Simulation passed', {
                        event: 'TX_SIMULATED',
                        data: { logsCount: simulationLogs.length },
                    });

                    // Step 6 + 7: Sign and send
                    let signature: string;
                    if (isVersioned) {
                        // VersionedTransaction: Jupiter pre-built tx, just add our partial signature
                        (transaction as VersionedTransaction).sign([keypair]);
                        const raw = (transaction as VersionedTransaction).serialize();
                        signature = await this.connection.sendRawTransaction(raw, { skipPreflight: true });
                        await this.connection.confirmTransaction(signature, 'confirmed');
                    } else {
                        signature = await sendAndConfirmTransaction(
                            this.connection,
                            transaction as Transaction,
                            [keypair],
                            { commitment: 'confirmed' }
                        );
                    }

                    // Step 8: Record spend in PolicyEngine
                    policyEngine.recordSpend(agentId, estimatedSol, signature);

                    const url = explorerUrl(signature);

                    // Step 9: Log full result
                    agentLogger.info('Transaction confirmed on-chain', {
                        event: 'TX_CONFIRMED',
                        data: {
                            signature,
                            explorerUrl: url,
                            amountSol: estimatedSol,
                            intentType: intent.type,
                            toAddress: intent.toAddress,
                            retriesUsed: attempt,
                        },
                    });

                    // Step 10: Return ExecutionResult
                    return {
                        success: true,
                        signature,
                        explorerUrl: url,
                        fee: 5000 / LAMPORTS_PER_SOL,
                        retriesUsed: attempt,
                    };
                } catch (err) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    lastError = errorMessage;

                    // Retry on transient network errors, not on deterministic failures
                    const isTransient =
                        errorMessage.includes('blockhash') ||
                        errorMessage.includes('timeout') ||
                        errorMessage.includes('429') ||
                        errorMessage.includes('fetch') ||
                        errorMessage.includes('ECONNRESET') ||
                        errorMessage.includes('socket');

                    if (!isTransient || attempt >= maxRetries) {
                        agentLogger.error(`Transaction failed after ${attempt + 1} attempt(s)`, {
                            event: 'TX_FAILED',
                            data: { error: errorMessage, intentType: intent.type, attempt, maxRetries },
                        });

                        return {
                            success: false,
                            error: errorMessage,
                            simulationLogs: lastSimLogs.length > 0 ? lastSimLogs : undefined,
                            retriesUsed: attempt,
                        };
                    }

                    // Exponential backoff: 500ms, 1000ms, 2000ms, ...
                    const backoffMs = 500 * Math.pow(2, attempt);
                    agentLogger.warn(`Transient error, retrying in ${backoffMs}ms`, {
                        event: 'TX_RETRY_BACKOFF',
                        data: { error: errorMessage, attempt, backoffMs },
                    });

                    await new Promise((resolve) => setTimeout(resolve, backoffMs));
                }
            }

            // Should never reach here, but safety net
            return {
                success: false,
                error: lastError || 'Max retries exhausted',
                retriesUsed: maxRetries,
            };
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);

            agentLogger.error('Transaction execution failed (pre-retry)', {
                event: 'TX_FAILED',
                data: { error: errorMessage, intentType: intent.type },
            });

            return {
                success: false,
                error: errorMessage,
            };
        }
    }

    /**
     * Builds a Solana Transaction object from a structured intent.
     * Returns either a legacy Transaction or a VersionedTransaction (from Jupiter).
     */
    private async buildTransaction(intent: TransactionIntent, agentId: number): Promise<Transaction | VersionedTransaction> {
        const senderPubkey = this.runtime.deriveAgentKeypair(agentId).publicKey;

        // For Jupiter swaps we may return early with a VersionedTransaction
        const transaction = new Transaction();

        switch (intent.type) {
            case 'TRANSFER_SOL': {
                if (!intent.toAddress) {
                    throw new NetworkError('TRANSFER_SOL intent requires a toAddress');
                }

                const lamports = intent.amountLamports
                    || Math.round((intent.amountSol || 0) * LAMPORTS_PER_SOL);

                transaction.add(
                    SystemProgram.transfer({
                        fromPubkey: senderPubkey,
                        toPubkey: new PublicKey(intent.toAddress),
                        lamports,
                    })
                );
                break;
            }

            case 'TRANSFER_SPL': {
                if (!intent.toAddress) {
                    throw new NetworkError('TRANSFER_SPL intent requires a toAddress');
                }
                if (!intent.mintAddress) {
                    throw new NetworkError('TRANSFER_SPL intent requires a mintAddress');
                }
                if (!intent.amountTokens || intent.amountTokens <= 0) {
                    throw new NetworkError('TRANSFER_SPL intent requires a positive amountTokens');
                }

                const mint = new PublicKey(intent.mintAddress);
                const recipientPubkey = new PublicKey(intent.toAddress);

                // Derive ATAs for sender and recipient
                const senderATA = await getAssociatedTokenAddress(mint, senderPubkey);
                const recipientATA = await getAssociatedTokenAddress(mint, recipientPubkey);

                // Create recipient ATA if it doesn't exist (idempotent — no-op if already exists)
                transaction.add(
                    createAssociatedTokenAccountIdempotentInstruction(
                        senderPubkey,    // payer
                        recipientATA,    // ATA to create
                        recipientPubkey, // owner of the ATA
                        mint             // token mint
                    )
                );

                // Add the transfer instruction
                transaction.add(
                    createTransferInstruction(
                        senderATA,           // source
                        recipientATA,        // destination
                        senderPubkey,        // authority (owner of source)
                        BigInt(intent.amountTokens)  // amount in smallest units
                    )
                );
                break;
            }

            case 'PROGRAM_CALL': {
                // Default to the Solana Memo Program if no programId specified
                const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
                const targetProgramId = intent.programId || MEMO_PROGRAM_ID;

                const programPubkey = new PublicKey(targetProgramId);

                // Build instruction data: use provided data or encode memo string
                let data: Buffer;
                if (intent.instructionData) {
                    data = intent.instructionData;
                } else if (intent.memo) {
                    // Default: encode memo as UTF-8 for Memo Program compatibility
                    data = Buffer.from(intent.memo, 'utf-8');
                } else {
                    data = Buffer.alloc(0);
                }

                transaction.add(
                    new TransactionInstruction({
                        programId: programPubkey,
                        keys: [
                            { pubkey: senderPubkey, isSigner: true, isWritable: true },
                        ],
                        data,
                    })
                );
                break;
            }

            case 'SWAP_TOKEN': {
                const SOL_MINT = 'So11111111111111111111111111111111111111112';
                const inputMint = intent.inputMint || SOL_MINT;
                const outputMint = intent.outputMint;

                if (!outputMint) {
                    throw new NetworkError('SWAP_TOKEN intent requires an outputMint');
                }

                const amountLamports = intent.amountLamports
                    || Math.round((intent.amountSol || 0) * LAMPORTS_PER_SOL);

                if (amountLamports <= 0) {
                    throw new NetworkError('SWAP_TOKEN intent requires a positive amount');
                }

                createAgentLogger(agentId, `AGENT_${agentId}`).info(
                    `SWAP_TOKEN: fetching Jupiter quote ${amountLamports} lamports ${inputMint.slice(0, 8)}→${outputMint.slice(0, 8)}`,
                    { event: 'JUPITER_QUOTE_REQUEST', data: { inputMint, outputMint, amountLamports } }
                );

                const quote = await getQuote({
                    inputMint,
                    outputMint,
                    amountLamports,
                    slippageBps: intent.slippageBps ?? 50,
                    userPublicKey: senderPubkey.toBase58(),
                });

                createAgentLogger(agentId, `AGENT_${agentId}`).info(
                    `SWAP_TOKEN: Jupiter quote received — ${swapSummary(quote)}`,
                    { event: 'JUPITER_QUOTE_RECEIVED', data: { inAmount: quote.inAmount, outAmount: quote.outAmount } }
                );

                // Jupiter builds and returns the full transaction
                return buildSwapTransaction(quote, senderPubkey.toBase58());
            }

            default:
                throw new NetworkError(`Unknown intent type: ${intent.type}`);
        }

        return transaction;
    }
}
