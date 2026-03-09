/**
 * Agent Wallet Runtime — Entry Point
 *
 * Re-exports all public APIs for programmatic usage.
 * For CLI usage, see src/cli/index.ts.
 */

// Wallet layer
export { AgentWalletRuntime, WalletRuntimeError } from './wallet/runtime';
export type { DerivedAgent } from './wallet/runtime';

export { PolicyEngine, PolicyError, CONSERVATIVE_POLICY, STANDARD_POLICY, AGGRESSIVE_POLICY } from './wallet/policy';
export type { WalletPolicy, ValidationResult } from './wallet/policy';

export { TransactionSigner, SimulationError, NetworkError } from './wallet/signer';
export type { TransactionIntent, ExecutionResult } from './wallet/signer';

export { saveMnemonic, loadMnemonic, generateAndSave, KeystoreError } from './wallet/keystore';

// Agent layer
export { BaseAgent } from './agents/base-agent';
export type { AgentConfig } from './agents/base-agent';
export { OrionAgent } from './agents/orion-agent';
export { LyraAgent } from './agents/lyra-agent';
export { VegaAgent } from './agents/vega-agent';

// Orchestration
export { SimulationOrchestrator } from './simulation/orchestrator';
export type { AgentStatus } from './simulation/orchestrator';

// Database
export { AgentDatabase } from './db';
export type { AgentAction, SpendRecord, SimulationRecord, SummaryStats } from './db';

// Logger
export { createAgentLogger, createSystemLogger } from './logger';
