/**
 * Web dashboard server — HTTP + Server-Sent Events.
 *
 * Serves the static dashboard page and streams DashboardState as SSE
 * so the browser can render live agent data without polling.
 *
 * Endpoints:
 *   GET  /          → serves public/index.html
 *   POST /api/start → starts the simulation, begins streaming
 *   POST /api/stop  → stops the simulation
 *   GET  /api/stream → SSE stream of DashboardState events
 *   GET  /api/status → current state snapshot (JSON)
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { loadMnemonic } from '../wallet/keystore';
import { SimulationOrchestrator } from '../simulation/orchestrator';
import { AgentWalletRuntime } from '../wallet/runtime';
import { AgentDatabase } from '../db';
import { createSystemLogger } from '../logger';

const logger = createSystemLogger();

/** SSE client record */
interface SSEClient {
    id: number;
    res: http.ServerResponse;
}

/** Minimal web state shape sent to browser */
export interface WebDashboardState {
    elapsed: number;
    agents: {
        name: string;
        balance: number;
        maxBalance: number;
        txCount: number;
        successRate: number;
        regime: string;
    }[];
    aggregate: {
        totalTxs: number;
        successRate: number;
        solMoved: number;
    };
    recentTxs: {
        from: string;
        to: string;
        amount: number;
        success: boolean;
        signature?: string;
        error?: string;
        timestamp: number;
    }[];
}

export class WebServer extends EventEmitter {
    private server: http.Server;
    private clients: SSEClient[] = [];
    private clientIdCounter = 0;
    private orchestrator: SimulationOrchestrator | null = null;
    private stateInterval: NodeJS.Timeout | null = null;
    private startTime: number | null = null;
    private readonly port: number;
    private currentState: WebDashboardState | null = null;
    private runtime: AgentWalletRuntime | null = null;
    private db: AgentDatabase | null = null;

    constructor(port = 3000) {
        super();
        this.port = port;
        this.server = http.createServer((req, res) => this.handleRequest(req, res));
    }

    /** Start the HTTP server */
    listen(): Promise<void> {
        return new Promise((resolve) => {
            this.server.listen(this.port, () => {
                logger.info(`Web dashboard running at http://localhost:${this.port}`, {
                    event: 'WEB_SERVER_START',
                    data: { port: this.port },
                });
                resolve();
            });
        });
    }

    /** Stop the HTTP server */
    close(): Promise<void> {
        return new Promise((resolve) => {
            this.stopSimulation();
            this.server.close(() => resolve());
        });
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = req.url || '/';
        const method = req.method || 'GET';

        this.setCORS(res);

        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (url === '/' || url === '/index.html') {
            this.serveFile(res, 'public/index.html', 'text/html');
        } else if (url === '/api/stream') {
            this.handleSSE(req, res);
        } else if (url === '/api/start' && method === 'POST') {
            this.handleStart(req, res);
        } else if (url === '/api/stop' && method === 'POST') {
            this.handleStop(res);
        } else if (url === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(this.currentState || {}));
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    }

