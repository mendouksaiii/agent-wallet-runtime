#!/usr/bin/env node

import { Command } from 'commander';
import dotenv from 'dotenv';
import { loadMnemonic, generateAndSave, KeystoreError } from '../wallet/keystore';
import { AgentWalletRuntime } from '../wallet/runtime';
import { SimulationOrchestrator } from '../simulation/orchestrator';
import { AgentDatabase } from '../db';
import { createSystemLogger } from '../logger';

dotenv.config();

const logger = createSystemLogger();
const program = new Command();

const DEVNET_EXPLORER = 'https://explorer.solana.com/tx';

/**
 * Validates password meets minimum security requirements.
 */
function validatePassword(password: string): void {
    if (password.length < 8) {
        console.error('❌ Password must be at least 8 characters long.');
        process.exit(1);
    }
}

program
    .name('agent-wallet')
    .description('Autonomous wallet runtime for AI agents on Solana devnet')
    .version('1.0.0');

/**
 * agent-wallet init
 * Generates new BIP39 mnemonic, encrypts and saves to keystore.
 */
program
    .command('init')
    .description('Generate and encrypt a new wallet mnemonic')
    .requiredOption('--password <password>', 'Encryption password (min 8 chars)')
    .action(async (options: { password: string }) => {
        validatePassword(options.password);
        try {
            const keystorePath = process.env.KEYSTORE_PATH || './keystore.enc';

            logger.info('Generating new BIP39 mnemonic...', { event: 'INIT_START', data: {} });

            const mnemonic = generateAndSave(options.password, keystorePath);

            console.log('\n╔══════════════════════════════════════════════════════════════╗');
            console.log('║  🔑 WALLET MNEMONIC — BACK THIS UP NOW! SHOWN ONLY ONCE.   ║');
            console.log('╠══════════════════════════════════════════════════════════════╣');
            console.log(`║  ${mnemonic}`);
            console.log('╠══════════════════════════════════════════════════════════════╣');
            console.log('║  ⚠️  Store this securely. It cannot be recovered.           ║');
            console.log('╚══════════════════════════════════════════════════════════════╝\n');

            const runtime = new AgentWalletRuntime(mnemonic);
            const agents = runtime.listDerivedAgents(3);

            console.log('Derived Agent Wallets:');
            console.log('─────────────────────────────────────────────────');
            for (const agent of agents) {
                const names = ['ORION (Market Maker)', 'LYRA (Accumulator)', 'VEGA (Rebalancer)'];
                console.log(`  Agent ${agent.agentId} — ${names[agent.agentId]}`);
                console.log(`    Public Key: ${agent.publicKey}`);
                console.log(`    Path:       ${agent.derivationPath}`);
                console.log('');
            }

            console.log(`✅ Keystore saved to: ${keystorePath}`);

            logger.info('Wallet initialized successfully', {
                event: 'INIT_COMPLETE',
                data: { keystorePath, agentCount: 3 },
            });
        } catch (err) {
            console.error(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    });

/**
 * agent-wallet run
 * Loads mnemonic, initializes orchestrator, runs multi-agent simulation.
 */
program
    .command('run')
    .description('Run the multi-agent simulation on Solana devnet')
    .requiredOption('--password <password>', 'Keystore decryption password')
    .option('--duration <seconds>', 'Simulation duration in seconds', '120')
    .option('--dashboard', 'Enable live terminal dashboard (default: true)', true)
    .option('--no-dashboard', 'Disable dashboard, use streaming logs instead')
    .action(async (options: { password: string; duration: string; dashboard: boolean }) => {
        const orchestrator = new SimulationOrchestrator();

        // Graceful shutdown on SIGINT / SIGTERM
        const shutdown = async (): Promise<void> => {
            console.log('\n🛑 Shutting down gracefully...');
            await orchestrator.stop();
            process.exit(0);
        };

        process.on('SIGINT', () => { void shutdown(); });
        process.on('SIGTERM', () => { void shutdown(); });

        validatePassword(options.password);
        try {
            const keystorePath = process.env.KEYSTORE_PATH || './keystore.enc';
            const mnemonic = loadMnemonic(options.password, keystorePath);
            const duration = parseInt(options.duration, 10);

            console.log(`\n🚀 Starting simulation for ${duration} seconds on Solana devnet...\n`);

            await orchestrator.initialize(mnemonic);
            await orchestrator.start(duration, options.dashboard);

            // Keep process alive for duration + buffer
            await new Promise<void>((resolve) => {
                setTimeout(() => resolve(), (duration + 5) * 1000);
            });
        } catch (err) {
            if (err instanceof KeystoreError) {
                console.error(`❌ Keystore Error: ${err.message}`);
            } else {
                console.error(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
            }
            process.exit(1);
        }
    });

/**
 * agent-wallet status
 * Shows current devnet balances and SQLite summary stats.
 */
program
    .command('status')
    .description('Show agent balances and transaction summary')
    .requiredOption('--password <password>', 'Keystore decryption password')
    .action(async (options: { password: string }) => {
        validatePassword(options.password);
        try {
            const keystorePath = process.env.KEYSTORE_PATH || './keystore.enc';
            const mnemonic = loadMnemonic(options.password, keystorePath);
            const runtime = new AgentWalletRuntime(mnemonic);
            const connection = runtime.getConnection();
            const names = ['ORION', 'LYRA', 'VEGA'];

            console.log('\n📊 Agent Wallet Status (Solana Devnet)');
            console.log('═══════════════════════════════════════════════════════');

            for (let i = 0; i < 3; i++) {
                const publicKey = runtime.getPublicKey(i);
                try {
                    const balance = await connection.getBalance(runtime.deriveAgentKeypair(i).publicKey);
                    const sol = balance / 1e9;
                    console.log(`  ${names[i]} (Agent ${i}): ${sol.toFixed(6)} SOL`);
                    console.log(`    Address: ${publicKey}`);
                } catch {
                    console.log(`  ${names[i]} (Agent ${i}): ⚠️ Unable to fetch balance`);
                    console.log(`    Address: ${publicKey}`);
                }
            }

            // SQLite stats
            try {
                const db = await AgentDatabase.create();
                const stats = db.getSummaryStats();
                console.log('\n📈 Transaction Summary');
                console.log('───────────────────────────────────────────────────────');
                console.log(`  Total Transactions: ${stats.totalTxs}`);
                console.log(`  Success Rate:       ${stats.successRate.toFixed(1)}%`);
                console.log(`  Total SOL Moved:    ${stats.totalSolMoved.toFixed(6)} SOL`);

                if (stats.agentBreakdown.length > 0) {
                    console.log('\n  Per-Agent Breakdown:');
                    for (const agent of stats.agentBreakdown) {
                        console.log(`    ${agent.agent_name}: ${agent.totalActions} actions, ${agent.successfulTxs} successful, ${agent.totalSol.toFixed(6)} SOL`);
                    }
                }

                db.close();
            } catch {
                console.log('\n  ℹ️  No transaction history found (run a simulation first)');
            }

            console.log('');
        } catch (err) {
            console.error(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    });

/**
 * agent-wallet history
 * Prints last N actions for a specified agent from SQLite.
 */
program
    .command('history')
    .description('Show recent action history for an agent')
    .requiredOption('--agent <id>', 'Agent ID (0, 1, or 2)')
    .option('--limit <n>', 'Number of records to show', '20')
    .action(async (options: { agent: string; limit: string }) => {
        try {
            const agentId = parseInt(options.agent, 10);
            const limit = parseInt(options.limit, 10);
            const names: Record<number, string> = { 0: 'ORION', 1: 'LYRA', 2: 'VEGA' };
            const agentName = names[agentId] || `Agent ${agentId}`;

            const db = await AgentDatabase.create();
            const history = db.getAgentHistory(agentId, limit);

            console.log(`\n📜 Action History: ${agentName} (last ${limit})`);
            console.log('═══════════════════════════════════════════════════════');

            if (history.length === 0) {
                console.log('  No actions recorded yet.');
            } else {
                for (const action of history) {
                    const status = action.action_taken
                        ? (action.tx_success ? '✅' : '❌')
                        : '💤';
                    const amount = action.sol_amount ? `${action.sol_amount.toFixed(6)} SOL` : 'N/A';

                    console.log(`  ${status} [${action.cycle_timestamp}]`);
                    console.log(`     Type: ${action.intent_type || 'IDLE'} | Amount: ${amount}`);

                    if (action.tx_signature) {
                        console.log(`     Tx:      ${action.tx_signature}`);
                        console.log(`     Explorer: ${DEVNET_EXPLORER}/${action.tx_signature}?cluster=devnet`);
                    }
                    if (action.error_message) {
                        console.log(`     Err:  ${action.error_message}`);
                    }

                    console.log(`     Balance: ${action.balance_before?.toFixed(6)} → ${action.balance_after?.toFixed(6)} SOL`);
                    console.log('');
                }
            }

            db.close();
        } catch (err) {
            console.error(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    });

/**
 * agent-wallet airdrop
 * Manually requests 0.5 SOL airdrop for specified agent.
 */
program
    .command('airdrop')
    .description('Request a devnet SOL airdrop for an agent')
    .requiredOption('--password <password>', 'Keystore decryption password')
    .requiredOption('--agent <id>', 'Agent ID (0, 1, or 2)')
    .action(async (options: { password: string; agent: string }) => {
        validatePassword(options.password);
        try {
            const keystorePath = process.env.KEYSTORE_PATH || './keystore.enc';
            const mnemonic = loadMnemonic(options.password, keystorePath);
            const agentId = parseInt(options.agent, 10);
            const names: Record<number, string> = { 0: 'ORION', 1: 'LYRA', 2: 'VEGA' };

            console.log(`\n💰 Requesting airdrop for ${names[agentId] || `Agent ${agentId}`}...`);

            const runtime = new AgentWalletRuntime(mnemonic);
            const publicKey = runtime.getPublicKey(agentId);
            console.log(`   Address: ${publicKey}`);

            await runtime.airdropIfNeeded(agentId, Infinity); // Force airdrop regardless of balance

            const connection = runtime.getConnection();
            const balance = await connection.getBalance(runtime.deriveAgentKeypair(agentId).publicKey);
            console.log(`   New balance: ${(balance / 1e9).toFixed(6)} SOL`);
            console.log('✅ Airdrop complete\n');
        } catch (err) {
            console.error(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    });

/**
 * agent-wallet web
 * Starts the web dashboard server (HTTP + SSE).
 */
program
    .command('web')
    .description('Start the live web dashboard server at http://localhost:<port>')
    .option('--port <port>', 'Port to listen on', '3000')
    .action(async (options: { port: string }) => {
        const port = parseInt(options.port, 10);
        const { WebServer } = await import('../web/server');
        const server = new WebServer(port);
        await server.listen();

        console.log('\n╔══════════════════════════════════════════════════════════════╗');
        console.log(`║  🌐  Web Dashboard: http://localhost:${port}                    ║`);
        console.log('║  Enter your keystore password in the browser to start.        ║');
        console.log('║  Press Ctrl+C to stop.                                        ║');
        console.log('╚══════════════════════════════════════════════════════════════╝\n');

        process.on('SIGINT', async () => {
            await server.close();
            process.exit(0);
        });
    });

program.parse(process.argv);
