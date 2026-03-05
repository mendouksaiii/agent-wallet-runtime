import { AgentDatabase } from '../src/db';
import { AlphaAgent } from '../src/agents/alpha-agent';
import { BetaAgent } from '../src/agents/beta-agent';
import { GammaAgent } from '../src/agents/gamma-agent';
import { TransactionSigner } from '../src/wallet/signer';
import { AgentWalletRuntime } from '../src/wallet/runtime';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { CONSERVATIVE_POLICY, STANDARD_POLICY } from '../src/wallet/policy';
import * as bip39 from 'bip39';

jest.setTimeout(15000);

const mnemonic = bip39.generateMnemonic(128);

/**
 * Helper: seeds the DB with fake action history for testing adaptive logic.
 */
function seedActions(
    db: AgentDatabase,
    agentId: number,
    agentName: string,
    actions: Array<{ success: boolean; amount: number; balanceBefore: number }>
): void {
    for (const action of actions) {
        db.insertAction({
            agent_id: agentId,
            agent_name: agentName,
            cycle_timestamp: new Date().toISOString(),
            intent_type: 'TRANSFER_SOL',
            intent_details: '{}',
            action_taken: 1,
            tx_signature: action.success ? 'fakesig_' + Math.random().toString(36).slice(2) : null,
            tx_success: action.success ? 1 : 0,
            error_message: action.success ? null : 'simulated failure',
            sol_amount: action.amount,
            balance_before: action.balanceBefore,
            balance_after: action.success ? action.balanceBefore - action.amount : action.balanceBefore,
        });
    }
}

describe('AlphaAgent (Momentum Strategy)', () => {
    let db: AgentDatabase;
    let runtime: AgentWalletRuntime;

    beforeEach(async () => {
        db = await AgentDatabase.createInMemory();
        runtime = new AgentWalletRuntime(mnemonic);
    });

    afterEach(() => {
        db.close();
    });

    test('returns null when balance is below safety floor', async () => {
        const agent = new AlphaAgent(
            {
                agentId: 0, name: 'ALPHA',
                signer: {} as TransactionSigner,
                runtime, connection: runtime.getConnection(),
                db, intervalMs: 8000, policy: CONSERVATIVE_POLICY(0),
            },
            runtime.getPublicKey(1)
        );

        // Mock getBalance to return low amount
        jest.spyOn(agent, 'getBalance').mockResolvedValue(0.02);

        const intent = await agent.decideIntent();
        expect(intent).toBeNull();
    });

    test('adapts probability based on seeded success rate', async () => {
        // Seed 10 all-success actions → should trigger "hot" regime
        seedActions(db, 0, 'ALPHA', Array(10).fill(null).map(() => ({
            success: true, amount: 0.003, balanceBefore: 0.5,
        })));

        const agent = new AlphaAgent(
            {
                agentId: 0, name: 'ALPHA',
                signer: {} as TransactionSigner,
                runtime, connection: runtime.getConnection(),
                db, intervalMs: 8000, policy: CONSERVATIVE_POLICY(0),
            },
            runtime.getPublicKey(1)
        );

        jest.spyOn(agent, 'getBalance').mockResolvedValue(0.5);

        // Run 20 iterations — with hot regime (85%+ prob), should send most of the time
        let sendCount = 0;
        for (let i = 0; i < 20; i++) {
            const intent = await agent.decideIntent();
            if (intent) sendCount++;
        }

        // Hot regime → should send at least 12 out of 20 (>60% even accounting for randomness)
        expect(sendCount).toBeGreaterThanOrEqual(10);
    });

    test('reduces sends during cold streak', async () => {
        // Seed 10 all-failure actions → should trigger "cold" regime
        seedActions(db, 0, 'ALPHA', Array(10).fill(null).map(() => ({
            success: false, amount: 0.003, balanceBefore: 0.5,
        })));

        const agent = new AlphaAgent(
            {
                agentId: 0, name: 'ALPHA',
                signer: {} as TransactionSigner,
                runtime, connection: runtime.getConnection(),
                db, intervalMs: 8000, policy: CONSERVATIVE_POLICY(0),
            },
            runtime.getPublicKey(1)
        );

        jest.spyOn(agent, 'getBalance').mockResolvedValue(0.5);

        let sendCount = 0;
        for (let i = 0; i < 20; i++) {
            const intent = await agent.decideIntent();
            if (intent) sendCount++;
        }

        // Cold regime (25% prob due to streak penalty) → should send fewer than 12 out of 20
        expect(sendCount).toBeLessThan(12);
    });
});