    private setCORS(res: http.ServerResponse): void {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    private serveFile(res: http.ServerResponse, filePath: string, contentType: string): void {
        const absPath = path.join(process.cwd(), filePath);
        if (!fs.existsSync(absPath)) {
            res.writeHead(404);
            res.end('File not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(absPath).pipe(res);
    }

    private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();

        const client: SSEClient = { id: ++this.clientIdCounter, res };
        this.clients.push(client);

        // Send current state immediately if available
        if (this.currentState) {
            this.sendSSE(client, this.currentState);
        }

        req.on('close', () => {
            this.clients = this.clients.filter(c => c.id !== client.id);
        });
    }

    private async handleStart(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { password, duration = 120 } = JSON.parse(body) as { password: string; duration?: number };

                if (!password || password.length < 8) {
                    this.jsonResponse(res, 400, { ok: false, error: 'Password must be at least 8 characters' });
                    return;
                }

                const keystorePath = process.env.KEYSTORE_PATH ?? './keystore.enc';
                if (!fs.existsSync(keystorePath)) {
                    this.jsonResponse(res, 400, { ok: false, error: 'Keystore not found. Run: agent-wallet init --password <pw>' });
                    return;
                }

                let mnemonic: string;
                try {
                    mnemonic = loadMnemonic(password, keystorePath);
                } catch {
                    this.jsonResponse(res, 401, { ok: false, error: 'Wrong password or corrupted keystore' });
                    return;
                }

                // Stop any existing simulation
                this.stopSimulation();

                this.jsonResponse(res, 200, { ok: true, message: 'Starting simulation…' });

                // Start simulation async (don't await — returns immediately)
                this.startSimulation(mnemonic, duration).catch(err => {
                    logger.error('Simulation error', { event: 'SIM_ERROR', data: { error: err.message } });
                });

            } catch (err) {
                this.jsonResponse(res, 400, { ok: false, error: 'Invalid request body' });
            }
        });
    }

    private handleStop(res: http.ServerResponse): void {
        this.stopSimulation();
        this.jsonResponse(res, 200, { ok: true });
    }

    private async startSimulation(mnemonic: string, durationSec: number): Promise<void> {
        this.runtime = new AgentWalletRuntime(mnemonic);
        this.db = await AgentDatabase.create();
        this.orchestrator = new SimulationOrchestrator();
        this.startTime = Date.now();

        // Poll DB + runtime state every 2 seconds, broadcast over SSE
        this.stateInterval = setInterval(async () => {
            if (!this.runtime || !this.db) return;
            try {
                const state = await this.buildState(this.runtime, this.db);
                this.currentState = state;
                this.broadcast(state);
            } catch { /* ignore transient */ }
        }, 2000);

        try {
            // initialize() sets up all agents, airdrops, and DB internally
            await this.orchestrator.initialize(mnemonic);
            // start() runs the simulation for durationSec seconds, then auto-stops
            await this.orchestrator.start(durationSec, false);
        } finally {
            this.stopSimulation();
        }
    }

    private stopSimulation(): void {
        if (this.stateInterval) {
            clearInterval(this.stateInterval);
            this.stateInterval = null;
        }
        this.orchestrator = null;
        this.runtime = null;
        this.db = null;
        this.startTime = null;
    }

    private async buildState(runtime: AgentWalletRuntime, db: AgentDatabase): Promise<WebDashboardState> {
        const elapsed = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;

        // Get balances
        const agentDefs = [
            { id: 0, name: 'ALPHA' },
            { id: 1, name: 'BETA' },
            { id: 2, name: 'GAMMA' },
        ];

        const agents = await Promise.all(agentDefs.map(async (a) => {
            let balance = 0;
            try {
                const conn = runtime.getConnection();
                const kp = runtime.deriveAgentKeypair(a.id);
                const bal = await conn.getBalance(kp.publicKey);
                balance = bal / 1e9;
            } catch { /* ignore */ }

            const perf = db.getRecentPerformance(a.id, 20);
            return {
                name: a.name,
                balance,
                maxBalance: balance + 0.1, // will self-correct
                txCount: perf.totalActions,
                successRate: perf.successRate * 100,
                regime: this.inferRegime(a.name, perf.successRate),
            };
        }));

        // Find max balances
        const maxBal = Math.max(...agents.map(a => a.balance), 1);
        agents.forEach(a => { a.maxBalance = maxBal; });

        // Aggregate from DB
        const stats = db.getSummaryStats();
        const recentTxs = this.getRecentTxs(db);

        return {
            elapsed,
            agents,
            aggregate: {
                totalTxs: stats.totalTxs,
                successRate: stats.successRate * 100,
                solMoved: stats.totalSolMoved,
            },
            recentTxs,
        };
    }

    private inferRegime(agentName: string, successRate: number): string {
        if (agentName === 'ALPHA') {
            if (successRate >= 0.7) return 'hot';
            if (successRate <= 0.3) return 'cold';
            return 'normal';
        }
        if (agentName === 'BETA') return successRate > 0.6 ? 'rising' : 'stable';
        return successRate > 0.5 ? 'active' : 'observing';
    }

    private getRecentTxs(db: AgentDatabase): WebDashboardState['recentTxs'] {
        try {
            const txs: WebDashboardState['recentTxs'] = [];
            const agentNames = ['ALPHA', 'BETA', 'GAMMA'];

            for (let i = 0; i < 3; i++) {
                const history = db.getAgentHistory(i, 4);
                for (const h of history) {
                    if (h.action_taken) {
                        // Parse recipient from intent_details JSON
                        let toAddress = '?';
                        try {
                            const details = h.intent_details ? JSON.parse(h.intent_details) as { toAddress?: string } : null;
                            toAddress = details?.toAddress
                                ? details.toAddress.substring(0, 6) + '..'
                                : agentNames[(i + 1) % 3];
                        } catch { toAddress = agentNames[(i + 1) % 3]; }

                        txs.push({
                            from: agentNames[i],
                            to: toAddress,
                            amount: h.sol_amount ?? 0,
                            success: (h.tx_success ?? 0) === 1,
                            signature: h.tx_signature ?? undefined,
                            error: h.error_message ?? undefined,
                            timestamp: new Date(h.cycle_timestamp).getTime(),
                        });
                    }
                }
            }

            return txs
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, 8);
        } catch {
            return [];
        }
    }

    private sendSSE(client: SSEClient, state: WebDashboardState): void {
        try {
            client.res.write(`data: ${JSON.stringify(state)}\n\n`);
        } catch {
            this.clients = this.clients.filter(c => c.id !== client.id);
        }
    }

    private broadcast(state: WebDashboardState): void {
        this.clients.forEach(c => this.sendSSE(c, state));
    }

    private jsonResponse(res: http.ServerResponse, status: number, body: object): void {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    }
}
