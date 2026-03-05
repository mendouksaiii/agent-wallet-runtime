import winston from 'winston';
import path from 'path';
import fs from 'fs';

/**
 * Structured log entry format for all agent runtime events.
 */
interface AgentLogEntry {
    timestamp: string;
    level: string;
    agentId: number;
    agentName: string;
    event: string;
    data: Record<string, unknown>;
}

const LOG_DIR = process.env.LOG_PATH
    ? path.dirname(process.env.LOG_PATH)
    : './logs';
const LOG_FILE = process.env.LOG_PATH || './logs/agent-runtime.log';

/** Global flag: when true, console transports are silenced (dashboard owns the terminal). */
let dashboardModeEnabled = false;

/**
 * Enable or disable dashboard mode.
 * When enabled, all Winston console transports are silenced — logs only go to file.
 * This prevents log output from corrupting the dashboard render.
 */
export function setDashboardMode(enabled: boolean): void {
    dashboardModeEnabled = enabled;
}

/**
 * Ensures the log directory exists before writing.
 */
function ensureLogDir(): void {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

/**
 * Custom format that attaches agentId and agentName to every log line.
 */
function agentFormat(agentId: number, agentName: string): winston.Logform.Format {
    return winston.format((info) => {
        info['agentId'] = agentId;
        info['agentName'] = agentName;
        return info;
    })();
}

/**
 * Console format: colorized, human-readable with timestamp and agent context.
 * Silences output when dashboard mode is enabled.
 */
const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
    winston.format.printf(({ timestamp, level, agentId, agentName, event, message, ...rest }) => {
        // When dashboard mode is active, suppress console output
        if (dashboardModeEnabled) return '';

        const agent = agentName ? `[${agentName}:${agentId}]` : '[SYSTEM]';
        const evt = event ? `<${event}>` : '';
        const extra = Object.keys(rest).length > 0
            ? ` ${JSON.stringify(rest)}`
            : '';
        return `${timestamp} ${level} ${agent} ${evt} ${message}${extra}`;
    })
);

/**
 * File format: structured JSON, one object per line.
 */
const fileFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    winston.format.json()
);

/**
 * Creates a Winston logger instance configured for a specific agent.
 *
 * @param agentId - Numeric identifier for the agent
 * @param agentName - Human-readable agent name (e.g., 'ALPHA', 'BETA')
 * @returns Configured Winston Logger instance
 */
export function createAgentLogger(agentId: number, agentName: string): winston.Logger {
    ensureLogDir();

    return winston.createLogger({
        level: 'info',
        defaultMeta: { agentId, agentName },
        format: winston.format.combine(
            agentFormat(agentId, agentName),
            winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' })
        ),
        transports: [
            new winston.transports.Console({
                format: consoleFormat,
            }),
            new winston.transports.File({
                filename: LOG_FILE,
                format: fileFormat,
                maxsize: 10 * 1024 * 1024, // 10MB rotation
                maxFiles: 5,
            }),
        ],
    });
}

/**
 * Creates a system-level logger (not tied to a specific agent).
 *
 * @returns Configured Winston Logger for system-wide events
 */
export function createSystemLogger(): winston.Logger {
    return createAgentLogger(-1, 'SYSTEM');
}

export type { AgentLogEntry };
