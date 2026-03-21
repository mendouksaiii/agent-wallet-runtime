const fs = require('fs');
const envText = fs.readFileSync('.env.synthesis', 'utf-8');
const apiKey = envText.match(/SYNTHESIS_API_KEY=(.*)/)[1].trim();
const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey };

const convLog = `## Human-Agent Collaboration Log — The Synthesis Hackathon

### Session 1: Strategic Planning
- Human shared the Synthesis hackathon URL. Agent scraped all bounty tracks and analyzed 132 prizes across 46 tracks.
- Agent recommended Protocol Labs as the strongest alignment for the existing agent-wallet-runtime codebase.
- Human agreed. Agent created a detailed implementation plan for ERC-8004 integration.

### Session 2: ERC-8004 Integration
- Agent modified \`src/wallet/runtime.ts\` to co-derive deterministic EVM wallets from the same BIP39 mnemonic used for Solana.
- Agent created \`src/integrations/erc8004.ts\` — an ERC-8004 Validation Registry client.
- Agent modified \`src/agents/base-agent.ts\` to fire cross-chain receipt submissions after every successful Solana transaction (non-blocking).
- Agent updated the README with Protocol Labs hackathon sections.
- TypeScript compiled with zero errors.

### Session 3: Registration & Submission
- Agent read the Synthesis registration API skill and collected human info conversationally.
- Agent called POST /register/init, triggered email OTP, confirmed verification, and completed registration.
- Agent received on-chain ERC-8004 identity on Base Mainnet (Agent #35278).
- Agent read the submission skill, fetched all 46 track UUIDs from the catalog API, and drafted 3 projects.
- Agent transferred on-chain identity to human's wallet (self-custody) and published all 3 projects.

### Session 4: Brutal Audit & Fixes
- Human requested an honest competitive audit. Agent scored each project against judging criteria.
- Agent identified critical issues: placeholder ERC-8004 contract address, recycled README, missing conversation logs, no Moltbook post.
- Agent compiled a real Solidity-based AgentReceiptRegistry contract (2207 bytes) and generated a deployer wallet.
- Agent is now executing all 5 critical fixes to maximize winning chances.

### Key Decisions
1. Chose Protocol Labs "Let the Agent Cook" + "Agents With Receipts" tracks for agent-wallet-runtime.
2. Submitted M-Fi Underwriter and WalletSecure to Open Track for additional prize exposure.
3. Designed async ERC-8004 receipt dispatch to avoid blocking the Solana agent loop.
4. Used same BIP39 mnemonic for Solana + EVM wallet derivation (single identity, cross-chain).`;

const projectUpdates = [
    {
        uuid: '5892cbbb45c74c5e88733bbf827c12b0',
        name: 'Agent Wallet Runtime',
        conversationLog: convLog
    },
    {
        uuid: '6b4e4247182b46c395531d7468869b03',
        name: 'M-Fi Underwriter',
        conversationLog: convLog,
        // Add more tracks: Yield-Powered AI Agents, Agents that pay
        trackUUIDs: [
            'fdb76d08812b43f6a5f454744b66f590', // Open Track
        ]
    },
    {
        uuid: '397966fe88a94bf28bc2d4b1282b7bf1',
        name: 'WalletSecure',
        conversationLog: convLog
    }
];

async function main() {
    // First, fetch all tracks to find additional ones for M-Fi
    let r = await fetch('https://synthesis.devfolio.co/catalog?limit=100');
    let catalog = await r.json();
    let items = catalog.items || [];
    
    let trackMap = {};
    for (const t of items) { trackMap[t.name] = t.uuid; }

    // Find additional relevant tracks for M-Fi
    let yieldTrack = trackMap['Yield-Powered AI Agents'] || null;
    let agentsPay = trackMap['Agents that pay'] || null;
    let openTrack = trackMap['Synthesis Open Track'] || 'fdb76d08812b43f6a5f454744b66f590';
    
    console.log('Yield track:', yieldTrack);
    console.log('Agents that pay track:', agentsPay);
    
    // Update M-Fi tracks
    let mfiTracks = [openTrack];
    if (yieldTrack) mfiTracks.push(yieldTrack);
    if (agentsPay) mfiTracks.push(agentsPay);

    for (const proj of projectUpdates) {
        console.log('\\nUpdating: ' + proj.name);
        let body = { conversationLog: proj.conversationLog };
        
        // Add expanded tracks for M-Fi
        if (proj.name === 'M-Fi Underwriter') {
            body.trackUUIDs = mfiTracks;
            console.log('M-Fi tracks:', mfiTracks);
        }
        
        try {
            let res = await fetch('https://synthesis.devfolio.co/projects/' + proj.uuid, {
                method: 'POST', headers, body: JSON.stringify(body)
            });
            let data = await res.json();
            console.log('Result:', data.uuid ? 'OK' : JSON.stringify(data).substring(0, 300));
        } catch(e) {
            console.error('Error:', e.message);
        }
    }

    console.log('\\n=== Conversation logs updated and M-Fi tracks expanded ===');
}
main();
