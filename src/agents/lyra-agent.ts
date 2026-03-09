import { BaseAgent, AgentConfig } from './base-agent';
import { TransactionIntent } from '../wallet/signer';
import { MINTS } from '../integrations/jupiter';

/**
 * LYRA Agent — Smart Accumulator + Jupiter DEX Trader
 *
 * Tracks balance trend over recent cycles and decides when to forward
 * excess SOL to VEGA. Every 5th active cycle, swaps 0.01 SOL → USDC
 * via Jupiter DEX instead of forwarding (requires mainnet liquidity).
 *
 * Strategy:
 * - Track balance trend from DB (rising/stable/falling)
 * - Rising: forward 20% of excess to VEGA
 * - Stable/falling: only forward if balance > 2× baseline
 * - Never forward if it would drop below safety reserve
 * - Every 5th active cycle with enough balance → SWAP_TOKEN (Jupiter)
 */
export class LyraAgent extends BaseAgent {
    private readonly vegaPublicKey: string;
    private startingBalance: number | null = null;
    private activeCount: number = 0;

    constructor(config: AgentConfig, vegaPublicKey: string) {
        super(config);
        this.vegaPublicKey = vegaPublicKey;
    }

    async decideIntent(): Promise<TransactionIntent | null> {
        const balance = await this.getBalance();

        if (this.startingBalance === null) {
            this.startingBalance = balance;
        }

        const safetyReserve = 0.03;

        if (balance <= safetyReserve) {
            this.logger.info(`LYRA: balance=${balance.toFixed(6)} SOL — at safety reserve, idling`, {
                event: 'INTENT_DECIDED',
                data: { balance, safetyReserve, reason: 'safety_reserve' },
            });
            return null;
        }

        const perf = this.db.getRecentPerformance(this.agentId, 8);
        const baseline = this.startingBalance;
        const excess = balance - baseline;

        let transferAmount = 0;
        let reason = '';

        if (perf.balanceTrend === 'rising' && excess > 0.01) {
            transferAmount = parseFloat((excess * 0.20).toFixed(6));
            reason = 'rising_trend_forward';

            this.logger.info(
                `LYRA [rising]: balance=${balance.toFixed(6)}, baseline=${baseline.toFixed(6)}, ` +
                `excess=${excess.toFixed(6)} → forwarding ${transferAmount.toFixed(6)} SOL (20% of excess)`,
                {
                    event: 'BALANCE_TREND',
                    data: { balance, baseline, excess, transferAmount, trend: 'rising', perf },
                }
            );
        } else if (balance > baseline * 2 && balance > 0.15) {
            transferAmount = parseFloat(((balance - baseline * 1.5) * 0.3).toFixed(6));
            reason = 'doubled_baseline_forward';

            this.logger.info(
                `LYRA [doubled]: balance=${balance.toFixed(6)} > 2×baseline=${(baseline * 2).toFixed(6)} ` +
                `→ forwarding ${transferAmount.toFixed(6)} SOL`,
                {
                    event: 'BALANCE_TREND',
                    data: { balance, baseline, transferAmount, trend: 'doubled', perf },
                }
            );
        } else {
            this.logger.info(
                `LYRA [holding]: balance=${balance.toFixed(6)}, baseline=${baseline.toFixed(6)}, ` +
                `trend=${perf.balanceTrend}, excess=${excess.toFixed(6)} → accumulating`,
                {
                    event: 'INTENT_DECIDED',
                    data: { balance, baseline, excess, trend: perf.balanceTrend, reason: 'accumulating' },
                }
            );
            return null;
        }

        // Clamp: min 0.005, max 0.05, never drop below safety floor
        transferAmount = Math.max(0.005, Math.min(transferAmount, 0.05));
        if (balance - transferAmount < safetyReserve) {
            transferAmount = parseFloat((balance - safetyReserve).toFixed(6));
        }

        if (transferAmount < 0.002) {
            this.logger.info(`LYRA: computed transfer too small (${transferAmount}), idling`, {
                event: 'INTENT_DECIDED',
                data: { transferAmount, reason: 'amount_too_small' },
            });
            return null;
        }

        this.activeCount++;

        // Every 5th active cycle: swap SOL → USDC via Jupiter DEX
        // NOTE: devnet has sparse liquidity; works reliably on mainnet-lyra.
        if (this.activeCount % 5 === 0 && balance > 0.05) {
            const swapLamports = 10_000_000; // 0.01 SOL in lamports
            this.logger.info(
                `LYRA [Jupiter]: cycle=${this.activeCount} → SWAP_TOKEN 0.01 SOL → USDC`,
                {
                    event: 'INTENT_DECIDED',
                    data: { balance, activeCount: this.activeCount, swapLamports, reason: 'jupiter_swap' },
                }
            );

            return {
                type: 'SWAP_TOKEN',
                amountLamports: swapLamports,
                inputMint: MINTS.SOL,
                outputMint: MINTS.USDC,
                slippageBps: 100, // 1% slippage — more forgiving for sparse devnet liquidity
                memo: `LYRA Jupiter swap 0.01 SOL→USDC cycle=${this.activeCount}`,
            };
        }

        this.logger.info(
            `LYRA → VEGA: forwarding ${transferAmount.toFixed(6)} SOL (${reason})`,
            {
                event: 'INTENT_DECIDED',
                data: { balance, baseline, transferAmount, reason, target: 'VEGA' },
            }
        );

        return {
            type: 'TRANSFER_SOL',
            toAddress: this.vegaPublicKey,
            amountSol: transferAmount,
            memo: `LYRA→VEGA ${reason} ${transferAmount} SOL`,
        };
    }
}
