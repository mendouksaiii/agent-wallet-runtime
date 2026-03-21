/**
 * Compile + Deploy AgentReceiptRegistry to Base Sepolia in one script.
 * Uses solc-js for in-process compilation, ethers for deployment.
 * 
 * Usage: node scripts/compile-deploy.js
 */
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Inline the Solidity source to avoid solc path resolution issues
const SOLIDITY_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

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
    mapping(uint256 => uint256[]) public agentReceipts;

    event ReceiptRecorded(uint256 indexed agentId, uint256 receiptId, string actionType, address indexed submitter);

    function recordReceipt(uint256 agentId, string memory actionType, string memory receiptData) external returns (uint256 receiptId) {
        receiptId = receiptCount++;
        receipts[receiptId] = Receipt({ agentId: agentId, actionType: actionType, receiptData: receiptData, submitter: msg.sender, timestamp: block.timestamp });
        agentReceipts[agentId].push(receiptId);
        emit ReceiptRecorded(agentId, receiptId, actionType, msg.sender);
    }

    function getAgentReceiptCount(uint256 agentId) external view returns (uint256) {
        return agentReceipts[agentId].length;
    }

    function getReceipt(uint256 receiptId) external view returns (uint256 agentId, string memory actionType, string memory receiptData, address submitter, uint256 timestamp) {
        Receipt memory r = receipts[receiptId];
        return (r.agentId, r.actionType, r.receiptData, r.submitter, r.timestamp);
    }
}
`;

async function main() {
    // Step 1: Compile using solc-js
    console.log('--- Compiling AgentReceiptRegistry ---');
    let solc;
    try {
        solc = require('solc');
    } catch {
        console.log('solc not found, installing...');
        require('child_process').execSync('npm install solc@0.8.28', { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
        solc = require('solc');
    }

    const input = {
        language: 'Solidity',
        sources: { 'AgentReceiptRegistry.sol': { content: SOLIDITY_SOURCE } },
        settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
    };

    const output = JSON.parse(solc.compile(JSON.stringify(input)));
    
    if (output.errors) {
        const errs = output.errors.filter(e => e.severity === 'error');
        if (errs.length > 0) {
            console.error('Compilation errors:', errs.map(e => e.message).join('\n'));
            process.exit(1);
        }
    }

    const compiled = output.contracts['AgentReceiptRegistry.sol']['AgentReceiptRegistry'];
    const abi = compiled.abi;
    const bytecode = '0x' + compiled.evm.bytecode.object;
    console.log('✅ Compiled successfully. Bytecode size:', bytecode.length / 2, 'bytes');

    // Step 2: Connect to Ethereum Sepolia
    const RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // Load deployer wallet from env var or .env.deployer file
    let privateKey = process.env.DEPLOYER_PRIVATE_KEY;
    if (!privateKey) {
        const envPath = path.resolve(__dirname, '..', '.env.deployer');
        if (fs.existsSync(envPath)) {
            const envContent = fs.readFileSync(envPath, 'utf-8');
            const match = envContent.match(/DEPLOYER_PRIVATE_KEY=(.*)/);
            if (match) privateKey = match[1].trim();
        }
    }

    let wallet;
    if (privateKey) {
        wallet = new ethers.Wallet(privateKey, provider);
    } else {
        wallet = ethers.Wallet.createRandom().connect(provider);
        console.log('\n⚠️  Generated fresh deployer wallet.');
        console.log('Address:', wallet.address);
        const envPath = path.resolve(__dirname, '..', '.env.deployer');
        fs.writeFileSync(envPath, `DEPLOYER_PRIVATE_KEY=${wallet.privateKey}\nDEPLOYER_ADDRESS=${wallet.address}\n`);
        console.log('Saved to .env.deployer. Fund it and re-run.');
        return;
    }

    console.log('\nDeployer:', wallet.address);
    const balance = await provider.getBalance(wallet.address);
    console.log('Balance:', ethers.formatEther(balance), 'ETH');

    if (balance === 0n) {
        console.log('❌ No ETH. Fund the wallet and retry.');
        process.exit(1);
    }

    // Step 3: Deploy
    console.log('\n--- Deploying to Base Sepolia ---');
    const factory = new ethers.ContractFactory(abi, bytecode, wallet);
    const contract = await factory.deploy();
    await contract.waitForDeployment();

    const address = await contract.getAddress();
    console.log('✅ Deployed!');
    console.log('Contract:', address);
    console.log('Explorer: https://sepolia.etherscan.io/address/' + address);

    // Step 4: Submit a test receipt
    console.log('\n--- Submitting test receipt ---');
    const tx = await contract.recordReceipt(
        1,
        'TRANSFER_SOL',
        JSON.stringify({
            solanaTx: 'deployment-verification-receipt',
            amount: 0.001,
            timestamp: new Date().toISOString(),
            note: 'Verification receipt from Agent Wallet Runtime deployment'
        })
    );
    const receipt = await tx.wait();
    console.log('✅ Receipt submitted!');
    console.log('Tx:', receipt.hash);
    console.log('Explorer: https://sepolia.etherscan.io/tx/' + receipt.hash);

    // Step 5: Save the deployed address
    const envSynthPath = path.resolve(__dirname, '..', '.env.synthesis');
    fs.appendFileSync(envSynthPath, `\nERC8004_REGISTRY_ADDRESS=${address}\nBASE_SEPOLIA_RPC=${RPC_URL}\n`);
    console.log('\n=== DONE ===');
    console.log('Updated .env.synthesis with ERC8004_REGISTRY_ADDRESS=' + address);
    
    // Also save the ABI for reference
    fs.writeFileSync(path.resolve(__dirname, '..', 'contracts', 'AgentReceiptRegistry.json'), JSON.stringify({ abi, address }, null, 2));
    console.log('Saved ABI to contracts/AgentReceiptRegistry.json');
}

main().catch(console.error);
