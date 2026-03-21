import {
    Connection,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { AgentDatabase } from '../db';
import winston from 'winston';
import { TransactionSigner, TransactionIntent, ExecutionResult } from '../wallet/signer';
import { AgentWalletRuntime } from '../wallet/runtime';
import { WalletPolicy } from '../wallet/policy';
import { createAgentLogger } from '../logger';
import { Erc8004Client } from '../integrations/erc8004';

/**
 * Configuration for constructing an agent.
 */
export interface AgentConfig {
    agentId: number;
    name: string;
    signer: TransactionSigner;
    runtime: AgentWalletRuntime;
    connection: Connection;
    db: AgentDatabase;
    intervalMs: number;
    policy: WalletPolicy;
}

/**
 * Abstract base class that all autonomous agents extend.
 * Provides the standard run cycle: check balance → decide intent → execute → log.
 * Agents implement only decideIntent() — the runtime handles everything else.
 */
export abstract class BaseAgent {
    protected readonly agentId: number;
    protected readonly name: string;
    protected readonly signer: TransactionSigner;
    protected readonly runtime: AgentWalletRuntime;
    protected readonly connection: Connection;
    protected readonly db: AgentDatabase;
    protected readonly logger: winston.Logger;
    protected isRunning: boolean;
    protected readonly intervalMs: number;
    private intervalHandle: ReturnType<typeof setInterval> | null = null;
    private cycleInProgress: Promise<void> | null = null;

    /**
     * @param config - Agent configuration including signer, runtime, and policy
     */
    constructor(config: AgentConfig) {
        this.agentId = config.agentId;
        this.name = config.name;
        this.signer = config.signer;
        this.runtime = config.runtime;
        this.connection = config.connection;
        this.db = config.db;
        this.intervalMs = config.intervalMs;
        this.isRunning = false;
        this.logger = createAgentLogger(config.agentId, config.name);
    }

    /**
     * Core decision logic implemented by each agent subclass.
     * Returns a TransactionIntent to execute, or null to idle this cycle.
     *
     * @returns TransactionIntent if action desired, null to skip
     */
    abstract decideIntent(): Promise<TransactionIntent | null>;

    /**
     * Executes one complete agent cycle:
     * 1. Log cycle start
     * 2. Check SOL balance
     * 3. Call decideIntent()
     * 4. Execute intent if returned
     * 5. Log to SQLite
     * 6. Log to Winston
     */
    async runCycle(): Promise<void> {
        const cycleTimestamp = new Date().toISOString();

        this.logger.info(`Cycle started`, {
            event: 'CYCLE_START',
            data: { agentId: this.agentId, name: this.name, timestamp: cycleTimestamp },
        });

        let balanceBefore: number;
        try {
            balanceBefore = await this.getBalance();
        } catch (err) {
            this.logger.error('Failed to fetch balance', {
                event: 'BALANCE_ERROR',
                data: { error: err instanceof Error ? err.message : String(err) },
            });
            return;
        }

        this.logger.info(`Balance: ${balanceBefore.toFixed(6)} SOL`, {
            event: 'BALANCE_CHECKED',
            data: { balance: balanceBefore },
        });

        let intent: TransactionIntent | null;
        try {
            intent = await this.decideIntent();
        } catch (err) {
            this.logger.error('decideIntent() threw an error', {
                event: 'INTENT_ERROR',
                data: { error: err instanceof Error ? err.message : String(err) },
            });
            return;
        }

        if (!intent) {
            this.logger.info('Agent chose to idle this cycle', {
                event: 'INTENT_IDLE',
                data: { balance: balanceBefore },
            });

            this.db.insertAction({
                agent_id: this.agentId,
                agent_name: this.name,
                cycle_timestamp: cycleTimestamp,
                intent_type: null,
                intent_details: null,
                action_taken: 0,
                tx_signature: null,
                tx_success: null,
                error_message: null,
                sol_amount: null,
                balance_before: balanceBefore,
                balance_after: balanceBefore,
            });
            return;
        }

        this.logger.info('Intent decided', {
            event: 'INTENT_DECIDED',
            data: { type: intent.type, toAddress: intent.toAddress, amountSol: intent.amountSol },
        });

        const result: ExecutionResult = await this.signer.executeIntent(intent, this.agentId);

        let balanceAfter: number;
        try {
            balanceAfter = await this.getBalance();
        } catch {
            balanceAfter = balanceBefore;
        }

        this.db.insertAction({
            agent_id: this.agentId,
            agent_name: this.name,
            cycle_timestamp: cycleTimestamp,
            intent_type: intent.type,
            intent_details: JSON.stringify(intent),
            action_taken: 1,
            tx_signature: result.signature || null,
            tx_success: result.success ? 1 : 0,
            error_message: result.error || result.policyViolation || null,
            sol_amount: intent.amountSol || null,
            balance_before: balanceBefore,
            balance_after: balanceAfter,
        });

        if (result.success) {
            // Trigger ERC-8004 Receipt across EVM network
            try {
                const evmWallet = this.runtime.deriveEvmWallet(this.agentId);
                const ercClient = new Erc8004Client(evmWallet);
                
                // Fire and forget cross-chain receipt so we don't block the Solana loop
                ercClient.recordReceipt(this.agentId, intent.type, JSON.stringify({
                    solanaTx: result.signature,
                    amount: intent.amountSol,
                    timestamp: cycleTimestamp
                })).catch(e => {
                    this.logger.error('Background ERC-8004 receipt failed', { 
                        event: 'ERC8004_BACKGROUND_ERROR',
                        data: { error: e.message } 
                    });
                });
            } catch (err) {
                this.logger.error('Failed to initialize EVM wallet for receipt', { 
                    event: 'EVM_INIT_ERROR',
                    data: { error: err instanceof Error ? err.message : String(err) } 
                });
            }

            this.logger.info('Transaction confirmed', {
                event: 'TX_CONFIRMED',
                data: {
                    signature: result.signature,
                    explorerUrl: result.explorerUrl,
                    amountSol: intent.amountSol,
                    balanceBefore,
                    balanceAfter,
                    retriesUsed: result.retriesUsed,
                },
            });
        } else {
            this.logger.warn('Transaction failed', {
                event: 'TX_FAILED',
                data: {
                    error: result.error,
                    policyViolation: result.policyViolation,
                    simulationLogs: result.simulationLogs,
                },
            });
        }
    }

    /**
     * Starts the agent's run loop at the configured interval.
     */
    async start(): Promise<void> {
        this.isRunning = true;

        this.logger.info(`Agent started (interval: ${this.intervalMs}ms)`, {
            event: 'AGENT_STARTED',
            data: { intervalMs: this.intervalMs },
        });

        // Run first cycle immediately
        this.cycleInProgress = this.runCycle();
        await this.cycleInProgress;
        this.cycleInProgress = null;

        this.intervalHandle = setInterval(async () => {
            if (this.isRunning) {
                try {
                    this.cycleInProgress = this.runCycle();
                    await this.cycleInProgress;
                } catch (err) {
                    this.logger.error('Cycle crashed unexpectedly', {
                        event: 'CYCLE_CRASH',
                        data: { error: err instanceof Error ? err.message : String(err) },
                    });
                } finally {
                    this.cycleInProgress = null;
                }
            }
        }, this.intervalMs);
    }

    /**
     * Stops the agent gracefully: clears the interval, then waits for any
     * in-flight cycle to complete before returning.
     */
    async stop(): Promise<void> {
        this.isRunning = false;

        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }

        // Wait for in-flight cycle to drain
        if (this.cycleInProgress) {
            this.logger.info('Waiting for in-flight cycle to complete...', {
                event: 'AGENT_DRAINING',
                data: { agentId: this.agentId },
            });
            try {
                await this.cycleInProgress;
            } catch {
                // Swallow — already logged in the cycle
            }
        }

        this.logger.info('Agent stopped', {
            event: 'AGENT_STOPPED',
            data: { agentId: this.agentId, name: this.name },
        });
    }

    /**
     * Returns the SOL balance for this agent's derived wallet.
     *
     * @returns SOL balance as a floating-point number
     */
    async getBalance(): Promise<number> {
        const publicKey = this.runtime.deriveAgentKeypair(this.agentId).publicKey;
        const lamports = await this.connection.getBalance(publicKey);
        return lamports / LAMPORTS_PER_SOL;
    }

    /**
     * Returns the agent's public key as a base58 string.
     *
     * @returns Base58 public key
     */
    getPublicKey(): string {
        return this.runtime.getPublicKey(this.agentId);
    }

    /**
     * Returns whether the agent is currently running.
     *
     * @returns true if running
     */
    getIsRunning(): boolean {
        return this.isRunning;
    }

    /**
     * Returns the agent's name.
     *
     * @returns Agent name string
     */
    getName(): string {
        return this.name;
    }

    /**
     * Returns the agent's ID.
     *
     * @returns Numeric agent ID
     */
    getAgentId(): number {
        return this.agentId;
    }
}
