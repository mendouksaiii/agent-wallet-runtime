/**
 * Live terminal dashboard — pure ANSI, zero dependencies.
 *
 * Uses cursor repositioning + clear for flicker-free redraw.
 * Renders agent cards, aggregate stats, and a recent transaction feed.
 */

import { DashboardState, AgentCardData, RecentTx } from './dashboard-state';

// ANSI helpers
const ESC = '\x1b[';
const CLEAR = `${ESC}2J`;
const HOME = `${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;

// Colors
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const MAGENTA = `${ESC}35m`;
const WHITE = `${ESC}37m`;
const GRAY = `${ESC}90m`;

// Box drawing
const TL = '┌'; const TR = '┐'; const BL = '└'; const BR = '┘';
const H = '─'; const V = '│'; const TJ = '┬'; const BJ = '┴';

/**
 * Dashboard renderer. Call render() every N seconds with fresh state.
 */
export class Dashboard {
    private width: number;
    private started = false;

    constructor() {
        this.width = Math.min(process.stdout.columns || 80, 80);
    }

    /**
     * Initializes the dashboard — hides cursor, clears screen.
     */
    init(): void {
        process.stdout.write(HIDE_CURSOR + CLEAR + HOME);
        this.started = true;

        // Handle resize
        process.stdout.on('resize', () => {
            this.width = Math.min(process.stdout.columns || 80, 80);
        });
    }

    /**
     * Renders a full dashboard frame from the given state.
     */
    render(state: DashboardState): void {
        if (!this.started) this.init();

        this.width = Math.min(process.stdout.columns || 80, 80);
        const w = this.width;
        const lines: string[] = [];

        // Header
        const elapsed = this.formatElapsed(state.elapsed);
        const title = ` Agent Wallet Runtime`;
        const netInfo = `${state.network} ── ${elapsed} elapsed `;
        const headerPad = w - 2 - this.visLen(title) - this.visLen(netInfo);
        lines.push(`${CYAN}${TL}${H}${H}${BOLD}${title}${RESET}${CYAN} ${H.repeat(Math.max(1, headerPad))} ${DIM}${netInfo}${RESET}${CYAN}${TR}${RESET}`);
        lines.push(this.emptyLine(w));

        // Agent cards
        lines.push(...this.renderAgentCards(state.agents, w));
        lines.push(this.emptyLine(w));

        // Aggregate stats
        lines.push(...this.renderAggregate(state.aggregate, w));
        lines.push(this.emptyLine(w));

        // Recent transactions
        lines.push(...this.renderRecentTxs(state.recentTxs, w));
        lines.push(this.emptyLine(w));

        // Footer
        lines.push(`${CYAN}${BL}${H.repeat(w - 2)}${BR}${RESET}`);

        // Write
        process.stdout.write(HOME + lines.join('\n') + '\n');
    }

    /**
     * Restores terminal state — shows cursor.
     */
    destroy(): void {
        if (this.started) {
            process.stdout.write(SHOW_CURSOR);
            this.started = false;
        }
    }

    // ── Agent Cards ──────────────────────────────────────────────

    private renderAgentCards(agents: AgentCardData[], w: number): string[] {
        const lines: string[] = [];
        const colW = Math.floor((w - 4) / 3); // 3 columns inside the border

        // Card header
        const headers = agents.map((a, i) => {
            const color = [CYAN, MAGENTA, YELLOW][i] || WHITE;
            const label = ` ${a.name} `;
            const pad = colW - 2 - this.visLen(label);
            return `${color}${TL}${H}${BOLD}${label}${RESET}${color}${H.repeat(Math.max(0, pad))}${RESET}`;
        });
        lines.push(`${CYAN}${V}${RESET} ${headers.join('')}${CYAN}${TR}${RESET}${CYAN}${V}${RESET}`);

        // Balance row
        const balRow = agents.map((a, i) => {
            const color = [CYAN, MAGENTA, YELLOW][i] || WHITE;
            const bal = `${a.balance.toFixed(6)} SOL`;
            return this.padCell(` ${BOLD}${WHITE}${bal}${RESET}`, colW, bal.length + 1);
        });
        lines.push(`${CYAN}${V}${RESET} ${balRow.join('')} ${CYAN}${V}${RESET}`);

        // Balance bar
        const barRow = agents.map((a) => {
            const pct = a.maxBalance > 0 ? Math.min(100, (a.balance / a.maxBalance) * 100) : 0;
            const bar = this.makeBar(pct, colW - 8);
            const pctStr = `${Math.round(pct)}%`;
            return this.padCell(` ${bar} ${DIM}${pctStr}${RESET}`, colW, colW - 3);
        });
        lines.push(`${CYAN}${V}${RESET} ${barRow.join('')} ${CYAN}${V}${RESET}`);

        // Regime/state row
        const regimeRow = agents.map((a, i) => {
            const color = [CYAN, MAGENTA, YELLOW][i] || WHITE;
            const label = `[${a.regime}]`;
            return this.padCell(` ${color}${label}${RESET}`, colW, label.length + 1);
        });
        lines.push(`${CYAN}${V}${RESET} ${regimeRow.join('')} ${CYAN}${V}${RESET}`);

        // Tx stats row
        const txRow = agents.map((a) => {
            const rateColor = a.successRate >= 70 ? GREEN : a.successRate >= 40 ? YELLOW : RED;
            const stat = `${a.txCount} txs · ${rateColor}${a.successRate.toFixed(0)}%${RESET}`;
            const visL = `${a.txCount} txs · ${a.successRate.toFixed(0)}%`.length;
            return this.padCell(` ${stat}`, colW, visL + 1);
        });
        lines.push(`${CYAN}${V}${RESET} ${txRow.join('')} ${CYAN}${V}${RESET}`);

        // Card bottom
        const bottoms = agents.map((a, i) => {
            const color = [CYAN, MAGENTA, YELLOW][i] || WHITE;
            return `${color}${BL}${H.repeat(Math.max(0, colW - 1))}${RESET}`;
        });
        lines.push(`${CYAN}${V}${RESET} ${bottoms.join('')}${CYAN}${BJ}${V}${RESET}`);

        return lines;
    }

    // ── Aggregate Stats ──────────────────────────────────────────

    private renderAggregate(stats: { totalTxs: number; successRate: number; solMoved: number }, w: number): string[] {
        const lines: string[] = [];
        const label = `${GRAY}───${RESET} ${DIM}Aggregate${RESET} ${GRAY}${H.repeat(Math.max(1, w - 18))}${RESET}`;
        lines.push(`${CYAN}${V}${RESET}  ${label}${CYAN}${V}${RESET}`);

        const rateColor = stats.successRate >= 70 ? GREEN : stats.successRate >= 40 ? YELLOW : RED;
        const content = `  Txs: ${BOLD}${stats.totalTxs}${RESET}    ` +
            `Success: ${rateColor}${BOLD}${stats.successRate.toFixed(1)}%${RESET}    ` +
            `SOL moved: ${BOLD}${stats.solMoved.toFixed(6)}${RESET}`;
        const visL = `  Txs: ${stats.totalTxs}    Success: ${stats.successRate.toFixed(1)}%    SOL moved: ${stats.solMoved.toFixed(6)}`.length;
        lines.push(`${CYAN}${V}${RESET}${content}${' '.repeat(Math.max(0, w - 2 - visL))}${CYAN}${V}${RESET}`);

        return lines;
    }

    // ── Recent Transactions ──────────────────────────────────────

    private renderRecentTxs(txs: RecentTx[], w: number): string[] {
        const lines: string[] = [];
        const label = `${GRAY}───${RESET} ${DIM}Recent Transactions${RESET} ${GRAY}${H.repeat(Math.max(1, w - 28))}${RESET}`;
        lines.push(`${CYAN}${V}${RESET}  ${label}${CYAN}${V}${RESET}`);

        const display = txs.slice(0, 6); // show up to 6

        if (display.length === 0) {
            const msg = `${DIM}  Waiting for transactions...${RESET}`;
            lines.push(`${CYAN}${V}${RESET}${msg}${' '.repeat(Math.max(0, w - 2 - 30))}${CYAN}${V}${RESET}`);
        } else {
            for (const tx of display) {
                const line = this.formatTxLine(tx, w);
                lines.push(`${CYAN}${V}${RESET}${line}${CYAN}${V}${RESET}`);
            }
        }

        return lines;
    }

    private formatTxLine(tx: RecentTx, w: number): string {
        const icon = tx.success ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
        const route = `${tx.from} → ${tx.to}`;

        if (tx.success && tx.signature) {
            const sig = tx.signature.substring(0, 8) + '..';
            const amt = `${tx.amount.toFixed(6)} SOL`;
            const retries = tx.retries > 0 ? ` ${DIM}[${tx.retries}r]${RESET}` : '';
            const content = `  ${icon} ${route}  ${amt}  ${DIM}${sig}${RESET}${retries}`;
            const visL = `  ✓ ${route}  ${amt}  ${sig}${tx.retries > 0 ? ` [${tx.retries}r]` : ''}`.length;
            return content + ' '.repeat(Math.max(0, w - 2 - visL));
        } else {
            const errMsg = (tx.error || 'unknown error').substring(0, w - route.length - 12);
            const content = `  ${icon} ${route}  ${RED}${errMsg}${RESET}`;
            const visL = `  ✗ ${route}  ${errMsg}`.length;
            return content + ' '.repeat(Math.max(0, w - 2 - visL));
        }
    }

    // ── Helpers ──────────────────────────────────────────────────

    private makeBar(pct: number, barWidth: number): string {
        const filled = Math.round((pct / 100) * barWidth);
        const empty = barWidth - filled;
        return `${GREEN}${'▓'.repeat(filled)}${GRAY}${'░'.repeat(empty)}${RESET}`;
    }

    private formatElapsed(seconds: number): string {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    /**
     * Pads a cell containing ANSI codes to a target visual width.
     * @param content - String with ANSI codes
     * @param targetW - Target visual width
     * @param visibleLen - Pre-computed visible length (without ANSI codes)
     */
    private padCell(content: string, targetW: number, visibleLen: number): string {
        const pad = Math.max(0, targetW - visibleLen);
        return content + ' '.repeat(pad);
    }

    /** Counts visible (non-ANSI) character length */
    private visLen(s: string): number {
        // eslint-disable-next-line no-control-regex
        return s.replace(/\x1b\[[0-9;]*m/g, '').length;
    }

    private emptyLine(w: number): string {
        return `${CYAN}${V}${RESET}${' '.repeat(w - 2)}${CYAN}${V}${RESET}`;
    }
}
