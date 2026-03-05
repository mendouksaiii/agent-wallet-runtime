import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';

/**
 * Typed record for an agent action logged to the database.
 */
export interface AgentAction {
  agent_id: number;
  agent_name: string;
  cycle_timestamp: string;
  intent_type: string | null;
  intent_details: string | null;
  action_taken: number;
  tx_signature: string | null;
  tx_success: number | null;
  error_message: string | null;
  sol_amount: number | null;
  balance_before: number | null;
  balance_after: number | null;
}

/**
 * Typed record for a spend entry logged to the database.
 */
export interface SpendRecord {
  agent_id: number;
  timestamp: string;
  amount_sol: number;
  tx_signature: string;
}

/**
 * Typed record for a simulation result logged to the database.
 */
export interface SimulationRecord {
  agent_id: number;
  timestamp: string;
  passed: number;
  logs: string | null;
}

/**
 * Summary statistics across all agents.
 */
export interface SummaryStats {
  totalTxs: number;
  successRate: number;
  totalSolMoved: number;
  agentBreakdown: Array<{
    agent_id: number;
    agent_name: string;
    totalActions: number;
    successfulTxs: number;
    totalSol: number;
  }>;
}

/**
 * Wrapper around sql.js Database that provides typed query functions
 * and automatic persistence to disk.
 */
export class AgentDatabase {
  private db: SqlJsDatabase;
  private readonly filePath: string;

  private constructor(db: SqlJsDatabase, filePath: string) {
    this.db = db;
    this.filePath = filePath;
  }

