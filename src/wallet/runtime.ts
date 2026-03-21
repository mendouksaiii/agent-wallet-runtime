import {
    Connection,
    Keypair,
    clusterApiUrl,
    LAMPORTS_PER_SOL,
    PublicKey,
    Transaction,
    sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    getAccount,
    TokenAccountNotFoundError,
    TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import { ethers } from 'ethers';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { createSystemLogger } from '../logger';

/**
 * Custom error for wallet runtime operations.
 */
export class WalletRuntimeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WalletRuntimeError';
    }
}

/**
 * Derived agent information.
 */
export interface DerivedAgent {
    agentId: number;
    publicKey: string;
    derivationPath: string;
}

const logger = createSystemLogger();

/**
 * HD wallet runtime for autonomous AI agents on Solana.
 * Derives deterministic keypairs from a BIP39 mnemonic using BIP44 derivation paths.
 * Private keys never leave this class — agents interact through intents only.
 */
export class AgentWalletRuntime {
    private readonly seed: Buffer;
    private readonly mnemonicString: string;
    private readonly derivedKeypairs: Map<number, Keypair> = new Map();
    private readonly derivedEvmWallets: Map<number, ethers.HDNodeWallet> = new Map();
    private readonly connection: Connection;
    private readonly evmProvider: ethers.JsonRpcProvider;

    /**
     * Creates a new wallet runtime from a BIP39 mnemonic.
     *
     * @param mnemonic - BIP39 mnemonic phrase (12 or 24 words)
     * @param rpcUrl - Solana RPC endpoint URL (defaults to devnet)
     */
    constructor(mnemonic: string, rpcUrl?: string) {
        if (!bip39.validateMnemonic(mnemonic)) {
            throw new WalletRuntimeError('Invalid BIP39 mnemonic provided to wallet runtime');
        }

        this.seed = bip39.mnemonicToSeedSync(mnemonic);
        this.mnemonicString = mnemonic;
        this.connection = new Connection(
            rpcUrl || process.env.SOLANA_RPC_URL || clusterApiUrl('devnet'),
            'confirmed'
        );
        this.evmProvider = new ethers.JsonRpcProvider(
            process.env.EVM_RPC_URL || 'https://api.calibration.node.glif.io/rpc/v1'
        );
    }

    /**
     * Returns the EVM RPC provider instance.
     *
     * @returns JsonRpcProvider instance
     */
    getEvmProvider(): ethers.JsonRpcProvider {
        return this.evmProvider;
    }

    /**
     * Returns the Solana RPC connection instance.
     *
     * @returns Connection instance for devnet
     */
    getConnection(): Connection {
        return this.connection;
    }

    /**
     * Derives a deterministic keypair for a given agent ID.
     * Uses BIP44 path: m/44'/501'/{agentId}'/0'
     * Caches derived keypairs in memory for reuse.
     *
     * @param agentId - Numeric agent identifier (0–4294967295)
     * @returns Solana Keypair (used internally, never exposed outside runtime)
     */
    deriveAgentKeypair(agentId: number): Keypair {
        const cached = this.derivedKeypairs.get(agentId);
        if (cached) {
            return cached;
        }

        const path = `m/44'/501'/${agentId}'/0'`;
        const derived = derivePath(path, this.seed.toString('hex'));
        const keypair = Keypair.fromSeed(derived.key);

        this.derivedKeypairs.set(agentId, keypair);
        return keypair;
    }

    /**
     * Returns the base58-encoded public key for a given agent ID.
     *
     * @param agentId - Numeric agent identifier
     * @returns Base58-encoded Solana public key string
     */
    getPublicKey(agentId: number): string {
        const keypair = this.deriveAgentKeypair(agentId);
        return keypair.publicKey.toBase58();
    }

    /**
     * Derives a deterministic EVM wallet for a given agent ID.
     * Uses BIP44 path: m/44'/60'/0'/0/{agentId}
     * Caches derived wallets in memory for reuse.
     *
     * @param agentId - Numeric agent identifier
     * @returns ethers.HDNodeWallet 
     */
    deriveEvmWallet(agentId: number): ethers.HDNodeWallet {
        const cached = this.derivedEvmWallets.get(agentId);
        if (cached) {
            return cached;
        }

        const hdNode = ethers.HDNodeWallet.fromMnemonic(
            ethers.Mnemonic.fromPhrase(this.mnemonicString)
        );
        const derived = hdNode.derivePath(`m/44'/60'/0'/0/${agentId}`);
        const walletWithProvider = derived.connect(this.evmProvider);

        this.derivedEvmWallets.set(agentId, walletWithProvider as ethers.HDNodeWallet);
        return walletWithProvider as ethers.HDNodeWallet;
    }

    /**
     * Returns the hex-encoded EVM address for a given agent ID.
     *
     * @param agentId - Numeric agent identifier
     * @returns Hexadecimal Ethereum address string
     */
    getEvmAddress(agentId: number): string {
        const wallet = this.deriveEvmWallet(agentId);
        return wallet.address;
    }

    /**
     * Lists derived agent information for the first `count` agents.
     *
     * @param count - Number of agents to derive and list
     * @returns Array of derived agent info (agentId, publicKey, derivationPath)
     */
    listDerivedAgents(count: number): DerivedAgent[] {
        const agents: DerivedAgent[] = [];

        for (let i = 0; i < count; i++) {
            agents.push({
                agentId: i,
                publicKey: this.getPublicKey(i),
                derivationPath: `m/44'/501'/${i}'/0'`,
            });
        }

        return agents;
    }

