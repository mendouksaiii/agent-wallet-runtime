import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { BaseAgent, AgentConfig } from './base-agent';
import { TransactionIntent } from '../wallet/signer';

/**
 * GAMMA Agent — Proportional Rebalancer
 *
 * Monitors all agents' balances and DB performance metrics to decide
 * who needs funding most. Uses a "need score" based on failure rate
 * and activity level, then transfers proportional to GAMMA's own balance.
 *
 * Strategy:
 * - Query performance metrics for ALL agents from DB
 * - Calculate need score for ALPHA and BETA: (1 - successRate) × activityLevel
 * - Fund the agent with the highest need score
 * - Transfer amount = gammaBalance × 0.15 × normalized needScore
 * - Self-preservation: never drop below 0.03 SOL
 */
export class GammaAgent extends BaseAgent {
    private readonly alphaPublicKey: string;
    private readonly betaPublicKey: string;

    constructor(config: AgentConfig, alphaPublicKey: string, betaPublicKey: string) {
        super(config);
        this.alphaPublicKey = alphaPublicKey;
        this.betaPublicKey = betaPublicKey;
    }

    async decideIntent(): Promise<TransactionIntent | null> {
        const { PublicKey } = await import('@solana/web3.js');

        // Fetch all 3 balances
        let alphaBalance: number;
        let betaBalance: number;
        let gammaBalance: number;

        try {
            const [alphaLamports, betaLamports, gammaLamports] = await Promise.all([
                this.connection.getBalance(new PublicKey(this.alphaPublicKey)),
                this.connection.getBalance(new PublicKey(this.betaPublicKey)),
                this.getBalance().then((sol) => sol * LAMPORTS_PER_SOL),
            ]);

            alphaBalance = alphaLamports / LAMPORTS_PER_SOL;
            betaBalance = betaLamports / LAMPORTS_PER_SOL;
            gammaBalance = gammaLamports / LAMPORTS_PER_SOL;
        } catch (err) {
            this.logger.error('Failed to fetch balances for rebalancing', {
                event: 'BALANCE_FETCH_ERROR',
                data: { error: err instanceof Error ? err.message : String(err) },
            });
            return null;
        }

        const selfReserve = 0.03;

        // Self-preservation check
        if (gammaBalance <= selfReserve) {
            this.logger.info(
                `GAMMA: balance=${gammaBalance.toFixed(6)} SOL ≤ reserve=${selfReserve} — cannot rebalance`,
                {
                    event: 'INTENT_DECIDED',
                    data: { gammaBalance, selfReserve, reason: 'insufficient_reserves' },
                }
            );
            return null;
        }

        // Query performance for ALPHA (0) and BETA (1)
        const alphaPerf = this.db.getRecentPerformance(0, 10);
        const betaPerf = this.db.getRecentPerformance(1, 10);

        // Calculate need scores
        // Need = how badly an agent needs help
        // High failure rate + high activity = most need (they're trying but failing)
        // Low activity = less need (they're not trying)
        const alphaNeed = this.calculateNeedScore(alphaBalance, alphaPerf.successRate, alphaPerf.totalActions);
        const betaNeed = this.calculateNeedScore(betaBalance, betaPerf.successRate, betaPerf.totalActions);

        // Log analysis
        this.logger.info(
            `GAMMA analysis: ALPHA(bal=${alphaBalance.toFixed(4)}, success=${(alphaPerf.successRate * 100).toFixed(0)}%, need=${alphaNeed.toFixed(3)}) ` +
            `BETA(bal=${betaBalance.toFixed(4)}, success=${(betaPerf.successRate * 100).toFixed(0)}%, need=${betaNeed.toFixed(3)}) ` +
            `GAMMA=${gammaBalance.toFixed(4)} SOL`,
            {
                event: 'BALANCES_OBSERVED',
                data: {
                    alphaBalance, betaBalance, gammaBalance,
                    alphaNeed, betaNeed,
                    alphaSuccessRate: alphaPerf.successRate,
                    betaSuccessRate: betaPerf.successRate,
                },
            }
        );

        // Nobody needs help if both scores are very low
        if (alphaNeed < 0.1 && betaNeed < 0.1) {
            this.logger.info('GAMMA: system healthy, no rebalancing needed', {
                event: 'INTENT_DECIDED',
                data: { alphaNeed, betaNeed, reason: 'system_healthy' },
            });
            return null;
        }

        // Pick the target with the highest need
        const target = alphaNeed >= betaNeed ? 'ALPHA' : 'BETA';
        const targetAddress = target === 'ALPHA' ? this.alphaPublicKey : this.betaPublicKey;
        const targetNeed = target === 'ALPHA' ? alphaNeed : betaNeed;

        // Transfer amount: proportional to GAMMA's available balance and need score
        // Available = gammaBalance - selfReserve
        const available = gammaBalance - selfReserve;
        const rawAmount = available * 0.15 * Math.min(targetNeed, 1.0);

        // Clamp: minimum 0.005, maximum 0.03
        let transferAmount = parseFloat(Math.max(0.005, Math.min(rawAmount, 0.03)).toFixed(6));

        // Final safety check
        if (gammaBalance - transferAmount < selfReserve) {
            transferAmount = parseFloat((gammaBalance - selfReserve).toFixed(6));
        }

        if (transferAmount < 0.002) {
            this.logger.info(`GAMMA: computed transfer too small (${transferAmount}), idling`, {
                event: 'INTENT_DECIDED',
                data: { transferAmount, target, targetNeed, reason: 'amount_too_small' },
            });
            return null;
        }

        this.logger.info(
            `GAMMA → ${target}: sending ${transferAmount.toFixed(6)} SOL (need=${targetNeed.toFixed(3)}, available=${available.toFixed(4)})`,
            {
                event: 'INTENT_DECIDED',
                data: {
                    target, targetAddress, transferAmount, targetNeed,
                    available, gammaBalance, reason: 'proportional_rebalance',
                },
            }
        );

        return {
            type: 'TRANSFER_SOL',
            toAddress: targetAddress,
            amountSol: transferAmount,
            memo: `GAMMA→${target} rebalance need=${targetNeed.toFixed(3)} ${transferAmount} SOL`,
        };
    }

    /**
     * Calculates how much an agent needs funding.
     * Factors: low balance → high need, high failure rate → high need, high activity → amplifier.
     *
     * @returns Need score from 0 (healthy) to ~2 (critical)
     */
    private calculateNeedScore(balance: number, successRate: number, totalActions: number): number {
        // Balance component: lower balance = higher need (exponential)
        // At 0.01 SOL → ~1.0, at 0.1 SOL → ~0.3, at 1.0 SOL → ~0.0
        const balanceNeed = Math.max(0, 1.0 - Math.log10(Math.max(balance, 0.001) * 100) / 2);

        // Failure component: higher failure rate = higher need
        const failureNeed = totalActions > 0 ? (1 - successRate) : 0;

        // Activity multiplier: active agents that are failing need help more than idle ones
        const activityMultiplier = totalActions > 0 ? Math.min(totalActions / 5, 1.5) : 0.5;

        return (balanceNeed * 0.6 + failureNeed * 0.4) * activityMultiplier;
    }
}
