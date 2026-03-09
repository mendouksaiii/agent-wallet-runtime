import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { BaseAgent, AgentConfig } from './base-agent';
import { TransactionIntent } from '../wallet/signer';

/**
 * VEGA Agent — Proportional Rebalancer
 *
 * Monitors all agents' balances and DB performance metrics to decide
 * who needs funding most. Uses a "need score" based on failure rate
 * and activity level, then transfers proportional to VEGA's own balance.
 *
 * Strategy:
 * - Query performance metrics for ALL agents from DB
 * - Calculate need score for ORION and LYRA: (1 - successRate) × activityLevel
 * - Fund the agent with the highest need score
 * - Transfer amount = vegaBalance × 0.15 × normalized needScore
 * - Self-preservation: never drop below 0.03 SOL
 */
export class VegaAgent extends BaseAgent {
    private readonly orionPublicKey: string;
    private readonly lyraPublicKey: string;

    constructor(config: AgentConfig, orionPublicKey: string, lyraPublicKey: string) {
        super(config);
        this.orionPublicKey = orionPublicKey;
        this.lyraPublicKey = lyraPublicKey;
    }

    async decideIntent(): Promise<TransactionIntent | null> {
        const { PublicKey } = await import('@solana/web3.js');

        // Fetch all 3 balances
        let orionBalance: number;
        let lyraBalance: number;
        let vegaBalance: number;

        try {
            const [orionLamports, lyraLamports, vegaLamports] = await Promise.all([
                this.connection.getBalance(new PublicKey(this.orionPublicKey)),
                this.connection.getBalance(new PublicKey(this.lyraPublicKey)),
                this.getBalance().then((sol) => sol * LAMPORTS_PER_SOL),
            ]);

            orionBalance = orionLamports / LAMPORTS_PER_SOL;
            lyraBalance = lyraLamports / LAMPORTS_PER_SOL;
            vegaBalance = vegaLamports / LAMPORTS_PER_SOL;
        } catch (err) {
            this.logger.error('Failed to fetch balances for rebalancing', {
                event: 'BALANCE_FETCH_ERROR',
                data: { error: err instanceof Error ? err.message : String(err) },
            });
            return null;
        }

        const selfReserve = 0.03;

        // Self-preservation check
        if (vegaBalance <= selfReserve) {
            this.logger.info(
                `VEGA: balance=${vegaBalance.toFixed(6)} SOL ≤ reserve=${selfReserve} — cannot rebalance`,
                {
                    event: 'INTENT_DECIDED',
                    data: { vegaBalance, selfReserve, reason: 'insufficient_reserves' },
                }
            );
            return null;
        }

        // Query performance for ORION (0) and LYRA (1)
        const orionPerf = this.db.getRecentPerformance(0, 10);
        const lyraPerf = this.db.getRecentPerformance(1, 10);

        // Calculate need scores
        // Need = how badly an agent needs help
        // High failure rate + high activity = most need (they're trying but failing)
        // Low activity = less need (they're not trying)
        const orionNeed = this.calculateNeedScore(orionBalance, orionPerf.successRate, orionPerf.totalActions);
        const lyraNeed = this.calculateNeedScore(lyraBalance, lyraPerf.successRate, lyraPerf.totalActions);

        // Log analysis
        this.logger.info(
            `VEGA analysis: ORION(bal=${orionBalance.toFixed(4)}, success=${(orionPerf.successRate * 100).toFixed(0)}%, need=${orionNeed.toFixed(3)}) ` +
            `LYRA(bal=${lyraBalance.toFixed(4)}, success=${(lyraPerf.successRate * 100).toFixed(0)}%, need=${lyraNeed.toFixed(3)}) ` +
            `VEGA=${vegaBalance.toFixed(4)} SOL`,
            {
                event: 'BALANCES_OBSERVED',
                data: {
                    orionBalance, lyraBalance, vegaBalance,
                    orionNeed, lyraNeed,
                    orionSuccessRate: orionPerf.successRate,
                    lyraSuccessRate: lyraPerf.successRate,
                },
            }
        );

        // Nobody needs help if both scores are very low
        if (orionNeed < 0.1 && lyraNeed < 0.1) {
            this.logger.info('VEGA: system healthy, no rebalancing needed', {
                event: 'INTENT_DECIDED',
                data: { orionNeed, lyraNeed, reason: 'system_healthy' },
            });
            return null;
        }

        // Pick the target with the highest need
        const target = orionNeed >= lyraNeed ? 'ORION' : 'LYRA';
        const targetAddress = target === 'ORION' ? this.orionPublicKey : this.lyraPublicKey;
        const targetNeed = target === 'ORION' ? orionNeed : lyraNeed;

        // Transfer amount: proportional to VEGA's available balance and need score
        // Available = vegaBalance - selfReserve
        const available = vegaBalance - selfReserve;
        const rawAmount = available * 0.15 * Math.min(targetNeed, 1.0);

        // Clamp: minimum 0.005, maximum 0.03
        let transferAmount = parseFloat(Math.max(0.005, Math.min(rawAmount, 0.03)).toFixed(6));

        // Final safety check
        if (vegaBalance - transferAmount < selfReserve) {
            transferAmount = parseFloat((vegaBalance - selfReserve).toFixed(6));
        }

        if (transferAmount < 0.002) {
            this.logger.info(`VEGA: computed transfer too small (${transferAmount}), idling`, {
                event: 'INTENT_DECIDED',
                data: { transferAmount, target, targetNeed, reason: 'amount_too_small' },
            });
            return null;
        }

        this.logger.info(
            `VEGA → ${target}: sending ${transferAmount.toFixed(6)} SOL (need=${targetNeed.toFixed(3)}, available=${available.toFixed(4)})`,
            {
                event: 'INTENT_DECIDED',
                data: {
                    target, targetAddress, transferAmount, targetNeed,
                    available, vegaBalance, reason: 'proportional_rebalance',
                },
            }
        );

        return {
            type: 'TRANSFER_SOL',
            toAddress: targetAddress,
            amountSol: transferAmount,
            memo: `VEGA→${target} rebalance need=${targetNeed.toFixed(3)} ${transferAmount} SOL`,
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
