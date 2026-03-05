import {
    PolicyEngine,
    CONSERVATIVE_POLICY,
    STANDARD_POLICY,
    AGGRESSIVE_POLICY,
    WalletPolicy,
} from '../src/wallet/policy';
import { AgentDatabase } from '../src/db';
import { Transaction, SystemProgram, Keypair } from '@solana/web3.js';

describe('PolicyEngine', () => {
    let db: AgentDatabase;

    beforeAll(async () => {
        db = await AgentDatabase.createInMemory();
    });

    afterAll(() => {
        db.close();
    });

    function createTestTransaction(lamports: number): Transaction {
        const tx = new Transaction();
        tx.add(
            SystemProgram.transfer({
                fromPubkey: Keypair.generate().publicKey,
                toPubkey: Keypair.generate().publicKey,
                lamports,
            })
        );
        return tx;
    }

    test('TRANSFER_SOL above maxSolPerTransaction is rejected', () => {
        const policy = CONSERVATIVE_POLICY(0); // 0.01 SOL/tx limit
        const engine = new PolicyEngine(policy, db);
        const tx = createTestTransaction(20_000_000); // 0.02 SOL

        const result = engine.validate(tx, 0.02);

        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('exceeds per-tx limit');
    });

    test('spend within limit is allowed', () => {
        const policy = STANDARD_POLICY(1); // 0.05 SOL/tx limit
        const engine = new PolicyEngine(policy, db);
        const tx = createTestTransaction(1_000_000); // 0.001 SOL

        const result = engine.validate(tx, 0.001);

        expect(result.allowed).toBe(true);
        expect(result.reason).toContain('passes all policy checks');
    });

    test('daily spend accumulation correctly blocks after threshold', () => {
        const agentId = 10; // unique to avoid cross-test contamination
        const policy: WalletPolicy = {
            agentId,
            maxSolPerTransaction: 0.05,
            maxDailySpendSol: 0.1,
            allowedProgramIds: [],
            requireSimulationPass: true,
            maxRetries: 3,
        };
        const engine = new PolicyEngine(policy, db);

        // Record several spends approaching the limit
        engine.recordSpend(agentId, 0.04, 'sig1');
        engine.recordSpend(agentId, 0.04, 'sig2');
        // Now at 0.08 out of 0.1 limit

        const tx = createTestTransaction(5_000_000); // 0.005 SOL
        const resultSmall = engine.validate(tx, 0.005);
        expect(resultSmall.allowed).toBe(true); // 0.08 + 0.005 = 0.085 < 0.1

        const resultBig = engine.validate(tx, 0.03);
        expect(resultBig.allowed).toBe(false); // 0.08 + 0.03 = 0.11 > 0.1
        expect(resultBig.reason).toContain('24h limit');
    });

    test('program whitelist rejects unlisted program IDs', () => {
        const whitelistedProgram = Keypair.generate().publicKey.toBase58();
        const policy: WalletPolicy = {
            agentId: 20,
            maxSolPerTransaction: 1.0,
            maxDailySpendSol: 10.0,
            allowedProgramIds: [whitelistedProgram],
            requireSimulationPass: true,
            maxRetries: 3,
        };
        const engine = new PolicyEngine(policy, db);

        // SystemProgram.transfer uses the System Program ID, not in whitelist
        const tx = createTestTransaction(1_000_000);
        const result = engine.validate(tx, 0.001);

        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('not in the allowed whitelist');
    });

    test('empty allowedProgramIds allows all programs', () => {
        const policy = AGGRESSIVE_POLICY(30);
        const engine = new PolicyEngine(policy, db);
        const tx = createTestTransaction(1_000_000);

        const result = engine.validate(tx, 0.001);

        expect(result.allowed).toBe(true);
    });

    test('default policies have correct limits', () => {
        const conservative = CONSERVATIVE_POLICY(0);
        expect(conservative.maxSolPerTransaction).toBe(0.01);
        expect(conservative.maxDailySpendSol).toBe(0.1);

        const standard = STANDARD_POLICY(1);
        expect(standard.maxSolPerTransaction).toBe(0.05);
        expect(standard.maxDailySpendSol).toBe(0.5);

        const aggressive = AGGRESSIVE_POLICY(2);
        expect(aggressive.maxSolPerTransaction).toBe(0.1);
        expect(aggressive.maxDailySpendSol).toBe(1.0);
    });
});
