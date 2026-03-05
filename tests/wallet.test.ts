import * as bip39 from 'bip39';
import { AgentWalletRuntime } from '../src/wallet/runtime';
import { saveMnemonic, loadMnemonic, generateAndSave, KeystoreError } from '../src/wallet/keystore';
import path from 'path';
import fs from 'fs';
import os from 'os';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('AgentWalletRuntime', () => {
    let runtime: AgentWalletRuntime;

    beforeAll(() => {
        runtime = new AgentWalletRuntime(TEST_MNEMONIC);
    });

    test('HD derivation is deterministic — same agentId always returns same public key', () => {
        const key1 = runtime.getPublicKey(0);
        const key2 = runtime.getPublicKey(0);
        const key3 = runtime.getPublicKey(0);

        expect(key1).toBe(key2);
        expect(key2).toBe(key3);
        expect(typeof key1).toBe('string');
        expect(key1.length).toBeGreaterThan(30); // base58 Solana keys are ~43 chars
    });

    test('different agentIds produce different keypairs', () => {
        const key0 = runtime.getPublicKey(0);
        const key1 = runtime.getPublicKey(1);
        const key2 = runtime.getPublicKey(2);

        expect(key0).not.toBe(key1);
        expect(key1).not.toBe(key2);
        expect(key0).not.toBe(key2);
    });

    test('listDerivedAgents returns correct count with proper structure', () => {
        const agents = runtime.listDerivedAgents(3);

        expect(agents).toHaveLength(3);

        for (let i = 0; i < 3; i++) {
            expect(agents[i].agentId).toBe(i);
            expect(agents[i].publicKey).toBe(runtime.getPublicKey(i));
            expect(agents[i].derivationPath).toBe(`m/44'/501'/${i}'/0'`);
        }
    });

    test('constructor rejects invalid mnemonic', () => {
        expect(() => new AgentWalletRuntime('invalid words here')).toThrow();
    });

    test('same mnemonic always produces same runtime state', () => {
        const runtime2 = new AgentWalletRuntime(TEST_MNEMONIC);

        expect(runtime.getPublicKey(0)).toBe(runtime2.getPublicKey(0));
        expect(runtime.getPublicKey(1)).toBe(runtime2.getPublicKey(1));
        expect(runtime.getPublicKey(2)).toBe(runtime2.getPublicKey(2));
    });
});

describe('Keystore', () => {
    const tmpDir = path.join(os.tmpdir(), `agent-wallet-test-${Date.now()}`);
    const keystorePath = path.join(tmpDir, 'test-keystore.enc');
    const password = 'testpassword123';

    beforeAll(() => {
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }
    });

    afterAll(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Cleanup best-effort
        }
    });

    test('encrypt → decrypt round-trip recovers original mnemonic', () => {
        const mnemonic = bip39.generateMnemonic(128);

        saveMnemonic(mnemonic, password, keystorePath);

        const recovered = loadMnemonic(password, keystorePath);
        expect(recovered).toBe(mnemonic);
    });

    test('wrong password throws KeystoreError, not returns null', () => {
        const mnemonic = bip39.generateMnemonic(128);
        const path2 = path.join(tmpDir, 'test-keystore-2.enc');

        saveMnemonic(mnemonic, password, path2);

        expect(() => loadMnemonic('wrongpassword!', path2)).toThrow(KeystoreError);
        expect(() => loadMnemonic('wrongpassword!', path2)).toThrow('Decryption failed');
    });

    test('loading non-existent file throws KeystoreError', () => {
        expect(() => loadMnemonic(password, '/nonexistent/path.enc')).toThrow(KeystoreError);
        expect(() => loadMnemonic(password, '/nonexistent/path.enc')).toThrow('not found');
    });

    test('generateAndSave creates valid mnemonic and saves it', () => {
        const path3 = path.join(tmpDir, 'test-keystore-3.enc');

        const mnemonic = generateAndSave(password, path3);

        expect(bip39.validateMnemonic(mnemonic)).toBe(true);
        expect(fs.existsSync(path3)).toBe(true);

        const recovered = loadMnemonic(password, path3);
        expect(recovered).toBe(mnemonic);
    });

    test('saveMnemonic rejects invalid mnemonic', () => {
        const path4 = path.join(tmpDir, 'test-keystore-4.enc');
        expect(() => saveMnemonic('not a valid mnemonic', password, path4)).toThrow(KeystoreError);
    });
});
