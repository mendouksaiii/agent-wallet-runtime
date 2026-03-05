import { BaseAgent, AgentConfig } from './base-agent';
import { TransactionIntent } from '../wallet/signer';

/**
 * ALPHA Agent — Momentum Market Maker
 *
 * Adapts transfer probability and amount based on recent performance.
 * Hot streak → send more aggressively. Cold streak → pull back.
 * Amount scales with balance percentage, not fixed range.
 *
 * Strategy:
 * - Query last 10 actions from DB
 * - Success rate ≥ 70%: "hot" → 85% send probability, bigger amounts
 * - Success rate ≤ 30%: "cold" → 40% send probability, minimum amounts
 * - Otherwise: "normal" → 65% probability, moderate amounts
 * - Amount = balance × (baseFactor + successRate × scaleFactor)
 */
export class AlphaAgent extends BaseAgent {
    private readonly betaPublicKey: string;
    private cycleCount: number = 0;

    constructor(config: AgentConfig, betaPublicKey: string) {
        super(config);
        this.betaPublicKey = betaPublicKey;
    }

    async decideIntent(): Promise<TransactionIntent | null> {
        const balance = await this.getBalance();

        // Hard floor — never operate below 0.03 SOL
        if (balance < 0.03) {
            this.logger.info(`ALPHA: balance=${balance.toFixed(6)} SOL — below safety floor, idling`, {
                event: 'INTENT_DECIDED',
                data: { balance, reason: 'safety_floor' },
            });
            return null;
        }

        // Query recent performance from DB
        const perf = this.db.getRecentPerformance(this.agentId, 10);

        // Determine regime
        let regime: 'hot' | 'cold' | 'normal';
        let sendProbability: number;
        let amountFactor: number;

        if (perf.totalActions === 0) {
            // First run — no history, start conservatively
            regime = 'normal';
            sendProbability = 0.65;
            amountFactor = 0.003;
        } else if (perf.successRate >= 0.70) {
            // Hot streak — lean in
            regime = 'hot';
            sendProbability = 0.85;
            amountFactor = 0.002 + perf.successRate * 0.008; // 0.0076–0.01
        } else if (perf.successRate <= 0.30) {
            // Cold streak — pull back
            regime = 'cold';
            sendProbability = 0.40;
            amountFactor = 0.001; // minimum
        } else {
            // Normal — moderate
            regime = 'normal';
            sendProbability = 0.65;
            amountFactor = 0.002 + perf.successRate * 0.006; // 0.002–0.0062
        }

        // Streak bonus: 3+ consecutive successes → bump probability by 10%
        if (perf.consecutiveSuccesses >= 3) {
            sendProbability = Math.min(0.95, sendProbability + 0.10);
        }
        // Streak penalty: 3+ consecutive failures → cut probability by 15%
        if (perf.consecutiveFailures >= 3) {
            sendProbability = Math.max(0.20, sendProbability - 0.15);
        }

        const roll = Math.random();

        if (roll > sendProbability) {
            this.logger.info(
                `ALPHA [${regime}]: roll=${roll.toFixed(3)} > prob=${sendProbability.toFixed(2)} → idling ` +
                `(successRate=${(perf.successRate * 100).toFixed(0)}%, streak: +${perf.consecutiveSuccesses}/-${perf.consecutiveFailures})`,
                {
                    event: 'INTENT_DECIDED',
                    data: { balance, roll, sendProbability, regime, perf, reason: 'probability_idle' },
                }
            );
            return null;
        }

        // Amount: balance × factor, clamped to [0.001, policy max]
        const rawAmount = balance * amountFactor;
        const amountSol = parseFloat(Math.max(0.001, Math.min(rawAmount, 0.01)).toFixed(6));

        this.logger.info(
            `ALPHA [${regime}]: roll=${roll.toFixed(3)} ≤ prob=${sendProbability.toFixed(2)} → sending ${amountSol} SOL to BETA ` +
            `(successRate=${(perf.successRate * 100).toFixed(0)}%, avgAmt=${perf.avgAmount.toFixed(4)}, trend=${perf.balanceTrend})`,
            {
                event: 'INTENT_DECIDED',
                data: {
                    balance, roll, sendProbability, regime, amountSol, amountFactor,
                    successRate: perf.successRate,
                    avgAmount: perf.avgAmount,
                    trend: perf.balanceTrend,
                    streak: `+${perf.consecutiveSuccesses}/-${perf.consecutiveFailures}`,
                    target: 'BETA',
                    reason: 'momentum_send',
                },
            }
        );

        // Every 4th cycle that would send, log a memo to the Memo Program instead
        this.cycleCount++;
        if (this.cycleCount % 4 === 0) {
            this.logger.info(
                `ALPHA [${regime}]: cycle=${this.cycleCount} → PROGRAM_CALL (Memo) ` +
                `successRate=${(perf.successRate * 100).toFixed(0)}%`,
                {
                    event: 'INTENT_DECIDED',
                    data: { balance, regime, cycleCount: this.cycleCount, reason: 'memo_log' },
                }
            );

            return {
                type: 'PROGRAM_CALL',
                memo: `ALPHA regime=${regime} sr=${(perf.successRate * 100).toFixed(0)}% bal=${balance.toFixed(4)} cyc=${this.cycleCount}`,
            };
        }

        return {
            type: 'TRANSFER_SOL',
            toAddress: this.betaPublicKey,
            amountSol,
            memo: `ALPHA→BETA ${regime}_momentum ${amountSol} SOL`,
        };
    }
}
