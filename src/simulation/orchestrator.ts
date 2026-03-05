import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AgentWalletRuntime } from '../wallet/runtime';
import { PolicyEngine, CONSERVATIVE_POLICY, STANDARD_POLICY } from '../wallet/policy';
import { TransactionSigner } from '../wallet/signer';
import { AlphaAgent } from '../agents/alpha-agent';
import { BetaAgent } from '../agents/beta-agent';
import { GammaAgent } from '../agents/gamma-agent';
import { BaseAgent } from '../agents/base-agent';
import { AgentDatabase } from '../db';
import { createSystemLogger, setDashboardMode } from '../logger';
import { Dashboard } from '../ui/dashboard';
import { DashboardState, AgentCardData, RecentTx } from '../ui/dashboard-state';

/**
 * Status snapshot for an individual agent.
 */
export interface AgentStatus {
    agentId: number;
    name: string;
    publicKey: string;
    isRunning: boolean;
    lastAction: string;
}

const logger = createSystemLogger();

/**
 * Agent name mapping for transaction feed display.
 */
const AGENT_NAMES: Record<string, string> = {};

/**
 * Manages the lifecycle of all three agents running concurrently.
 * Handles initialization, airdrop coordination, start/stop, and status reporting.
 * Optionally renders a live ANSI dashboard instead of streaming logs.
 */
export class SimulationOrchestrator {
    private agents: BaseAgent[] = [];
    private runtime: AgentWalletRuntime | null = null;
    private connection: Connection | null = null;
    private db: AgentDatabase | null = null;
    private shutdownTimer: ReturnType<typeof setTimeout> | null = null;
    private statusInterval: ReturnType<typeof setInterval> | null = null;
    private dashboard: Dashboard | null = null;
    private startTime: number = 0;
    private startingBalances: number[] = [0, 0, 0];

    /**
     * Initializes the entire runtime: wallet, connection, database, policies, agents.
     * Airdrops to each agent if balance is below 0.1 SOL (staggered by 2s).
     *
     * @param mnemonic - BIP39 mnemonic for wallet derivation
     * @param dbPath - Optional custom database path
     */
    async initialize(mnemonic: string, dbPath?: string): Promise<void> {
        // 1. Create AgentWalletRuntime
        this.runtime = new AgentWalletRuntime(mnemonic);
        this.connection = this.runtime.getConnection();

        logger.info('Wallet runtime initialized', {
            event: 'RUNTIME_INITIALIZED',
            data: {},
        });

        // 2. Initialize DB
        this.db = await AgentDatabase.create(dbPath);

        logger.info('Database initialized', {
            event: 'DB_INITIALIZED',
            data: {},
        });

        // 3. Create TransactionSigner and policy engines
        const signer = new TransactionSigner(this.runtime, this.connection, this.db);

        const alphaPolicy = CONSERVATIVE_POLICY(0);
        const betaPolicy = STANDARD_POLICY(1);
        const gammaPolicy = STANDARD_POLICY(2);

        const alphaPolicyEngine = new PolicyEngine(alphaPolicy, this.db);
        const betaPolicyEngine = new PolicyEngine(betaPolicy, this.db);
        const gammaPolicyEngine = new PolicyEngine(gammaPolicy, this.db);

        signer.registerPolicy(0, alphaPolicyEngine);
        signer.registerPolicy(1, betaPolicyEngine);
        signer.registerPolicy(2, gammaPolicyEngine);

        // 4. Get public keys for all agents
        const alphaPublicKey = this.runtime.getPublicKey(0);
        const betaPublicKey = this.runtime.getPublicKey(1);
        const gammaPublicKey = this.runtime.getPublicKey(2);

        // Build address → name map for transaction feed
        AGENT_NAMES[alphaPublicKey] = 'ALPHA';
        AGENT_NAMES[betaPublicKey] = 'BETA';
        AGENT_NAMES[gammaPublicKey] = 'GAMMA';

        logger.info('Agent wallets derived', {
            event: 'WALLETS_DERIVED',
            data: {
                alpha: alphaPublicKey,
                beta: betaPublicKey,
                gamma: gammaPublicKey,
            },
        });

        // 5. Airdrop 0.5 SOL to each agent if balance < 0.1 SOL
        //    Stagger requests by 2s to avoid rate limits
        for (const agentId of [0, 1, 2]) {
            try {
                await this.runtime.airdropIfNeeded(agentId, 0.1);
            } catch (err) {
                logger.warn(`Airdrop failed for agent ${agentId} (non-fatal)`, {
                    event: 'AIRDROP_FAILED',
                    data: { agentId, error: err instanceof Error ? err.message : String(err) },
                });
            }

            if (agentId < 2) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
        }

        // 6. Instantiate agents
        const alpha = new AlphaAgent(
            {
                agentId: 0,
                name: 'ALPHA',
                signer,
                runtime: this.runtime,
                connection: this.connection,
                db: this.db,
                intervalMs: 8000,
                policy: alphaPolicy,
            },
            betaPublicKey
        );

        const beta = new BetaAgent(
            {
                agentId: 1,
                name: 'BETA',
                signer,
                runtime: this.runtime,
                connection: this.connection,
                db: this.db,
                intervalMs: 12000,
                policy: betaPolicy,
            },
            gammaPublicKey
        );

        const gamma = new GammaAgent(
            {
                agentId: 2,
                name: 'GAMMA',
                signer,
                runtime: this.runtime,
                connection: this.connection,
                db: this.db,
                intervalMs: 15000,
                policy: gammaPolicy,
            },
            alphaPublicKey,
            betaPublicKey
        );

        this.agents = [alpha, beta, gamma];

        // 7. Log each agent's public key and initial balance; record starting balances
        for (const agent of this.agents) {
            try {
                const balance = await agent.getBalance();
                this.startingBalances[agent.getAgentId()] = balance;
                logger.info(`${agent.getName()} [${agent.getPublicKey()}] balance: ${balance.toFixed(6)} SOL`, {
                    event: 'AGENT_INITIALIZED',
                    data: {
                        agentId: agent.getAgentId(),
                        name: agent.getName(),
                        publicKey: agent.getPublicKey(),
                        balance,
                    },
                });
            } catch (err) {
                logger.warn(`Failed to get initial balance for ${agent.getName()}`, {
                    event: 'BALANCE_ERROR',
                    data: { error: err instanceof Error ? err.message : String(err) },
                });
            }
        }
    }

