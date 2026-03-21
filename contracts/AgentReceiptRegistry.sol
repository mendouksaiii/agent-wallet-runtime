// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AgentReceiptRegistry
 * @notice A minimal ERC-8004-compatible Validation Registry for AI agent receipts.
 * @dev Stores receipts of agent work on-chain. Each receipt records what an agent did,
 *      with a reference to the source chain transaction.
 */
contract AgentReceiptRegistry {

    struct Receipt {
        uint256 agentId;
        string actionType;
        string receiptData;
        address submitter;
        uint256 timestamp;
    }

    uint256 public receiptCount;
    mapping(uint256 => Receipt) public receipts;
    mapping(uint256 => uint256[]) public agentReceipts; // agentId => receiptIds

    event ReceiptRecorded(
        uint256 indexed agentId,
        uint256 receiptId,
        string actionType,
        address indexed submitter
    );

    /**
     * @notice Record a receipt of agent work.
     * @param agentId The numeric ID of the agent
     * @param actionType The type of action (e.g., "TRANSFER_SOL", "SWAP")
     * @param receiptData JSON string or IPFS hash of detailed execution data
     * @return receiptId The ID of the newly created receipt
     */
    function recordReceipt(
        uint256 agentId,
        string memory actionType,
        string memory receiptData
    ) external returns (uint256 receiptId) {
        receiptId = receiptCount++;
        
        receipts[receiptId] = Receipt({
            agentId: agentId,
            actionType: actionType,
            receiptData: receiptData,
            submitter: msg.sender,
            timestamp: block.timestamp
        });

        agentReceipts[agentId].push(receiptId);

        emit ReceiptRecorded(agentId, receiptId, actionType, msg.sender);
    }

    /**
     * @notice Get the number of receipts for an agent.
     */
    function getAgentReceiptCount(uint256 agentId) external view returns (uint256) {
        return agentReceipts[agentId].length;
    }

    /**
     * @notice Get a specific receipt by ID.
     */
    function getReceipt(uint256 receiptId) external view returns (
        uint256 agentId,
        string memory actionType,
        string memory receiptData,
        address submitter,
        uint256 timestamp
    ) {
        Receipt memory r = receipts[receiptId];
        return (r.agentId, r.actionType, r.receiptData, r.submitter, r.timestamp);
    }
}
