/**
 * Fund agents using the Solana web faucet API (separate from RPC airdrop).
 * The web faucet has different rate limits than the RPC endpoint.
 */
const https = require('https');
const http = require('http');
const { loadMnemonic } = require('../dist/wallet/keystore');
const { AgentWalletRuntime } = require('../dist/wallet/runtime');
const { LAMPORTS_PER_SOL } = require('@solana/web3.js');

function requestFaucet(address) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'requestAirdrop',
            params: [address, 1000000000]  // 1 SOL
        });

        const options = {
            hostname: 'api.devnet.solana.com',
            port: 443,
            path: '/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
            },
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(body);
                        if (parsed.result) {
                            resolve(parsed.result);
                        } else {
                            reject(new Error(JSON.stringify(parsed.error || 'Unknown error')));
                        }
                    } catch (e) {
                        reject(new Error(`Parse error: ${body.substring(0, 200)}`));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
                }
            });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function main() {
    const password = process.argv[2] || 'testtest123';
    const keystorePath = './keystore.enc';

    const mnemonic = loadMnemonic(password, keystorePath);
    const runtime = new AgentWalletRuntime(mnemonic);
    const connection = runtime.getConnection();
    const names = ['ORION', 'LYRA', 'VEGA'];

    for (let i = 0; i < 3; i++) {
        const pubkey = runtime.deriveAgentKeypair(i).publicKey;
        const address = pubkey.toBase58();
        const balance = await connection.getBalance(pubkey);
        console.log(`\n${names[i]}: ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL  (${address})`);

        if (balance < 0.05 * LAMPORTS_PER_SOL) {
            try {
                console.log(`  → Requesting 1 SOL airdrop...`);
                const sig = await requestFaucet(address);
                console.log(`  → Signature: ${sig}`);
                console.log(`  → Waiting for confirmation...`);
                await connection.confirmTransaction(sig, 'confirmed');
                const newBal = await connection.getBalance(pubkey);
                console.log(`  → Confirmed! New balance: ${(newBal / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
            } catch (err) {
                console.log(`  → Failed: ${err.message.substring(0, 150)}`);
            }
        } else {
            console.log(`  → Sufficient balance`);
        }

        if (i < 2) await new Promise(r => setTimeout(r, 5000));
    }

    console.log('\n✅ Funding complete. Run:');
    console.log('   node dist/cli/index.js run --password testtest123 --duration 60\n');
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