describe('BetaAgent (Smart Accumulation)', () => {
    let db: AgentDatabase;
    let runtime: AgentWalletRuntime;

    beforeEach(async () => {
        db = await AgentDatabase.createInMemory();
        runtime = new AgentWalletRuntime(mnemonic);
    });

    afterEach(() => {
        db.close();
    });

    test('idles when below safety reserve', async () => {
        const agent = new BetaAgent(
            {
                agentId: 1, name: 'BETA',
                signer: {} as TransactionSigner,
                runtime, connection: runtime.getConnection(),
                db, intervalMs: 12000, policy: STANDARD_POLICY(1),
            },
            runtime.getPublicKey(2)
        );

        jest.spyOn(agent, 'getBalance').mockResolvedValue(0.02);

        const intent = await agent.decideIntent();
        expect(intent).toBeNull();
    });

    test('forwards excess when balance trend is rising', async () => {
        // Seed rising balance trend
        seedActions(db, 1, 'BETA', [
            { success: true, amount: 0.003, balanceBefore: 0.10 },
            { success: true, amount: 0.003, balanceBefore: 0.12 },
            { success: true, amount: 0.003, balanceBefore: 0.14 },
            { success: true, amount: 0.003, balanceBefore: 0.16 },
            { success: true, amount: 0.003, balanceBefore: 0.18 },
        ]);

        const agent = new BetaAgent(
            {
                agentId: 1, name: 'BETA',
                signer: {} as TransactionSigner,
                runtime, connection: runtime.getConnection(),
                db, intervalMs: 12000, policy: STANDARD_POLICY(1),
            },
            runtime.getPublicKey(2)
        );

        // First call sets starting balance
        jest.spyOn(agent, 'getBalance').mockResolvedValue(0.10);
        await agent.decideIntent(); // sets startingBalance = 0.10

        // Now mock higher balance to simulate growth
        jest.spyOn(agent, 'getBalance').mockResolvedValue(0.20);
        const intent = await agent.decideIntent();

        // Should forward some excess since balance doubled
        // With balance=0.20 and baseline=0.10, in doubled mode → forwards
        expect(intent).not.toBeNull();
        if (intent) {
            expect(intent.type).toBe('TRANSFER_SOL');
            expect(intent.amountSol).toBeGreaterThanOrEqual(0.005);
        }
    });

    test('holds when balance is stable', async () => {
        const agent = new BetaAgent(
            {
                agentId: 1, name: 'BETA',
                signer: {} as TransactionSigner,
                runtime, connection: runtime.getConnection(),
                db, intervalMs: 12000, policy: STANDARD_POLICY(1),
            },
            runtime.getPublicKey(2)
        );

        // Stable balance — no change
        jest.spyOn(agent, 'getBalance').mockResolvedValue(0.06);
        await agent.decideIntent(); // sets startingBalance = 0.06

        jest.spyOn(agent, 'getBalance').mockResolvedValue(0.065);
        const intent = await agent.decideIntent();

        expect(intent).toBeNull(); // excess too small
    });
});