    /**
     * Starts all agents concurrently. After durationSeconds, automatically stops.
     * If useDashboard is true, renders a live TUI instead of streaming logs.
     *
     * @param durationSeconds - How long to run the simulation before auto-stop
     * @param useDashboard - Whether to render the live dashboard (default: false for backward compat)
     */
    async start(durationSeconds: number, useDashboard: boolean = false): Promise<void> {
        this.startTime = Date.now();

        logger.info(`Starting simulation for ${durationSeconds} seconds`, {
            event: 'SIMULATION_START',
            data: { durationSeconds, agentCount: this.agents.length, dashboard: useDashboard },
        });

        // Initialize dashboard if requested
        if (useDashboard) {
            setDashboardMode(true);
            this.dashboard = new Dashboard();
            this.dashboard.init();
        }

        // Start all agents
        for (const agent of this.agents) {
            await agent.start();
        }

        // Status/dashboard refresh interval
        const refreshMs = useDashboard ? 2000 : 10000;
        this.statusInterval = setInterval(async () => {
            if (this.dashboard) {
                await this.renderDashboard();
            } else {
                await this.printLiveStatus();
            }
        }, refreshMs);

        // Render first dashboard frame immediately
        if (this.dashboard) {
            await this.renderDashboard();
        }

        // Auto-stop after duration
        this.shutdownTimer = setTimeout(async () => {
            await this.stop();
        }, durationSeconds * 1000);
    }

    /**
     * Stops all agents gracefully and prints final summary.
     */
    async stop(): Promise<void> {
        logger.info('Stopping simulation...', {
            event: 'SIMULATION_STOPPING',
            data: {},
        });

        // Clear timers
        if (this.shutdownTimer) {
            clearTimeout(this.shutdownTimer);
            this.shutdownTimer = null;
        }

        if (this.statusInterval) {
            clearInterval(this.statusInterval);
            this.statusInterval = null;
        }

        // Stop all agents
        for (const agent of this.agents) {
            await agent.stop();
        }

        // Destroy dashboard and restore terminal
        if (this.dashboard) {
            this.dashboard.destroy();
            this.dashboard = null;
            setDashboardMode(false);
        }

        // Print final balances
        logger.info('=== FINAL BALANCES ===', { event: 'FINAL_BALANCES', data: {} });
        for (const agent of this.agents) {
            try {
                const balance = await agent.getBalance();
                logger.info(`${agent.getName()}: ${balance.toFixed(6)} SOL`, {
                    event: 'FINAL_BALANCE',
                    data: {
                        agentId: agent.getAgentId(),
                        name: agent.getName(),
                        balance,
                    },
                });
            } catch (err) {
                logger.warn(`Failed to get final balance for ${agent.getName()}`, {
                    event: 'BALANCE_ERROR',
                    data: { error: err instanceof Error ? err.message : String(err) },
                });
            }
        }

        // Print DB summary stats
        if (this.db) {
            const stats = this.db.getSummaryStats();
            logger.info('=== SIMULATION SUMMARY ===', {
                event: 'SIMULATION_SUMMARY',
                data: {
                    totalTxs: stats.totalTxs,
                    successRate: `${stats.successRate.toFixed(1)}%`,
                    totalSolMoved: stats.totalSolMoved.toFixed(6),
                    agentBreakdown: stats.agentBreakdown,
                },
            });
        }

        logger.info('Simulation stopped', {
            event: 'SIMULATION_STOPPED',
            data: {},
        });
    }

