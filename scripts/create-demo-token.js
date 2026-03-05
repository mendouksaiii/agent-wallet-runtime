/**
 * create-demo-token.js
 *
 * Creates a test SPL token on Solana devnet, mints 1,000,000 tokens to ALPHA,
 * and creates ATAs for all 3 agents.
 *
 * Usage:
 *   node scripts/create-demo-token.js <password>
 *
 * Outputs the mint address to use in the simulation config.
 */

const { Connection, clusterApiUrl, Keypair } = require('@solana/web3.js');
const {
    createMint,
    getOrCreateAssociatedTokenAccount,
    mintTo,
} = require('@solana/spl-token');
const fs = require('fs');
const crypto = require('crypto');

// Must match keystore.ts exactly
const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const DIGEST = 'sha512';

/**
 * Loads and decrypts mnemonic from keystore — matches keystore.ts format exactly.
 */
function loadMnemonic(password, keystorePath) {
    const raw = fs.readFileSync(keystorePath, 'utf8');
    const data = JSON.parse(raw);

    // Validate fields match TypeScript keystore format
    if (!data.salt || !data.iv || !data.authTag || !data.ciphertext) {
        throw new Error('Keystore file is malformed. Expected: salt, iv, authTag, ciphertext');
    }

    const salt = Buffer.from(data.salt, 'hex');
    const iv = Buffer.from(data.iv, 'hex');
    const authTag = Buffer.from(data.authTag, 'hex');
    const ciphertext = Buffer.from(data.ciphertext, 'hex');

    // Derive key with PBKDF2 (same as keystore.ts)
    const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]);

    return decrypted.toString('utf8');
}

/**
 * Derives agent keypair — must match runtime.ts BIP44 derivation exactly.
 */
function deriveKeypair(mnemonic, agentId) {
    const bip39 = require('bip39');
    const { derivePath } = require('ed25519-hd-key');

    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const path = `m/44'/501'/${agentId}'/0'`;
    const derived = derivePath(path, seed.toString('hex'));
    return Keypair.fromSeed(derived.key);
}

async function main() {
    const password = process.argv[2];
    if (!password) {
        console.error('Usage: node scripts/create-demo-token.js <password>');
        process.exit(1);
    }

    const keystorePath = process.env.KEYSTORE_PATH || './keystore.enc';
    if (!fs.existsSync(keystorePath)) {
        console.error(`❌ Keystore not found at ${keystorePath}. Run "agent-wallet init" first.`);
        process.exit(1);
    }

    let mnemonic;
    try {
        mnemonic = loadMnemonic(password, keystorePath);
    } catch (err) {
        console.error(`❌ Failed to decrypt keystore: ${err.message}`);
        process.exit(1);
    }

    const connection = new Connection(
        process.env.SOLANA_RPC_URL || clusterApiUrl('devnet'),
        'confirmed'
    );

    // Use ALPHA's keypair as the mint authority (agent 0)
    const alphaKeypair = deriveKeypair(mnemonic, 0);

    console.log('\n🪙  Creating SPL Token on Devnet...\n');
    console.log(`Mint authority (ALPHA): ${alphaKeypair.publicKey.toBase58()}`);

    // Check ALPHA has enough SOL to pay for mint + ATAs (~0.01 SOL needed)
    const balance = await connection.getBalance(alphaKeypair.publicKey);
    const balSol = balance / 1e9;
    console.log(`ALPHA balance: ${balSol.toFixed(6)} SOL`);

    if (balSol < 0.01) {
        console.error(`\n❌ ALPHA needs at least 0.01 SOL. Current: ${balSol.toFixed(6)} SOL`);
        console.error('   Run: npx agent-wallet airdrop --password <pw> --agent 0');
        process.exit(1);
    }

    // Step 1: Create the mint (9 decimals, standard)
    console.log('\n📝 Creating mint...');
    const mint = await createMint(
        connection,
        alphaKeypair,            // payer
        alphaKeypair.publicKey,  // mint authority
        null,                    // freeze authority (none)
        9,                       // 9 decimals (like USDC)
    );

    console.log(`✅ Mint created: ${mint.toBase58()}`);
    console.log(`   Explorer: https://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet`);

    // Step 2: Create ATAs for all 3 agents
    const agentNames = ['ALPHA', 'BETA', 'GAMMA'];
    const atas = [];

    console.log('\n📦 Creating Associated Token Accounts...');
    for (let agentId = 0; agentId < 3; agentId++) {
        const keypair = deriveKeypair(mnemonic, agentId);

        try {
            const ata = await getOrCreateAssociatedTokenAccount(
                connection,
                alphaKeypair,       // payer (ALPHA pays for all ATAs)
                mint,               // token mint
                keypair.publicKey,  // owner of the ATA
            );

            atas.push(ata);
            console.log(`   ✅ ${agentNames[agentId]} ATA: ${ata.address.toBase58()}`);
        } catch (err) {
            console.error(`   ❌ Failed to create ATA for ${agentNames[agentId]}: ${err.message}`);
        }
    }

    // Step 3: Mint 1,000,000 tokens to ALPHA
    if (atas.length > 0) {
        const mintAmount = 1_000_000n * (10n ** 9n); // 1M tokens × 10^9 (9 decimals)

        console.log('\n💰 Minting 1,000,000 tokens to ALPHA...');
        try {
            const sig = await mintTo(
                connection,
                alphaKeypair,            // payer
                mint,                    // mint
                atas[0].address,         // destination (ALPHA's ATA)
                alphaKeypair.publicKey,  // mint authority
                mintAmount,              // amount in smallest units
            );

            console.log(`   ✅ Minted 1,000,000 tokens`);
            console.log(`   Tx: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
        } catch (err) {
            console.error(`   ❌ Mint failed: ${err.message}`);
        }
    }

    // Step 4: Output the config
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`\n🎉 Done! Add this to your environment or agent config:\n`);
    console.log(`   DEMO_TOKEN_MINT=${mint.toBase58()}\n`);
    console.log(`   Decimals: 9 (1 token = 1,000,000,000 smallest units)`);
    console.log(`   ALPHA holds: 1,000,000 tokens`);
    console.log(`   BETA/GAMMA ATAs: created (0 balance)\n`);
}

main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
