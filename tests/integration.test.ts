/**
 * Integration test — hits real Solana devnet.
 * 
 * This test proves the plumbing works end-to-end:
 * mnemonic → HD derivation → airdrop → policy → simulate → sign → send → confirm
 * 
 * Run with: npm run test:integration
 * Requires internet connection to Solana devnet.
 * 
 * NOTE: Devnet faucet has rate limits. If this test fails with airdrop errors,
 * wait 30 seconds and retry. This is a known devnet limitation, not a bug.
 */

import * as bip39 from 'bip39';
import { AgentWalletRuntime } from '../src/wallet/runtime';
import { PolicyEngine, STANDARD_POLICY } from '../src/wallet/policy';
import { TransactionSigner } from '../src/wallet/signer';
import { AgentDatabase } from '../src/db';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

// 60 second timeout — devnet can be slow
jest.setTimeout(60_000);

describe('Integration: Real Devnet Transaction', () => {
    let runtime: AgentWalletRuntime;
    let db: AgentDatabase;
    let signer: TransactionSigner;

    const mnemonic = bip39.generateMnemonic(128);

    beforeAll(async () => {
        runtime = new AgentWalletRuntime(mnemonic);
        db = await AgentDatabase.createInMemory();

        const connection = runtime.getConnection();
        signer = new TransactionSigner(runtime, connection, db);

        const policy = STANDARD_POLICY(0);
        const engine = new PolicyEngine(policy, db);
        signer.registerPolicy(0, engine);

        const policy1 = STANDARD_POLICY(1);
        const engine1 = new PolicyEngine(policy1, db);
        signer.registerPolicy(1, engine1);
    });

    afterAll(() => {
        db.close();
    });

    test('airdrop → transfer → verify balance change on devnet', async () => {
        const connection = runtime.getConnection();
        const agent0PubKey = runtime.deriveAgentKeypair(0).publicKey;
        const agent1PubKey = runtime.deriveAgentKeypair(1).publicKey;
        const agent1Address = runtime.getPublicKey(1);

        // Step 1: Airdrop 1 SOL to agent 0
        console.log('Requesting airdrop for agent 0...');
        let airdropped = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const sig = await connection.requestAirdrop(agent0PubKey, 1 * LAMPORTS_PER_SOL);
                await connection.confirmTransaction(sig, 'confirmed');
                airdropped = true;
                console.log(`Airdrop confirmed (attempt ${attempt + 1})`);
                break;
            } catch (err) {
                console.log(`Airdrop attempt ${attempt + 1} failed, retrying in ${2000 * (attempt + 1)}ms...`);
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            }
        }

        if (!airdropped) {
            console.log('⚠️ Airdrop rate-limited by devnet. Skipping test (not a bug).');
            return; // Graceful skip — don't fail on devnet rate limits
        }

        // Step 2: Check agent 0 has funds
        const balance0Before = await connection.getBalance(agent0PubKey);
        expect(balance0Before).toBeGreaterThan(0);
        console.log(`Agent 0 balance: ${balance0Before / LAMPORTS_PER_SOL} SOL`);

        // Step 3: Check agent 1 balance before transfer
        const balance1Before = await connection.getBalance(agent1PubKey);
        console.log(`Agent 1 balance before: ${balance1Before / LAMPORTS_PER_SOL} SOL`);

        // Step 4: Execute real transfer through the full pipeline
        const transferAmount = 0.001;
        const result = await signer.executeIntent(
            {
                type: 'TRANSFER_SOL',
                toAddress: agent1Address,
                amountSol: transferAmount,
                memo: 'Integration test transfer',
            },
            0 // from agent 0
        );

        console.log('Execute result:', JSON.stringify(result, null, 2));

        // Step 5: Verify the result
        expect(result.success).toBe(true);
        expect(result.signature).toBeDefined();
        expect(result.signature!.length).toBeGreaterThan(20);
        expect(result.explorerUrl).toContain('explorer.solana.com');
        expect(result.explorerUrl).toContain(result.signature!);

        // Step 6: Verify agent 1 balance increased
        // Wait a moment for balance to update
        await new Promise(r => setTimeout(r, 2000));
        const balance1After = await connection.getBalance(agent1PubKey);
        console.log(`Agent 1 balance after: ${balance1After / LAMPORTS_PER_SOL} SOL`);

        expect(balance1After).toBeGreaterThan(balance1Before);
        expect(balance1After - balance1Before).toBe(transferAmount * LAMPORTS_PER_SOL);

        // Step 7: Verify the spend was recorded in the database
        const dailySpend = db.getDailySpend(0);
        expect(dailySpend).toBeGreaterThanOrEqual(transferAmount);

        console.log(`\n✅ INTEGRATION TEST PASSED`);
        console.log(`   Signature: ${result.signature}`);
        console.log(`   Explorer:  ${result.explorerUrl}`);
        console.log(`   Amount:    ${transferAmount} SOL`);
        console.log(`   Retries:   ${result.retriesUsed}`);
    });
});
