const fs = require('fs');
const envText = fs.readFileSync('.env.synthesis', 'utf-8');
const apiKey = envText.match(/SYNTHESIS_API_KEY=(.*)/)[1].trim();
const teamId = envText.match(/SYNTHESIS_TEAM_ID=(.*)/)[1].trim();
const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey };

async function main() {
  // 1. Fetch ALL tracks from catalog (items array)
  console.log('--- Fetching Tracks ---');
  let allItems = [];
  for (let page = 1; page <= 3; page++) {
    let r = await fetch('https://synthesis.devfolio.co/catalog?limit=100&page=' + page);
    let d = await r.json();
    let items = d.items || d.tracks || d.data || [];
    allItems.push(...items);
  }
  console.log('Total tracks found:', allItems.length);

  // Build map: track name -> track uuid
  let trackMap = {};
  for (const t of allItems) {
    trackMap[t.name] = t.uuid;
  }

  // Print all track names to find the right ones
  console.log('All track names:', Object.keys(trackMap).join(' | '));

  // Find our targets
  let openTrack = null, plCook = null, plReceipts = null;
  for (const [name, uuid] of Object.entries(trackMap)) {
    let lower = name.toLowerCase();
    if (lower.includes('open track') || lower.includes('synthesis open')) openTrack = uuid;
    if (lower.includes('let the agent cook') || lower.includes('no humans')) plCook = uuid;
    if (lower.includes('agents with receipts') || lower.includes('erc-8004')) plReceipts = uuid;
  }
  console.log('Open Track:', openTrack);
  console.log('PL Cook:', plCook);
  console.log('PL Receipts:', plReceipts);

  // Fallback: if we can't find by name, use the first available track
  let fallbackTrack = allItems.length > 0 ? allItems[0].uuid : null;
  if (!openTrack && !plCook && !plReceipts) {
    console.log('Using fallback track:', fallbackTrack);
  }

  // 2. Submit projects
  const convLog = 'Human-agent collaboration throughout The Synthesis hackathon. Agent (Antigravity, Gemini 2.5 Pro) analyzed bounties, recommended Protocol Labs tracks, implemented ERC-8004 cross-chain receipts, registered via API, and executed the submission pipeline autonomously.';
  const meta = {
    agentFramework: 'other', agentFrameworkOther: 'custom autonomous runtime',
    agentHarness: 'other', agentHarnessOther: 'antigravity',
    model: 'gemini-2.5-pro', skills: ['web-search'],
    tools: ['Node.js','TypeScript','Solana Web3.js','ethers.js','Jest','Vercel','Git'],
    helpfulResources: ['https://synthesis.md/submission/skill.md','https://eips.ethereum.org/EIPS/eip-8004'],
    intention: 'continuing'
  };

  const projects = [
    {
      name: 'Agent Wallet Runtime',
      description: 'Autonomous wallet infrastructure for AI agents on Solana with cross-chain ERC-8004 receipts on EVM. Co-derives deterministic EVM wallets alongside Solana wallets from the same BIP39 seed for verifiable proof-of-work receipts.',
      problemStatement: 'AI agents lack infrastructure to autonomously manage wallets and produce verifiable receipts of their work, making trustless agent commerce impossible.',
      repoURL: 'https://github.com/mendouksaiii/agent-wallet-runtime',
      tracks: [plCook, plReceipts, openTrack].filter(Boolean)
    },
    {
      name: 'M-Fi Underwriter',
      description: 'Autonomous AI credit bureau and micro-lending protocol for machine-to-machine finance. Evaluates agent loan requests using LLM risk analysis, disburses via Tether WDK, and auto-deploys idle capital to Aave V3.',
      problemStatement: 'No credit infrastructure exists for AI agents. M-Fi creates the first AI-native credit bureau where reputation is built on-chain through verifiable transaction history.',
      repoURL: 'https://github.com/mendouksaiii/m-fi-underwriter',
      deployedURL: 'https://m-fi-underwriter.vercel.app',
      tracks: [openTrack].filter(Boolean)
    },
    {
      name: 'WalletSecure',
      description: 'Web3 threat intelligence platform: real-time security scanning, deep contract analysis, and proactive wallet monitoring across 6 EVM chains with one-click approval revocation.',
      problemStatement: 'Web3 users grant unlimited token approvals without understanding risk. WalletSecure provides unified multi-chain security with one-click remediation.',
      repoURL: 'https://github.com/mendouksaiii/walletsecure',
      tracks: [openTrack].filter(Boolean)
    }
  ];

  const uuids = [];
  for (const p of projects) {
    console.log('\n--- Submitting: ' + p.name + ' ---');
    let trackIds = p.tracks.length > 0 ? p.tracks : (fallbackTrack ? [fallbackTrack] : []);
    if (!trackIds.length) { console.error('SKIP: No tracks!'); continue; }
    console.log('Tracks:', trackIds);
    const payload = { teamUUID: teamId, name: p.name, description: p.description, problemStatement: p.problemStatement, repoURL: p.repoURL, trackUUIDs: trackIds, conversationLog: convLog, submissionMetadata: meta };
    if (p.deployedURL) payload.deployedURL = p.deployedURL;
    try {
      let r = await fetch('https://synthesis.devfolio.co/projects', { method: 'POST', headers, body: JSON.stringify(payload) });
      let d = await r.json();
      if (d.uuid) { uuids.push({ name: p.name, uuid: d.uuid }); console.log('DRAFT OK:', d.uuid); }
      else console.error('DRAFT ERR:', JSON.stringify(d).substring(0, 500));
    } catch(e) { console.error('Fetch err:', e.message); }
    await new Promise(r => setTimeout(r, 1500));
  }

  // 3. Publish
  console.log('\n--- Publishing ---');
  for (const p of uuids) {
    try {
      let r = await fetch('https://synthesis.devfolio.co/projects/' + p.uuid + '/publish', { method: 'POST', headers });
      let d = await r.json();
      console.log(p.name + ':', d.status || d.message || JSON.stringify(d).substring(0, 300));
    } catch(e) { console.error('Pub err:', e.message); }
    await new Promise(r => setTimeout(r, 1000));
  }

  fs.appendFileSync('.env.synthesis', '\n' + uuids.map(p => p.name + '=' + p.uuid).join('\n') + '\n');
  console.log('\nALL DONE:', JSON.stringify(uuids));
}
main();
