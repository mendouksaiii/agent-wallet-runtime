# 🎬 Hackathon Video Presentation Script

**Goal:** Record a crisp 2-3 minute video showing the dashboard, the presentation deck, and the GitHub repo.

## Setup Before Recording
1. Open the Vercel dashboard we just deployed (or `vercel-deploy/index.html`).
2. Open `presentation.html` in another browser tab.
3. Open your GitHub repository in a third tab.
4. Have your screen recorder (OBS, Loom, Zoom) ready to capture your screen and microphone.

---

## The Script

*(Start recording on the Vercel Dashboard, watching the transactions stream in)*

**[0:00 - 0:30] The Hook & Demo**
"Hey everyone, this is Agent Wallet Runtime — an autonomous AI wallet infrastructure built for Solana. 

What you're looking at right now is our live devnet dashboard. We have three autonomous agents—Orion, Lyra, and Vega—actively making financial decisions and executing transactions on-chain. 

The core problem we're solving is security. Right now, most 'AI agents' hold a plaintext private key in a Python script. If the script gets hacked, the wallet is drained. We built a system where agents never touch the private key."

*(Switch tab to `presentation.html` - Slide 2: The Idea)*

**[0:30 - 1:00] The Architecture**
"Instead of signing transactions directly, our agents emit *intents* — structured requests like 'transfer 0.1 SOL' or 'swap SOL for USDC on Jupiter'. 

These intents are intercepted by our Wallet Runtime. Before any signature happens, the runtime enforces strict security policies—like per-transaction limits and 24-hour spend caps—and then fully simulates the transaction against the Solana RPC. 

Only if the policy passes AND the simulation succeeds does the runtime finally sign and broadcast."

*(Switch back to Dashboard, pointing at the transactions)*

**[1:00 - 1:30] The Agents & Jupiter DEX**
"Here you can see our agents operating in different regimes based on their historical success rates. 
- Orion is a Momentum Market Maker.
- Lyra is a Smart Accumulator that integrates directly with the Jupiter v6 API to swap excess SOL for USDC.
- Vega acts as a Rebalancer.

You can see in the transaction feed here that transactions are sometimes rejected by the policy engine—like Daily Spend caps being hit—or simulation failures. This proves the security gate is actively working."

*(Switch to Slide 3: What Actually Works & Slide 6: Scorecard)*

**[1:30 - 2:00] The Deliverables**
"We wanted to build proof, not promises. The system features:
- A strict TypeScript codebase with zero build errors.
- 29 out of 29 unit and integration tests passing.
- Deterministic HD wallet derivation using BIP44, where the master seed is encrypted with AES-256-GCM.
- A functional CLI for running the simulation.
- And of course, real on-chain devnet transactions."

*(Switch to GitHub Repo)*

**[2:00 - 2:20] Close**
"The entire codebase is open source and strictly typed. You can pull it down and run the simulation CLI yourself in under 2 minutes. 

Thanks for taking a look at Agent Wallet Runtime — making autonomous AI agents secure enough for real capital."

*(Stop recording)*

---

## Pro-Tips
- **Pacing**: Speak naturally, don't rush. You can pause and read if needed (you can always edit pauses out, though single-take is fine for hackathons).
- **Enthusiasm**: Sound excited when you show the live transactions!
- **Keep it moving**: Change tabs roughly every 30 seconds to keep the judges visually engaged.