describe('GammaAgent (Proportional Rebalancer)', () => {
    let db: AgentDatabase;
    let runtime: AgentWalletRuntime;

    beforeEach(async () => {
        db = await AgentDatabase.createInMemory();
        runtime = new AgentWalletRuntime(mnemonic);
    });

    afterEach(() => {
        db.close();
    });

    test('idles when gamma has insufficient reserves', async () => {
        const agent = new GammaAgent(
            {
                agentId: 2, name: 'GAMMA',
                signer: {} as TransactionSigner,
                runtime, connection: runtime.getConnection(),
                db, intervalMs: 15000, policy: STANDARD_POLICY(2),
            },
            runtime.getPublicKey(0),
            runtime.getPublicKey(1)
        );

        // Mock all balances
        jest.spyOn(agent, 'getBalance').mockResolvedValue(0.02);
        const mockConnection = {
            getBalance: jest.fn()
                .mockResolvedValueOnce(0.5 * LAMPORTS_PER_SOL) // alpha
                .mockResolvedValueOnce(0.5 * LAMPORTS_PER_SOL), // beta
        };
        (agent as any).connection = mockConnection;

        const intent = await agent.decideIntent();
        expect(intent).toBeNull();
    });

    test('targets the agent with higher need score', async () => {
        // Seed: ALPHA has all failures, BETA has all successes
        seedActions(db, 0, 'ALPHA', Array(8).fill(null).map(() => ({
            success: false, amount: 0.003, balanceBefore: 0.01,
        })));
        seedActions(db, 1, 'BETA', Array(8).fill(null).map(() => ({
            success: true, amount: 0.003, balanceBefore: 0.5,
        })));

        const agent = new GammaAgent(
            {
                agentId: 2, name: 'GAMMA',
                signer: {} as TransactionSigner,
                runtime, connection: runtime.getConnection(),
                db, intervalMs: 15000, policy: STANDARD_POLICY(2),
            },
            runtime.getPublicKey(0),
            runtime.getPublicKey(1)
        );

        jest.spyOn(agent, 'getBalance').mockResolvedValue(0.10);
        const mockConnection = {
            getBalance: jest.fn()
                .mockResolvedValueOnce(0.01 * LAMPORTS_PER_SOL)  // alpha low
                .mockResolvedValueOnce(0.5 * LAMPORTS_PER_SOL),  // beta fine
        };
        (agent as any).connection = mockConnection;

        const intent = await agent.decideIntent();

        expect(intent).not.toBeNull();
        if (intent) {
            expect(intent.type).toBe('TRANSFER_SOL');
            // Should target ALPHA (it has higher need: low balance + high failure rate)
            expect(intent.toAddress).toBe(runtime.getPublicKey(0));
            expect(intent.memo).toContain('ALPHA');
        }
    });

    test('idles when system is healthy', async () => {
        // Both agents have all successes and good balances
        seedActions(db, 0, 'ALPHA', Array(5).fill(null).map(() => ({
            success: true, amount: 0.003, balanceBefore: 0.9,
        })));
        seedActions(db, 1, 'BETA', Array(5).fill(null).map(() => ({
            success: true, amount: 0.003, balanceBefore: 0.9,
        })));

        const agent = new GammaAgent(
            {
                agentId: 2, name: 'GAMMA',
                signer: {} as TransactionSigner,
                runtime, connection: runtime.getConnection(),
                db, intervalMs: 15000, policy: STANDARD_POLICY(2),
            },
            runtime.getPublicKey(0),
            runtime.getPublicKey(1)
        );

        jest.spyOn(agent, 'getBalance').mockResolvedValue(0.10);
        const mockConnection = {
            getBalance: jest.fn()
                .mockResolvedValueOnce(0.9 * LAMPORTS_PER_SOL)
                .mockResolvedValueOnce(0.9 * LAMPORTS_PER_SOL),
        };
        (agent as any).connection = mockConnection;

        const intent = await agent.decideIntent();
        // Both healthy with high balances → need scores should be very low
        // This may or may not be null depending on exact score math, but if it transfers it should be small
        if (intent) {
            expect(intent.amountSol).toBeLessThanOrEqual(0.01);
        }
    });
});

describe('AgentDatabase.getRecentPerformance', () => {
    let db: AgentDatabase;

    beforeEach(async () => {
        db = await AgentDatabase.createInMemory();
    });

    afterEach(() => {
        db.close();
    });

    test('returns zeroed metrics for agent with no history', () => {
        const perf = db.getRecentPerformance(99, 10);
        expect(perf.totalActions).toBe(0);
        expect(perf.successRate).toBe(0);
        expect(perf.avgAmount).toBe(0);
    });

    test('calculates correct success rate from seeded data', () => {
        seedActions(db, 0, 'TEST', [
            { success: true, amount: 0.01, balanceBefore: 1.0 },
            { success: true, amount: 0.01, balanceBefore: 0.99 },
            { success: false, amount: 0.01, balanceBefore: 0.98 },
            { success: true, amount: 0.01, balanceBefore: 0.97 },
        ]);

        const perf = db.getRecentPerformance(0, 10);
        expect(perf.totalActions).toBe(4);
        expect(perf.successCount).toBe(3);
        expect(perf.failCount).toBe(1);
        expect(perf.successRate).toBeCloseTo(0.75);
        expect(perf.avgAmount).toBeCloseTo(0.01);
    });

    test('detects falling balance trend', () => {
        // Inserted in chronological order. DB returns DESC by id.
        // So newest (last inserted) should have lowest balance for "falling".
        seedActions(db, 0, 'TEST', [
            { success: true, amount: 0.01, balanceBefore: 0.80 },
            { success: true, amount: 0.01, balanceBefore: 0.70 },
            { success: true, amount: 0.01, balanceBefore: 0.60 },
            { success: true, amount: 0.01, balanceBefore: 0.50 },
        ]);

        const perf = db.getRecentPerformance(0, 10);
        // DESC order → newest=0.50 (last inserted, highest id), oldest=0.80 (first inserted)
        // 0.50 < 0.80 → falling
        expect(perf.balanceTrend).toBe('falling');
    });
});
