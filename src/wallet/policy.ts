import { Transaction } from '@solana/web3.js';
import { AgentDatabase } from '../db';

/**
 * Custom error for policy violations.
 */
export class PolicyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PolicyError';
    }
}

/**
 * Defines spending and execution constraints for an agent's wallet.
 */
export interface WalletPolicy {
    agentId: number;
    /** Maximum SOL allowed per single transaction */
    maxSolPerTransaction: number;
    /** Rolling 24-hour spending limit in SOL */
    maxDailySpendSol: number;
    /** Allowed program IDs (whitelist). Empty array = allow all */
    allowedProgramIds: string[];
    /** Whether transaction simulation must pass before signing */
    requireSimulationPass: boolean;
    /** Maximum retry attempts for failed transactions */
    maxRetries: number;
}

/**
 * Result of a policy validation check.
 */
export interface ValidationResult {
    allowed: boolean;
    reason: string;
}

/**
 * Conservative spending policy: 0.01 SOL/tx, 0.1 SOL/day.
 *
 * @param agentId - The agent to apply this policy to
 * @returns WalletPolicy configured for conservative spending
 */
export function CONSERVATIVE_POLICY(agentId: number): WalletPolicy {
    return {
        agentId,
        maxSolPerTransaction: 0.01,
        maxDailySpendSol: 0.1,
        allowedProgramIds: [],
        requireSimulationPass: true,
        maxRetries: 3,
    };
}

/**
 * Standard spending policy: 0.05 SOL/tx, 0.5 SOL/day.
 *
 * @param agentId - The agent to apply this policy to
 * @returns WalletPolicy configured for standard spending
 */
export function STANDARD_POLICY(agentId: number): WalletPolicy {
    return {
        agentId,
        maxSolPerTransaction: 0.05,
        maxDailySpendSol: 0.5,
        allowedProgramIds: [],
        requireSimulationPass: true,
        maxRetries: 3,
    };
}

/**
 * Aggressive spending policy: 0.1 SOL/tx, 1.0 SOL/day.
 *
 * @param agentId - The agent to apply this policy to
 * @returns WalletPolicy configured for aggressive spending
 */
export function AGGRESSIVE_POLICY(agentId: number): WalletPolicy {
    return {
        agentId,
        maxSolPerTransaction: 0.1,
        maxDailySpendSol: 1.0,
        allowedProgramIds: [],
        requireSimulationPass: true,
        maxRetries: 3,
    };
}

/**
 * Enforces transaction policies for an agent's wallet.
 * Checks per-transaction limits, rolling 24h spend, and program whitelists.
 */
export class PolicyEngine {
    private readonly policy: WalletPolicy;
    private readonly db: AgentDatabase;

    /**
     * Creates a PolicyEngine with the given policy and database reference.
     *
     * @param policy - The wallet policy to enforce
     * @param db - AgentDatabase for spend tracking
     */
    constructor(policy: WalletPolicy, db: AgentDatabase) {
        this.policy = policy;
        this.db = db;
    }

    /**
     * Returns the policy this engine enforces.
     *
     * @returns The WalletPolicy instance
     */
    getPolicy(): WalletPolicy {
        return this.policy;
    }

    /**
     * Validates a proposed transaction against the agent's spending policy.
     *
     * @param tx - The Solana Transaction to validate
     * @param estimatedSol - Estimated SOL cost of the transaction
     * @returns ValidationResult with allowed status and reason
     */
    validate(tx: Transaction, estimatedSol: number): ValidationResult {
        // Check per-transaction limit
        if (estimatedSol > this.policy.maxSolPerTransaction) {
            return {
                allowed: false,
                reason: `Transaction amount ${estimatedSol.toFixed(6)} SOL exceeds per-tx limit of ${this.policy.maxSolPerTransaction} SOL`,
            };
        }

        // Check rolling 24h spend from DB
        const dailySpend = this.db.getDailySpend(this.policy.agentId);
        if (dailySpend + estimatedSol > this.policy.maxDailySpendSol) {
            return {
                allowed: false,
                reason: `Daily spend ${(dailySpend + estimatedSol).toFixed(6)} SOL would exceed 24h limit of ${this.policy.maxDailySpendSol} SOL (already spent: ${dailySpend.toFixed(6)} SOL)`,
            };
        }

        // Check program whitelist if non-empty
        if (this.policy.allowedProgramIds.length > 0) {
            for (const instruction of tx.instructions) {
                const programId = instruction.programId.toBase58();
                if (!this.policy.allowedProgramIds.includes(programId)) {
                    return {
                        allowed: false,
                        reason: `Program ${programId} is not in the allowed whitelist: [${this.policy.allowedProgramIds.join(', ')}]`,
                    };
                }
            }
        }

        return {
            allowed: true,
            reason: 'Transaction passes all policy checks',
        };
    }

    /**
     * Records a confirmed spend in the database for daily spend tracking.
     *
     * @param agentId - The agent that made the spend
     * @param amountSol - Amount spent in SOL
     * @param txSignature - Transaction signature for the confirmed spend
     */
    recordSpend(agentId: number, amountSol: number, txSignature: string): void {
        this.db.insertSpend({
            agent_id: agentId,
            timestamp: new Date().toISOString(),
            amount_sol: amountSol,
            tx_signature: txSignature,
        });
    }

    /**
     * Gets the rolling 24-hour spend total for an agent.
     *
     * @param agentId - The agent to query
     * @returns Total SOL spent in the last 24 hours
     */
    getDailySpend(agentId: number): number {
        return this.db.getDailySpend(agentId);
    }
}
