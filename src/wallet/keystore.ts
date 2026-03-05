import crypto from 'crypto';
import fs from 'fs';
import * as bip39 from 'bip39';

/**
 * Custom error for keystore operations.
 */
export class KeystoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'KeystoreError';
    }
}

/**
 * Encrypted keystore file format.
 * All fields are hex-encoded strings.
 */
interface KeystoreFile {
    salt: string;
    iv: string;
    authTag: string;
    ciphertext: string;
}

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for GCM
const SALT_LENGTH = 32;
const DIGEST = 'sha512';

/**
 * Derives an AES-256 encryption key from a password using PBKDF2.
 *
 * @param password - User-supplied password
 * @param salt - Random salt buffer
 * @returns 32-byte derived key
 */
function deriveKey(password: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);
}

/**
 * Encrypts and saves a BIP39 mnemonic to disk using AES-256-GCM.
 * Key is derived from the password via PBKDF2 (SHA-512, 100k iterations).
 *
 * @param mnemonic - BIP39 mnemonic phrase to encrypt
 * @param password - Password for key derivation
 * @param filePath - Output file path for the encrypted keystore
 * @throws KeystoreError if the mnemonic is invalid or write fails
 */
export function saveMnemonic(mnemonic: string, password: string, filePath: string): void {
    if (!bip39.validateMnemonic(mnemonic)) {
        throw new KeystoreError('Invalid BIP39 mnemonic provided');
    }

    if (!password || password.length < 8) {
        throw new KeystoreError('Password must be at least 8 characters');
    }

    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = deriveKey(password, salt);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
        cipher.update(mnemonic, 'utf8'),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    const keystoreData: KeystoreFile = {
        salt: salt.toString('hex'),
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        ciphertext: encrypted.toString('hex'),
    };

    const dir = require('path').dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, JSON.stringify(keystoreData, null, 2), 'utf8');
}

/**
 * Loads and decrypts a BIP39 mnemonic from an encrypted keystore file.
 *
 * @param password - Password used during encryption
 * @param filePath - Path to the encrypted keystore file
 * @returns Decrypted BIP39 mnemonic string
 * @throws KeystoreError if file doesn't exist, password is wrong, or decryption fails
 */
export function loadMnemonic(password: string, filePath: string): string {
    if (!fs.existsSync(filePath)) {
        throw new KeystoreError(
            `Keystore file not found at "${filePath}". Run "agent-wallet init" first.`
        );
    }

    let keystoreData: KeystoreFile;
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        keystoreData = JSON.parse(raw) as KeystoreFile;
    } catch {
        throw new KeystoreError('Failed to read or parse keystore file. File may be corrupted.');
    }

    if (!keystoreData.salt || !keystoreData.iv || !keystoreData.authTag || !keystoreData.ciphertext) {
        throw new KeystoreError('Keystore file is malformed: missing required fields.');
    }

    const salt = Buffer.from(keystoreData.salt, 'hex');
    const iv = Buffer.from(keystoreData.iv, 'hex');
    const authTag = Buffer.from(keystoreData.authTag, 'hex');
    const ciphertext = Buffer.from(keystoreData.ciphertext, 'hex');
    const key = deriveKey(password, salt);

    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
        ]);
        return decrypted.toString('utf8');
    } catch {
        throw new KeystoreError(
            'Decryption failed. Wrong password or corrupted keystore. No partial data exposed.'
        );
    }
}

/**
 * Generates a fresh BIP39 mnemonic, encrypts, and saves it to disk.
 *
 * @param password - Password for key derivation
 * @param filePath - Output file path for the encrypted keystore
 * @returns The generated BIP39 mnemonic (display once, then discard)
 */
export function generateAndSave(password: string, filePath: string): string {
    const mnemonic = bip39.generateMnemonic(128); // 12-word mnemonic
    saveMnemonic(mnemonic, password, filePath);
    return mnemonic;
}
