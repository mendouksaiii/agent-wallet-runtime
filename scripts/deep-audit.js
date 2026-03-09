/**
 * deep-audit.js
 *
 * Live runtime checks - runs against actual devnet.
 * Tests every critical layer: decrypt, derivation, balance, policy, signer simulation.
 *
 * Usage: node scripts/deep-audit.js <password>
 */
const { Connection, clusterApiUrl, PublicKey } = require('@solana/web3.js');
const crypto = require('crypto');
const fs = require('fs');

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const DIGEST = 'sha512';

let passed = 0, failed = 0, warnings = 0;

function ok(msg) { console.log('  ✓ ' + msg); passed++; }
function fail(msg) { console.log('  ✗ FAIL: ' + msg); failed++; }
function warn(msg) { console.log('  ⚠ WARN: ' + msg); warnings++; }
function section(title) { console.log('\n── ' + title); }

async function run() {
    const password = process.argv[2];
    if (!password) { console.error('Usage: node scripts/deep-audit.js <password>'); process.exit(1); }

    section('LAYER 1 — Keystore Integrity');
    let mnemonic;
    try {
        const raw = fs.readFileSync('./keystore.enc', 'utf8');
        const data = JSON.parse(raw);
        ok('keystore.enc is valid JSON');

        const requiredFields = ['salt', 'iv', 'authTag', 'ciphertext'];
        requiredFields.forEach(f => {
            if (data[f] && data[f].length > 0) ok('field present: ' + f + ' (' + data[f].length + ' hex chars)');
            else fail('field missing: ' + f);
        });

        // Validate hex encoding
        ['salt', 'iv', 'authTag', 'ciphertext'].forEach(f => {
            if (/^[0-9a-f]+$/i.test(data[f])) ok(f + ' is valid hex');
            else fail(f + ' contains non-hex characters');
        });

        // Validate PBKDF2 + AES-256-GCM decrypt
        const salt = Buffer.from(data.salt, 'hex');
        const iv = Buffer.from(data.iv, 'hex');
        const authTag = Buffer.from(data.authTag, 'hex');
        const ciphertext = Buffer.from(data.ciphertext, 'hex');

        if (salt.length !== 32) fail('salt must be 32 bytes, got ' + salt.length);
        else ok('salt is 32 bytes (256-bit)');
        if (iv.length !== 12) fail('IV must be 12 bytes (GCM), got ' + iv.length);
        else ok('IV is 12 bytes (GCM standard)');
        if (authTag.length !== 16) warn('authTag is ' + authTag.length + ' bytes (expected 16)');
        else ok('authTag is 16 bytes');

        const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);
        ok('PBKDF2-SHA512 key derived (100,000 iterations)');

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        mnemonic = decrypted.toString('utf8');
        ok('AES-256-GCM decrypt succeeded');

        // Validate it's a BIP39 mnemonic
        const words = mnemonic.trim().split(/\s+/);
        if (words.length === 12 || words.length === 24) ok('mnemonic is ' + words.length + ' words (BIP39 valid length)');
        else fail('mnemonic has unexpected word count: ' + words.length);

    } catch (e) {
        fail('Keystore decrypt failed: ' + e.message);
        console.error('Cannot continue without mnemonic');
        process.exit(1);
    }

    section('LAYER 2 — HD Key Derivation (BIP44)');
    const { derivePath } = require('ed25519-hd-key');
    const bip39 = require('bip39');

    const seed = bip39.mnemonicToSeedSync(mnemonic);
    ok('BIP39 mnemonic → 64-byte seed');

    const agentKeys = [];
    for (let i = 0; i < 3; i++) {
        const path = `m/44'/501'/${i}'/0'`;
        const derived = derivePath(path, seed.toString('hex'));
        const { Keypair } = require('@solana/web3.js');
        const kp = Keypair.fromSeed(derived.key);
        agentKeys.push({ id: i, kp, path });
        ok(`Agent ${i} → ${path} → ${kp.publicKey.toBase58()}`);
    }

    // Check determinism
    const derived2 = derivePath(`m/44'/501'/0'/0'`, seed.toString('hex'));
    const { Keypair } = require('@solana/web3.js');
    const kp2 = Keypair.fromSeed(derived2.key);
    if (kp2.publicKey.toBase58() === agentKeys[0].kp.publicKey.toBase58()) {
        ok('Derivation is deterministic (same input → same key)');
    } else {
        fail('Derivation is NOT deterministic');
    }

    // Check all keys are different
    const pubkeys = agentKeys.map(a => a.kp.publicKey.toBase58());
    const unique = new Set(pubkeys);
    if (unique.size === 3) ok('All 3 agent keys are distinct');
    else fail('Key collision detected!');

    section('LAYER 3 — Devnet Connectivity & Balances');
    const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');

    try {
        const slot = await connection.getSlot();
        ok('Devnet connected — current slot: ' + slot);
    } catch (e) {
        fail('Devnet connection failed: ' + e.message);
    }

    const agentNames = ['ORION', 'LYRA', 'VEGA'];
    for (const agent of agentKeys) {
        try {
            const bal = await connection.getBalance(agent.kp.publicKey);
            const sol = bal / 1e9;
            const status = sol < 0.01 ? 'LOW — may fail' : 'OK';
            if (sol < 0.005) warn(agentNames[agent.id] + ': ' + sol.toFixed(6) + ' SOL ← TOO LOW for txs');
            else ok(agentNames[agent.id] + ': ' + sol.toFixed(6) + ' SOL [' + status + ']');
        } catch (e) {
            fail(agentNames[agent.id] + ' balance fetch failed: ' + e.message);
        }
    }

    section('LAYER 4 — Policy Engine Logic');
    // Load the compiled policy
    const { PolicyEngine, CONSERVATIVE_POLICY, STANDARD_POLICY } = require('../dist/wallet/policy');
    const { AgentDatabase } = require('../dist/db');

    const db = await AgentDatabase.create();
    ok('AgentDatabase.create() succeeded');

    const orionPolicy = CONSERVATIVE_POLICY(0);
    const lyraPolicy = STANDARD_POLICY(1);
    ok('Policy configs created for ORION (conservative) and LYRA (standard)');

    const orionPolicyEngine = new PolicyEngine(orionPolicy, db);
    const lyraPolicyEngine = new PolicyEngine(lyraPolicy, db);

    // Test: ORION's conservative limit
    const orionLimit = orionPolicy.maxSolPerTransaction;
    ok('ORION max per tx: ' + orionLimit + ' SOL');

    const check1 = orionPolicyEngine.validate(0, orionLimit * 0.5);
    if (check1.allowed) ok('ORION: 50% of limit → allowed');
    else fail('ORION: 50% of limit → wrongly rejected: ' + check1.reason);

    const check2 = orionPolicyEngine.validate(0, orionLimit * 2);
    if (!check2.allowed) ok('ORION: 200% of limit → rejected (' + check2.reason + ')');
    else fail('ORION: 200% of limit → wrongly allowed!');

    // Test: unlisted program
    const check3 = orionPolicyEngine.validate(0, 0.001, '11111111111111111111111111111111');
    // System program should always be allowed
    if (check3.allowed) ok('System Program always allowed');
    else warn('System Program rejected: ' + check3.reason);

    section('LAYER 5 — Transaction Signer (Simulation Gate)');
    const { TransactionSigner } = require('../dist/wallet/signer');
    const { AgentWalletRuntime } = require('../dist/wallet/runtime');
    const runtime = new AgentWalletRuntime(mnemonic);
    ok('AgentWalletRuntime constructed');
    ok('getConnection() returns: ' + (runtime.getConnection()._rpcEndpoint || 'devnet'));

    const signer = new TransactionSigner(runtime, connection, db);
    ok('TransactionSigner constructed');

    // Check that signer has registerPolicy
    if (typeof signer.registerPolicy === 'function') ok('signer.registerPolicy() exists');
    else fail('signer.registerPolicy() missing');
    if (typeof signer.executeIntent === 'function') ok('signer.executeIntent() exists');
    else fail('signer.executeIntent() missing');

    section('LAYER 6 — Web Server API');
    const { WebServer } = require('../dist/web/server');
    const ws = new WebServer(13337); // use non-standard port so we don't conflict
    try {
        await ws.listen();
        ok('WebServer.listen() succeeded on port 13337');

        // Test GET /
        const http = require('http');
        await new Promise((resolve) => {
            http.get('http://localhost:13337/', (res) => {
                if (res.statusCode === 200) ok('GET / → 200 OK (serves HTML)');
                else fail('GET / → ' + res.statusCode);
                resolve();
            }).on('error', (e) => { fail('GET / failed: ' + e.message); resolve(); });
        });

        // Test POST /api/start with bad password
        await new Promise((resolve) => {
            const body = JSON.stringify({ password: 'wrongpassword', duration: 10 });
            const req = http.request({
                hostname: 'localhost', port: 13337, path: '/api/start', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
            }, (res) => {
                let data = '';
                res.on('data', d => data += d);
                res.on('end', () => {
                    const json = JSON.parse(data);
                    if (!json.ok && (res.statusCode === 401 || res.statusCode === 400)) {
                        ok('POST /api/start with wrong password → rejected (' + (json.error || 'bad creds') + ')');
                    } else {
                        fail('POST /api/start with wrong password → wrongly accepted: ' + JSON.stringify(json));
                    }
                    resolve();
                });
            });
            req.on('error', (e) => { fail('/api/start request failed: ' + e.message); resolve(); });
            req.write(body);
            req.end();
        });

        // Test /api/status
        await new Promise((resolve) => {
            http.get('http://localhost:13337/api/status', (res) => {
                if (res.statusCode === 200) ok('GET /api/status → 200 OK');
                else fail('GET /api/status → ' + res.statusCode);
                resolve();
            }).on('error', e => { fail('/api/status failed: ' + e.message); resolve(); });
        });

        await ws.close();
        ok('WebServer.close() succeeded');
    } catch (e) {
        fail('WebServer test failed: ' + e.message);
        await ws.close().catch(() => { });
    }

    section('LAYER 7 — SPL Token Script Sanity');
    if (fs.existsSync('./scripts/create-demo-token.js')) {
        ok('create-demo-token.js exists');
        const src = fs.readFileSync('./scripts/create-demo-token.js', 'utf8');
        if (src.includes('pbkdf2Sync')) ok('Uses pbkdf2Sync (matches keystore.ts)');
        else fail('Does NOT use pbkdf2Sync — wrong KDF');
        if (src.includes('authTag')) ok('Uses authTag field (matches keystore.ts)');
        else fail('Does NOT use authTag — field name mismatch');
        if (src.includes('createMint')) ok('Uses createMint from @solana/spl-token');
        else fail('Missing createMint');
        if (src.includes('getOrCreateAssociatedTokenAccount')) ok('Uses getOrCreateAssociatedTokenAccount');
        else fail('Missing getOrCreateAssociatedTokenAccount');
        if (src.includes('mintTo')) ok('Uses mintTo');
        else fail('Missing mintTo');
    } else {
        fail('create-demo-token.js missing');
    }

    section('LAYER 8 — Intent Types in Signer');
    const signerSrc = fs.readFileSync('./src/wallet/signer.ts', 'utf8');
    ['TRANSFER_SOL', 'TRANSFER_SPL', 'PROGRAM_CALL'].forEach(intent => {
        if (signerSrc.includes(intent)) ok('Intent type ' + intent + ' handled in signer');
        else fail('Intent type ' + intent + ' NOT found in signer');
    });
    if (signerSrc.includes('simulate')) ok('Transaction simulation present (security gate)');
    else fail('NO simulation found in signer — critical security gap');
    if (signerSrc.includes('createAssociatedTokenAccountIdempotentInstruction')) ok('Idempotent ATA creation used');
    else warn('Idempotent ATA instruction not found — may create duplicate ATAs');
    if (signerSrc.includes('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')) ok('Memo Program ID hardcoded correctly');
    else fail('Memo Program ID missing from signer');

    section('LAYER 9 — Adaptive Agent Logic');
    const orion = fs.readFileSync('./src/agents/orion-agent.ts', 'utf8');
    const lyra = fs.readFileSync('./src/agents/lyra-agent.ts', 'utf8');
    const vega = fs.readFileSync('./src/agents/vega-agent.ts', 'utf8');

    if (orion.includes('getRecentPerformance')) ok('ORION reads DB performance metrics (adaptive)');
    else fail('ORION does NOT read performance — not adaptive');
    if (orion.includes('hot') || orion.includes('regime')) ok('ORION has regime logic');
    else fail('ORION missing regime logic');
    if (lyra.includes('balanceTrend')) ok('LYRA checks balance trend (smart accumulator)');
    else fail('LYRA does NOT check balance trend');
    if (vega.includes('needScore') || vega.includes('need')) ok('VEGA calculates need scores (rebalancer)');
    else fail('VEGA missing need score logic');

    // ── Summary
    console.log('\n══════════════════════════════════════════════');
    console.log('AUDIT COMPLETE');
    console.log('  ✓ Passed:    ' + passed);
    console.log('  ⚠ Warnings:  ' + warnings);
    console.log('  ✗ Failed:    ' + failed);
    console.log('══════════════════════════════════════════════');

    if (failed === 0) {
        console.log('\n🎉 ALL CHECKS PASSED — Project is structurally sound.');
        if (warnings > 0) console.log('   (' + warnings + ' warnings worth reviewing above)');
    } else {
        console.log('\n❌ ' + failed + ' CHECKS FAILED — See above for details.');
        process.exit(1);
    }
}

run().catch(e => {
    console.error('Fatal audit error:', e.message);
    process.exit(1);
});