    /**
     * Returns status snapshots for all agents.
     */
    getStatus(): AgentStatus[] {
        return this.agents.map((agent) => ({
            agentId: agent.getAgentId(),
            name: agent.getName(),
            publicKey: agent.getPublicKey(),
            isRunning: agent.getIsRunning(),
            lastAction: 'N/A',
        }));
    }

    /**
     * Returns the database instance for external queries.
     */
    getDatabase(): AgentDatabase | null {
        return this.db;
    }

    /**
     * Builds a DashboardState from live agent data and DB, then renders it.
     */
    private async renderDashboard(): Promise<void> {
        if (!this.dashboard || !this.db) return;

        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);

        // Build agent card data
        const agentCards: AgentCardData[] = [];
        for (const agent of this.agents) {
            try {
                const balance = await agent.getBalance();
                const perf = this.db.getRecentPerformance(agent.getAgentId(), 10);

                // Determine regime label based on agent type
                let regime = 'normal';
                const name = agent.getName();
                if (name === 'ALPHA') {
                    if (perf.successRate >= 0.70) regime = 'hot';
                    else if (perf.successRate <= 0.30 && perf.totalActions > 0) regime = 'cold';
                    else regime = 'normal';
                } else if (name === 'BETA') {
                    regime = perf.balanceTrend;
                } else if (name === 'GAMMA') {
                    regime = perf.totalActions === 0 ? 'observing' : 'active';
                }

                agentCards.push({
                    name: agent.getName(),
                    balance,
                    maxBalance: Math.max(this.startingBalances[agent.getAgentId()] || 1, balance),
                    regime,
                    txCount: perf.totalActions,
                    successRate: perf.successRate * 100,
                    isRunning: agent.getIsRunning(),
                });
            } catch {
                agentCards.push({
                    name: agent.getName(),
                    balance: 0,
                    maxBalance: 1,
                    regime: 'error',
                    txCount: 0,
                    successRate: 0,
                    isRunning: agent.getIsRunning(),
                });
            }
        }

        // Aggregate stats
        const stats = this.db.getSummaryStats();

        // Recent transactions from DB (last 6)
        const recentTxs: RecentTx[] = [];
        for (const agentId of [0, 1, 2]) {
            const history = this.db.getAgentHistory(agentId, 6);
            for (const action of history) {
                if (action.action_taken !== 1) continue;

                // Parse intent details for "to" address
                let toName = '?';
                if (action.intent_details) {
                    try {
                        const details = JSON.parse(action.intent_details);
                        toName = AGENT_NAMES[details.toAddress] || (details.toAddress || '').substring(0, 8);
                    } catch {
                        // ignore parse errors
                    }
                }

                recentTxs.push({
                    success: action.tx_success === 1,
                    from: action.agent_name,
                    to: toName,
                    amount: action.sol_amount || 0,
                    signature: action.tx_signature,
                    error: action.error_message,
                    retries: 0,
                    timestamp: action.cycle_timestamp,
                });
            }
        }

        // Sort by timestamp descending, take top 6
        recentTxs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

        const state: DashboardState = {
            elapsed,
            network: 'devnet',
            agents: agentCards,
            aggregate: {
                totalTxs: stats.totalTxs,
                successRate: stats.successRate,
                solMoved: stats.totalSolMoved,
            },
            recentTxs: recentTxs.slice(0, 6),
        };

        this.dashboard.render(state);
    }

    /**
     * Prints live status of all agents to the logger (non-dashboard mode).
     */
    private async printLiveStatus(): Promise<void> {
        logger.info('=== LIVE STATUS ===', { event: 'LIVE_STATUS', data: {} });

        for (const agent of this.agents) {
            try {
                const balance = await agent.getBalance();
                logger.info(`${agent.getName()}: ${balance.toFixed(6)} SOL | running: ${agent.getIsRunning()}`, {
                    event: 'AGENT_STATUS',
                    data: {
                        agentId: agent.getAgentId(),
                        name: agent.getName(),
                        balance,
                        isRunning: agent.getIsRunning(),
                    },
                });
            } catch (err) {
                logger.warn(`Status check failed for ${agent.getName()}`, {
                    event: 'STATUS_ERROR',
                    data: { error: err instanceof Error ? err.message : String(err) },
                });
            }
        }

        if (this.db) {
            const stats = this.db.getSummaryStats();
            logger.info(
                `Txs: ${stats.totalTxs} | Success: ${stats.successRate.toFixed(1)}% | SOL moved: ${stats.totalSolMoved.toFixed(6)}`,
                {
                    event: 'AGGREGATE_STATUS',
                    data: stats,
                }
            );
        }
    }
}
