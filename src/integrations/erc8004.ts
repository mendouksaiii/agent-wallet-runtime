import { ethers } from 'ethers';
import { createSystemLogger } from '../logger';

const logger = createSystemLogger();

// Minimal ABI for an ERC-8004 Validation Registry
const ERC8004_REGISTRY_ABI = [
    "function recordReceipt(uint256 agentId, string memory actionType, string memory receiptData) external returns (uint256 receiptId)",
    "event ReceiptRecorded(uint256 indexed agentId, uint256 receiptId, string actionType)"
];

// Deployed on Ethereum Sepolia — verified on etherscan
// https://sepolia.etherscan.io/address/0xEe467b25DA5182D9b035f48596b8f17521c70011
const DEFAULT_REGISTRY_ADDRESS = '0xEe467b25DA5182D9b035f48596b8f17521c70011';

export class Erc8004Client {
    private registryContract: ethers.Contract;

    constructor(wallet: ethers.HDNodeWallet) {
        const address = process.env.ERC8004_REGISTRY_ADDRESS || DEFAULT_REGISTRY_ADDRESS;
        this.registryContract = new ethers.Contract(address, ERC8004_REGISTRY_ABI, wallet);
    }

    /**
     * Submits a receipt of work to the ERC-8004 Validation Registry.
     * 
     * @param agentId - The ID of the agent performing the work
     * @param actionType - The type of intent or action completed (e.g., 'SWAP', 'LOAN_REQUEST')
     * @param receiptData - JSON string or IPFS hash detailing the exact execution
     * @returns The EVM transaction hash of the receipt submission
     */
    async recordReceipt(agentId: number, actionType: string, receiptData: string): Promise<string> {
        try {
            logger.info(`Submitting ERC-8004 receipt for agent ${agentId}`, {
                event: 'ERC8004_RECEIPT_SUBMITTING',
                data: { agentId, actionType }
            });

            const tx = await this.registryContract.recordReceipt(agentId, actionType, receiptData);
            
            logger.info(`ERC-8004 receipt tx sent. Hash: ${tx.hash}`, {
                event: 'ERC8004_RECEIPT_SENT',
                data: { agentId, txHash: tx.hash }
            });

            await tx.wait(1); // Wait for 1 confirmation

            logger.info(`ERC-8004 receipt confirmed!`, {
                event: 'ERC8004_RECEIPT_CONFIRMED',
                data: { agentId, txHash: tx.hash }
            });

            return tx.hash;
        } catch (error) {
            logger.error(`Failed to submit ERC-8004 receipt`, {
                event: 'ERC8004_RECEIPT_ERROR',
                data: { agentId, error: error instanceof Error ? error.message : String(error) }
            });
            throw error;
        }
    }
}
