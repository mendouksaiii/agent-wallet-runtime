declare module 'sql.js' {
    interface SqlJsStatic {
        Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
    }

    interface Database {
        run(sql: string, params?: unknown[]): Database;
        exec(sql: string): QueryExecResult[];
        prepare(sql: string): Statement;
        export(): Uint8Array;
        close(): void;
        getRowsModified(): number;
    }

    interface Statement {
        bind(params?: unknown[]): boolean;
        step(): boolean;
        getAsObject(params?: Record<string, unknown>): Record<string, unknown>;
        get(params?: unknown[]): unknown[];
        free(): boolean;
        reset(): void;
        run(params?: unknown[]): void;
    }

    interface QueryExecResult {
        columns: string[];
        values: unknown[][];
    }

    export { Database, Statement, QueryExecResult, SqlJsStatic };

    export default function initSqlJs(config?: Record<string, unknown>): Promise<SqlJsStatic>;
}