    /**
     * Checks the SOL balance of an agent and requests airdrop from devnet faucet if below threshold.
     * Implements exponential backoff retry (max 3 attempts).
     *
     * @param agentId - Numeric agent identifier
     * @param minBalanceSol - Minimum SOL balance threshold (airdrop if below this)
     */
    async airdropIfNeeded(agentId: number, minBalanceSol: number): Promise<void> {
        const keypair = this.deriveAgentKeypair(agentId);
        const publicKey = keypair.publicKey;

        try {
            const balance = await this.connection.getBalance(publicKey);
            const currentSol = balance / LAMPORTS_PER_SOL;

            logger.info(`Agent ${agentId} balance: ${currentSol.toFixed(4)} SOL`, {
                event: 'BALANCE_CHECK',
                data: { agentId, balance: currentSol, threshold: minBalanceSol },
            });

            if (currentSol >= minBalanceSol) {
                logger.info(`Agent ${agentId} has sufficient balance, skipping airdrop`, {
                    event: 'AIRDROP_SKIPPED',
                    data: { agentId, balance: currentSol },
                });
                return;
            }

            const airdropAmount = 0.5 * LAMPORTS_PER_SOL;
            let lastError: Error | undefined;

            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    logger.info(`Requesting airdrop for agent ${agentId} (attempt ${attempt}/3)`, {
                        event: 'AIRDROP_REQUEST',
                        data: { agentId, attempt, amountSol: 0.5 },
                    });

                    const signature = await this.connection.requestAirdrop(publicKey, airdropAmount);
                    await this.connection.confirmTransaction(signature, 'confirmed');

                    const newBalance = await this.connection.getBalance(publicKey);
                    logger.info(`Airdrop confirmed for agent ${agentId}: ${(newBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`, {
                        event: 'AIRDROP_CONFIRMED',
                        data: {
                            agentId,
                            signature,
                            newBalance: newBalance / LAMPORTS_PER_SOL,
                        },
                    });
                    return;
                } catch (err) {
                    lastError = err instanceof Error ? err : new Error(String(err));
                    const backoffMs = Math.pow(2, attempt) * 1000;

                    logger.warn(`Airdrop attempt ${attempt} failed for agent ${agentId}, retrying in ${backoffMs}ms`, {
                        event: 'AIRDROP_RETRY',
                        data: { agentId, attempt, backoffMs, error: lastError.message },
                    });

                    await new Promise((resolve) => setTimeout(resolve, backoffMs));
                }
            }

            throw new WalletRuntimeError(
                `Failed to airdrop to agent ${agentId} after 3 attempts: ${lastError?.message}`
            );
        } catch (err) {
            if (err instanceof WalletRuntimeError) {
                throw err;
            }
            throw new WalletRuntimeError(
                `Airdrop check failed for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`
            );
        }
    }

    /**
     * Gets or creates an Associated Token Account (ATA) for a given agent and SPL mint.
     * If the ATA doesn't exist on-chain, creates it as a transaction signed by the agent.
     *
     * @param agentId - Agent whose ATA to derive
     * @param mintAddress - SPL token mint address (base58)
     * @returns The ATA's public key (base58 string)
     */
    async getOrCreateATA(agentId: number, mintAddress: string): Promise<string> {
        const keypair = this.deriveAgentKeypair(agentId);
        const mint = new PublicKey(mintAddress);

        const ata = await getAssociatedTokenAddress(mint, keypair.publicKey);

        // Check if ATA already exists
        try {
            await getAccount(this.connection, ata);
            logger.info(`ATA exists for agent ${agentId}, mint ${mintAddress}`, {
                event: 'ATA_EXISTS',
                data: { agentId, mintAddress, ata: ata.toBase58() },
            });
            return ata.toBase58();
        } catch (err) {
            if (!(err instanceof TokenAccountNotFoundError) &&
                !(err instanceof TokenInvalidAccountOwnerError)) {
                throw err;
            }
        }

        // ATA does not exist — create it
        logger.info(`Creating ATA for agent ${agentId}, mint ${mintAddress}`, {
            event: 'ATA_CREATING',
            data: { agentId, mintAddress, ata: ata.toBase58() },
        });

        const tx = new Transaction().add(
            createAssociatedTokenAccountInstruction(
                keypair.publicKey,  // payer
                ata,                // ATA address
                keypair.publicKey,  // owner
                mint                // mint
            )
        );

        const sig = await sendAndConfirmTransaction(this.connection, tx, [keypair]);

        logger.info(`ATA created for agent ${agentId}: ${ata.toBase58()}`, {
            event: 'ATA_CREATED',
            data: { agentId, mintAddress, ata: ata.toBase58(), signature: sig },
        });

        return ata.toBase58();
    }

    /**
     * Returns the SPL token balance for a given agent and mint.
     * Returns 0 if the ATA does not exist.
     *
     * @param agentId - Agent to check
     * @param mintAddress - SPL token mint address (base58)
     * @returns Token balance as a number (adjusted for decimals)
     */
    async getTokenBalance(agentId: number, mintAddress: string): Promise<number> {
        const keypair = this.deriveAgentKeypair(agentId);
        const mint = new PublicKey(mintAddress);
        const ata = await getAssociatedTokenAddress(mint, keypair.publicKey);

        try {
            const account = await getAccount(this.connection, ata);
            // account.amount is a bigint of the raw token units
            return Number(account.amount);
        } catch (err) {
            if (err instanceof TokenAccountNotFoundError ||
                err instanceof TokenInvalidAccountOwnerError) {
                return 0;
            }
            throw err;
        }
    }
}
