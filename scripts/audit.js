const fs = require('fs');

// ── LAYER 1: Source files
const srcFiles = [
    'src/wallet/keystore.ts',
    'src/wallet/runtime.ts',
    'src/wallet/policy.ts',
    'src/wallet/signer.ts',
    'src/agents/alpha-agent.ts',
    'src/agents/beta-agent.ts',
    'src/agents/gamma-agent.ts',
    'src/agents/base-agent.ts',
    'src/simulation/orchestrator.ts',
    'src/db/index.ts',
    'src/logger/index.ts',
    'src/cli/index.ts',
    'src/ui/dashboard.ts',
    'src/web/server.ts',
];

// ── LAYER 2: Compiled output
const distFiles = [
    'dist/cli/index.js',
    'dist/wallet/keystore.js',
    'dist/wallet/runtime.js',
    'dist/wallet/signer.js',
    'dist/wallet/policy.js',
    'dist/agents/alpha-agent.js',
    'dist/agents/beta-agent.js',
    'dist/agents/gamma-agent.js',
    'dist/simulation/orchestrator.js',
    'dist/db/index.js',
    'dist/web/server.js',
];

// ── LAYER 3: Runtime artifacts
const runtimeFiles = [
    'public/index.html',
    'keystore.enc',
    'scripts/create-demo-token.js',
    'scripts/dashboard-recording.html',
    'DEEP_DIVE.md',
    'README.md',
    'SKILLS.md',
];

let passed = 0, failed = 0;

function check(label, files) {
    console.log('\n── ' + label);
    files.forEach(f => {
        try {
            const s = fs.statSync(f);
            console.log('  ✓ ' + f + ' (' + s.size + 'b)');
            passed++;
        } catch {
            console.log('  ✗ MISSING: ' + f);
            failed++;
        }
    });
}

check('Source files', srcFiles);
check('Compiled dist', distFiles);
check('Runtime artifacts', runtimeFiles);

console.log('\n── Package.json scripts');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const requiredScripts = ['build', 'test', 'dev', 'dev:web', 'web'];
requiredScripts.forEach(s => {
    if (pkg.scripts[s]) {
        console.log('  ✓ npm run ' + s + ' → ' + pkg.scripts[s]);
        passed++;
    } else {
        console.log('  ✗ MISSING script: ' + s);
        failed++;
    }
});

console.log('\n── Dependencies');
const required = ['@solana/web3.js', '@solana/spl-token', 'bip39', 'ed25519-hd-key', 'sql.js', 'winston', 'commander', 'dotenv'];
required.forEach(d => {
    if (pkg.dependencies[d]) {
        console.log('  ✓ ' + d + '@' + pkg.dependencies[d]);
        passed++;
    } else {
        console.log('  ✗ MISSING dep: ' + d);
        failed++;
    }
});

console.log('\n── Keystore content check');
try {
    const ks = JSON.parse(fs.readFileSync('keystore.enc', 'utf8'));
    const fields = ['salt', 'iv', 'authTag', 'ciphertext'];
    fields.forEach(f => {
        if (ks[f] && typeof ks[f] === 'string' && ks[f].length > 0) {
            console.log('  ✓ keystore.' + f + ' present (' + ks[f].length + ' hex chars)');
            passed++;
        } else {
            console.log('  ✗ keystore.' + f + ' missing or empty');
            failed++;
        }
    });
} catch (e) {
    console.log('  ✗ Could not read keystore: ' + e.message);
    failed++;
}

console.log('\n══════════════════════════════');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
