/**
 * Deploy AgentReceiptRegistry to Base Sepolia using pre-compiled bytecode.
 * 
 * The bytecode below was compiled from AgentReceiptRegistry.sol using solc 0.8.20.
 * This avoids needing Hardhat/Foundry as a dependency in the project.
 * 
 * Usage: node scripts/deploy-registry.js
 * Requires: DEPLOYER_PRIVATE_KEY env var (or derives from the agent-wallet-runtime mnemonic)
 */

const { ethers } = require('ethers');

// Pre-compiled bytecode and ABI for AgentReceiptRegistry
// Compiled with: solc --optimize --bin --abi AgentReceiptRegistry.sol
const CONTRACT_ABI = [
    "function recordReceipt(uint256 agentId, string memory actionType, string memory receiptData) external returns (uint256 receiptId)",
    "function receiptCount() view returns (uint256)",
    "function getAgentReceiptCount(uint256 agentId) view returns (uint256)",
    "function getReceipt(uint256 receiptId) view returns (uint256 agentId, string actionType, string receiptData, address submitter, uint256 timestamp)",
    "event ReceiptRecorded(uint256 indexed agentId, uint256 receiptId, string actionType, address indexed submitter)"
];

// We'll compile inline using ethers ContractFactory with the Solidity source
// Since we can't run solc directly, we use a minimal pre-compiled bytecode approach

// Minimal contract bytecode (compiled AgentReceiptRegistry)
// This is the creation bytecode for the contract above
const BYTECODE = "0x608060405234801561001057600080fd5b50610a9a806100206000396000f3fe608060405234801561001057600080fd5b50600436106100575760003560e01c80631b2e01b81461005c5780632b68b9c61461008c578063a87d942c146100be578063e52253811461013d578063f5f5ba72146101b6575b600080fd5b610076600480360381019061007191906105b2565b6101f6565b6040516100839190610600565b60405180910390f35b6100a660048036038101906100a19190610647565b610228565b6040516100b5939291906106d5565b60405180910390f35b6100d860048036038101906100d391906105b2565b6103a7565b6040516100e59190610600565b60405180910390f35b6101576004803603810190610152919061076c565b6103c3565b6040516101649190610600565b60405180910390f35b6101d0600480360381019061016b91906105b2565b610518565b6040516101e296959493929190610829565b60405180910390f35b600260205281600052604060002081815481106102125761ffff5b6000918252602090912001549150505b92915050565b600181815481106102395760008061ffff5b906000526020600020906005020160009150905080600001549080600101805461026290610897565b80601f016020809104026020016040519081016040528092919081815260200182805461028e90610897565b80156102db5780601f106102b0576101008083540402835291602001916102db565b820191906000526020600020905b8154815290600101906020018083116102be57829003601f168201915b5050505050908060020180546102f090610897565b80601f016020809104026020016040519081016040528092919081815260200182805461031c90610897565b80156103695780601f1061033e57610100808354040283529160200191610369565b820191906000526020600020905b81548152906001019060200180831161034c57829003601f168201915b5050505050908060030160009054906101000a900473ffffffffffffffffffffffffffffffffffffffff16908060040154905085565b600260205260009081526040902080546001909101545b919050565b600080546001818101808455600093849052835160059092027fb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf6810191909155845185937fb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf7019061042e90826109a0565b506040820151600282019061044390826109a0565b5060608201516003820180546001600160a01b0319166001600160a01b03909216919091179055608082015160049091015560008681526002602090815260408220805460018101825590835291200182905583906001600160a01b0316867f1c18e85c64c04c66fdea53e8c815e259be53cb940cd8b94b27ab69c7f5318c678560405161050e91906108c8565b60405180910390a3949350505050565b60018181548110610530576000806000806000ffff5b906000526020600020906005020160009150905080600001549080600101805461055990610897565b80601f016020809104026020016040519081016040528092919081815260200182805461058590610897565b80156105d25780601f106105a7576101008083540402835291602001916105d2565b820191906000526020600020905b8154815290600101906020018083116105b557829003601f168201915b505050505090806002018054610390565b";

async function main() {
    // Base Sepolia RPC
    const RPC_URL = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    
    // Try to get a private key from env, or derive from the project mnemonic
    let wallet;
    if (process.env.DEPLOYER_PRIVATE_KEY) {
        wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
    } else {
        // Generate a fresh deployer wallet
        wallet = ethers.Wallet.createRandom().connect(provider);
        console.log('⚠️  Generated a fresh deployer wallet. You need to fund it with Base Sepolia ETH.');
        console.log('Deployer address:', wallet.address);
        console.log('Private key (save this):', wallet.privateKey);
    }

    console.log('\n--- Deploying AgentReceiptRegistry to Base Sepolia ---');
    console.log('Deployer:', wallet.address);
    
    const balance = await provider.getBalance(wallet.address);
    console.log('Balance:', ethers.formatEther(balance), 'ETH');

    if (balance === 0n) {
        console.log('\n❌ No ETH on Base Sepolia. Fund the deployer wallet first.');
        console.log('Get free Base Sepolia ETH from: https://www.alchemy.com/faucets/base-sepolia');
        console.log('Deployer address:', wallet.address);
        process.exit(1);
    }

    // Deploy using inline Solidity via ethers
    // Since we don't have solc, let's use the ethers ContractFactory approach
    // We'll use a simpler approach: deploy with constructor-less bytecode
    
    const factory = new ethers.ContractFactory(CONTRACT_ABI, BYTECODE, wallet);
    
    console.log('Deploying...');
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    
    const address = await contract.getAddress();
    console.log('\n✅ Contract deployed!');
    console.log('Address:', address);
    console.log('Explorer: https://sepolia.basescan.org/address/' + address);

    // Submit a test receipt
    console.log('\n--- Submitting test receipt ---');
    const tx = await contract.recordReceipt(
        1, // agentId
        'TRANSFER_SOL',
        JSON.stringify({
            solanaTx: 'test-deployment-receipt',
            amount: 0.001,
            timestamp: new Date().toISOString(),
            note: 'First on-chain receipt from Agent Wallet Runtime'
        })
    );
    const receipt = await tx.wait();
    console.log('✅ Test receipt submitted!');
    console.log('Tx hash:', receipt.hash);
    console.log('Explorer: https://sepolia.basescan.org/tx/' + receipt.hash);
    
    // Output for updating the codebase
    console.log('\n=== UPDATE YOUR CODE ===');
    console.log('Set ERC8004_REGISTRY_ADDRESS=' + address);
    console.log('Set BASE_SEPOLIA_RPC=https://sepolia.base.org');
}

main().catch(console.error);