  /**
   * Initializes the SQLite database, creating tables if they don't exist.
   * Loads existing database from disk if available.
   *
   * @param dbPath - Path to the SQLite database file (default from env or ./data/agent_ledger.db)
   * @returns Initialized AgentDatabase instance
   */
  static async create(dbPath?: string): Promise<AgentDatabase> {
    const resolvedPath = dbPath || process.env.DB_PATH || './data/agent_ledger.db';
    const dir = path.dirname(resolvedPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const SQL = await initSqlJs();

    let db: SqlJsDatabase;
    if (fs.existsSync(resolvedPath)) {
      const fileBuffer = fs.readFileSync(resolvedPath);
      db = new SQL.Database(fileBuffer);
    } else {
      db = new SQL.Database();
    }

    const instance = new AgentDatabase(db, resolvedPath);
    instance.createTables();
    instance.save();

    return instance;
  }

  /**
   * Creates a synchronous in-memory database (useful for testing).
   *
   * @returns AgentDatabase backed by in-memory SQLite
   */
  static async createInMemory(): Promise<AgentDatabase> {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    const instance = new AgentDatabase(db, ':memory:');
    instance.createTables();
    return instance;
  }

  /**
   * Creates the required tables if they don't exist.
   */
  private createTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        agent_name TEXT NOT NULL,
        cycle_timestamp TEXT NOT NULL,
        intent_type TEXT,
        intent_details TEXT,
        action_taken INTEGER,
        tx_signature TEXT,
        tx_success INTEGER,
        error_message TEXT,
        sol_amount REAL,
        balance_before REAL,
        balance_after REAL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS spend_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        amount_sol REAL NOT NULL,
        tx_signature TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS simulation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        passed INTEGER NOT NULL,
        logs TEXT
      );
    `);
  }

  /**
   * Persists the database to disk.
   */
  save(): void {
    if (this.filePath === ':memory:') return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.filePath, buffer);
  }

  /**
   * Closes the database and persists to disk.
   */
  close(): void {
    this.save();
    this.db.close();
  }

  /**
   * Inserts an agent action record into the database.
   *
   * @param action - The agent action record to insert
   */
  insertAction(action: AgentAction): void {
    this.db.run(
      `INSERT INTO agent_actions 
        (agent_id, agent_name, cycle_timestamp, intent_type, intent_details, 
         action_taken, tx_signature, tx_success, error_message, sol_amount, 
         balance_before, balance_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        action.agent_id,
        action.agent_name,
        action.cycle_timestamp,
        action.intent_type,
        action.intent_details,
        action.action_taken,
        action.tx_signature,
        action.tx_success,
        action.error_message,
        action.sol_amount,
        action.balance_before,
        action.balance_after,
      ]
    );
    this.save();
  }

  /**
   * Inserts a spend record into the database.
   *
   * @param spend - The spend record to insert
   */
  insertSpend(spend: SpendRecord): void {
    this.db.run(
      `INSERT INTO spend_log (agent_id, timestamp, amount_sol, tx_signature)
       VALUES (?, ?, ?, ?)`,
      [spend.agent_id, spend.timestamp, spend.amount_sol, spend.tx_signature]
    );
    this.save();
  }

  /**
   * Inserts a simulation result record into the database.
   *
   * @param sim - The simulation record to insert
   */
  insertSimulation(sim: SimulationRecord): void {
    this.db.run(
      `INSERT INTO simulation_log (agent_id, timestamp, passed, logs)
       VALUES (?, ?, ?, ?)`,
      [sim.agent_id, sim.timestamp, sim.passed, sim.logs]
    );
    this.save();
  }

  /**
   * Retrieves the action history for a specific agent.
   *
   * @param agentId - The agent's numeric ID
   * @param limit - Maximum number of records to return
   * @returns Array of AgentAction records, most recent first
   */
  getAgentHistory(agentId: number, limit: number): AgentAction[] {
    const stmt = this.db.prepare(
      `SELECT * FROM agent_actions WHERE agent_id = ? ORDER BY id DESC LIMIT ?`
    );
    stmt.bind([agentId, limit]);

    const results: AgentAction[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      results.push({
        agent_id: row['agent_id'] as number,
        agent_name: row['agent_name'] as string,
        cycle_timestamp: row['cycle_timestamp'] as string,
        intent_type: (row['intent_type'] as string) || null,
        intent_details: (row['intent_details'] as string) || null,
        action_taken: row['action_taken'] as number,
        tx_signature: (row['tx_signature'] as string) || null,
        tx_success: row['tx_success'] as number | null,
        error_message: (row['error_message'] as string) || null,
        sol_amount: row['sol_amount'] as number | null,
        balance_before: row['balance_before'] as number | null,
        balance_after: row['balance_after'] as number | null,
      });
    }
    stmt.free();
    return results;
  }

  /**
   * Calculates the total SOL spent by an agent in the last 24 hours.
   *
   * @param agentId - The agent's numeric ID
   * @returns Total SOL spent in the rolling 24-hour window
   */
  getDailySpend(agentId: number): number {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const stmt = this.db.prepare(
      `SELECT COALESCE(SUM(amount_sol), 0) as total FROM spend_log WHERE agent_id = ? AND timestamp >= ?`
    );
    stmt.bind([agentId, twentyFourHoursAgo]);

    let total = 0;
    if (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      total = (row['total'] as number) || 0;
    }
    stmt.free();
    return total;
  }

  /**
   * Returns aggregate statistics across all agents.
   *
   * @returns Summary statistics including total transactions, success rate, and per-agent breakdown
   */
  getSummaryStats(): SummaryStats {
    // Total stats
    const totalStmt = this.db.prepare(`
      SELECT 
        COUNT(*) as totalTxs,
        COALESCE(SUM(CASE WHEN tx_success = 1 THEN 1 ELSE 0 END), 0) as successfulTxs,
        COALESCE(SUM(CASE WHEN tx_success = 1 THEN sol_amount ELSE 0 END), 0) as totalSolMoved
      FROM agent_actions
      WHERE action_taken = 1
    `);

    let totalTxs = 0;
    let successfulTxs = 0;
    let totalSolMoved = 0;

    if (totalStmt.step()) {
      const row = totalStmt.getAsObject() as Record<string, unknown>;
      totalTxs = (row['totalTxs'] as number) || 0;
      successfulTxs = (row['successfulTxs'] as number) || 0;
      totalSolMoved = (row['totalSolMoved'] as number) || 0;
    }
    totalStmt.free();

    // Per-agent breakdown
    const breakdownStmt = this.db.prepare(`
      SELECT 
        agent_id,
        agent_name,
        COUNT(*) as totalActions,
        COALESCE(SUM(CASE WHEN tx_success = 1 THEN 1 ELSE 0 END), 0) as successfulTxs,
        COALESCE(SUM(CASE WHEN tx_success = 1 THEN sol_amount ELSE 0 END), 0) as totalSol
      FROM agent_actions
      GROUP BY agent_id, agent_name
      ORDER BY agent_id
    `);

    const breakdown: SummaryStats['agentBreakdown'] = [];
    while (breakdownStmt.step()) {
      const row = breakdownStmt.getAsObject() as Record<string, unknown>;
      breakdown.push({
        agent_id: row['agent_id'] as number,
        agent_name: row['agent_name'] as string,
        totalActions: row['totalActions'] as number,
        successfulTxs: row['successfulTxs'] as number,
        totalSol: (row['totalSol'] as number) || 0,
      });
    }
    breakdownStmt.free();

    return {
      totalTxs,
      successRate: totalTxs > 0 ? (successfulTxs / totalTxs) * 100 : 0,
      totalSolMoved,
      agentBreakdown: breakdown,
    };
  }
  /**
   * Returns recent performance metrics for an agent.
   * Used by adaptive agent strategies to make data-driven decisions.
   *
   * @param agentId - The agent's numeric ID
   * @param windowSize - Number of recent actions to analyze (default 10)
   * @returns Performance metrics including success rate, streaks, and balance trend
   */
  getRecentPerformance(agentId: number, windowSize: number = 10): AgentPerformance {
    const stmt = this.db.prepare(
      `SELECT intent_type, tx_success, sol_amount, balance_before, balance_after, error_message
       FROM agent_actions
       WHERE agent_id = ? AND action_taken = 1
       ORDER BY id DESC LIMIT ?`
    );
    stmt.bind([agentId, windowSize]);

    let totalActions = 0;
    let successCount = 0;
    let failCount = 0;
    let totalAmountSent = 0;
    let consecutiveSuccesses = 0;
    let consecutiveFailures = 0;
    let streakCounted = false;
    const balances: number[] = [];

    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      totalActions++;

      const success = (row['tx_success'] as number) === 1;
      const amount = (row['sol_amount'] as number) || 0;
      const balBefore = (row['balance_before'] as number) || 0;

      if (success) {
        successCount++;
        totalAmountSent += amount;
      } else {
        failCount++;
      }

      // Count current streak (from most recent)
      if (!streakCounted) {
        if (success) {
          consecutiveSuccesses++;
        } else {
          consecutiveFailures++;
        }
      }
      // Once streak breaks, stop counting
      if (streakCounted === false && totalActions > 1) {
        const prevSuccess = (row['tx_success'] as number) === 1;
        if ((consecutiveSuccesses > 0 && !prevSuccess) || (consecutiveFailures > 0 && prevSuccess)) {
          streakCounted = true;
        }
      }

      balances.push(balBefore);
    }
    stmt.free();

    // Also get all actions (including idles) for activity level
    const allStmt = this.db.prepare(
      `SELECT COUNT(*) as total FROM agent_actions WHERE agent_id = ? ORDER BY id DESC LIMIT ?`
    );
    allStmt.bind([agentId, windowSize * 2]);
    let totalCycles = 0;
    if (allStmt.step()) {
      totalCycles = (allStmt.getAsObject() as Record<string, unknown>)['total'] as number || 0;
    }
    allStmt.free();

    const successRate = totalActions > 0 ? successCount / totalActions : 0;
    const avgAmount = successCount > 0 ? totalAmountSent / successCount : 0;

    // Balance trend: compare oldest to newest in the window
    let balanceTrend: 'rising' | 'falling' | 'stable' = 'stable';
    if (balances.length >= 2) {
      const newest = balances[0];
      const oldest = balances[balances.length - 1];
      const change = (newest - oldest) / (oldest || 1);
      if (change > 0.05) balanceTrend = 'rising';
      else if (change < -0.05) balanceTrend = 'falling';
    }

    return {
      totalActions,
      successCount,
      failCount,
      successRate,
      avgAmount,
      consecutiveSuccesses,
      consecutiveFailures,
      balanceTrend,
      totalCycles,
    };
  }
}

/**
 * Performance metrics for an agent over a recent window.
 */
export interface AgentPerformance {
  totalActions: number;
  successCount: number;
  failCount: number;
  successRate: number;
  avgAmount: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  balanceTrend: 'rising' | 'falling' | 'stable';
  totalCycles: number;
}

// Convenience export for backward compatibility
export type Database = AgentDatabase;
