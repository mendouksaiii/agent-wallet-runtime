/**
 * Dashboard state interfaces — the data contract between the orchestrator
 * and the ANSI renderer. The orchestrator builds this state each tick;
 * the dashboard renders it.
 */

/**
 * Per-agent card data displayed in the dashboard.
 */
export interface AgentCardData {
    name: string;
    balance: number;
    maxBalance: number;       // for bar scaling (usually starting balance)
    regime: string;           // e.g. "hot", "cold", "normal", "holding", "rising", "healthy"
    txCount: number;
    successRate: number;      // 0–100
    isRunning: boolean;
}

/**
 * A recent transaction shown in the live feed.
 */
export interface RecentTx {
    success: boolean;
    from: string;             // agent name
    to: string;               // agent name or address
    amount: number;
    signature: string | null;
    error: string | null;
    retries: number;
    timestamp: string;
}

/**
 * Aggregate stats across all agents.
 */
export interface AggregateStats {
    totalTxs: number;
    successRate: number;       // 0–100
    solMoved: number;
}

/**
 * Complete dashboard state built each render tick.
 */
export interface DashboardState {
    elapsed: number;           // seconds since simulation start
    network: string;           // e.g. "devnet"
    agents: AgentCardData[];
    aggregate: AggregateStats;
    recentTxs: RecentTx[];
}
