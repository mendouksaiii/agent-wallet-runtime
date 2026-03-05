/**
 * Jupiter DEX Integration
 *
 * Wraps the Jupiter v6 Quote + Swap API to produce a signed-ready
 * Solana transaction that the TransactionSigner can simulate and broadcast.
 *
 * Works on both devnet (limited liquidity) and mainnet.
 *
 * Devnet note: Jupiter's devnet endpoint has sparse liquidity.
 * For reliable swaps use mainnet-beta with small amounts (0.001 SOL+).
 *
 * Docs: https://station.jup.ag/docs/apis/swap-api
 */

import { Transaction, VersionedTransaction, PublicKey } from '@solana/web3.js';

/** Well-known token mints on Solana */
export const MINTS = {
    SOL: 'So11111111111111111111111111111111111111112',  // Wrapped SOL
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (mainnet)
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT (mainnet)
} as const;

/** Response from Jupiter /v6/quote */
export interface JupiterQuote {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    priceImpactPct: string;
    routePlan: unknown[];
    [key: string]: unknown;
}

/** Parameters for a Jupiter swap */
export interface SwapParams {
    inputMint: string;
    outputMint: string;
    /** Amount in lamports (for SOL) or smallest token unit */
    amountLamports: number;
    /** Max slippage in basis points (100 = 1%) */
    slippageBps?: number;
    /** Wallet public key that will sign */
    userPublicKey: string;
    /** Use mainnet endpoint (default) or devnet */
    cluster?: 'mainnet-beta' | 'devnet';
}

const JUPITER_API: Record<string, string> = {
    'mainnet-beta': 'https://quote-api.jup.ag/v6',
    'devnet': 'https://quote-api.jup.ag/v6', // same endpoint, devnet liquidity is sparse
};

/**
 * Fetches an optimised swap quote from Jupiter.
 *
 * @throws Error if Jupiter returns no routes or the request fails.
 */
export async function getQuote(params: SwapParams): Promise<JupiterQuote> {
    const base = JUPITER_API[params.cluster ?? 'mainnet-beta'];
    const url = new URL(`${base}/quote`);
    url.searchParams.set('inputMint', params.inputMint);
    url.searchParams.set('outputMint', params.outputMint);
    url.searchParams.set('amount', String(params.amountLamports));
    url.searchParams.set('slippageBps', String(params.slippageBps ?? 50));

    const res = await fetch(url.toString());
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Jupiter quote failed (${res.status}): ${text}`);
    }

    const quote = await res.json() as JupiterQuote;
    if (!quote || !quote.outAmount) {
        throw new Error('Jupiter returned no route — insufficient devnet liquidity');
    }

    return quote;
}

/**
 * Fetches a swap transaction from Jupiter and deserialises it into a
 * Solana `Transaction` that the wallet runtime can simulate + sign.
 *
 * @returns A legacy Transaction OR VersionedTransaction depending on Jupiter's response.
 */
export async function buildSwapTransaction(
    quote: JupiterQuote,
    userPublicKey: string,
): Promise<Transaction | VersionedTransaction> {
    const body = {
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,   // auto wrap/unwrap native SOL
        dynamicComputeUnitLimit: true,   // Jupiter optimises CU
        prioritizationFeeLamports: 'auto' as const,
    };

    const res = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Jupiter swap failed (${res.status}): ${text}`);
    }

    const { swapTransaction } = await res.json() as { swapTransaction: string };
    const raw = Buffer.from(swapTransaction, 'base64');

    // Jupiter v6 returns versioned transactions by default
    try {
        return VersionedTransaction.deserialize(raw);
    } catch {
        // Fall back to legacy transaction format
        return Transaction.from(raw);
    }
}

/**
 * Human-readable swap summary for logs/dashboard.
 */
export function swapSummary(quote: JupiterQuote): string {
    const impact = parseFloat(quote.priceImpactPct).toFixed(4);
    return (
        `${Number(quote.inAmount).toLocaleString()} ${quote.inputMint.slice(0, 6)}.. ` +
        `→ ${Number(quote.outAmount).toLocaleString()} ${quote.outputMint.slice(0, 6)}.. ` +
        `(impact: ${impact}%)`
    );
}
