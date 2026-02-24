const { Pool } = require("pg");
const logger = require("../utils/logger");

class DbService {
  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  }

  async initDB() {
    if (!process.env.DATABASE_URL) {
      logger.warn("⚠ DATABASE_URL not set – skipping Postgres initialization.");
      return;
    }

    try {
      logger.info("[DB] Connecting to PostgreSQL to ensure schema exists...");
      const client = await this.pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS agent_sessions (
            session_id UUID PRIMARY KEY,
            issue_id VARCHAR(255) NOT NULL,
            token_utilised INTEGER DEFAULT 0,
            started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            end_at TIMESTAMP WITH TIME ZONE
          );
        `);
        logger.info("[DB] Schema agent_sessions is ready ✅");
      } finally {
        client.release();
      }
    } catch (err) {
      logger.error(`[DB] Failed to initialize database schema: ${err.message}`, err);
    }
  }

  async startSession(sessionId, issueId) {
    if (!process.env.DATABASE_URL) return;

    try {
      await this.pool.query(
        `INSERT INTO agent_sessions (session_id, issue_id)
         VALUES ($1, $2)`,
        [sessionId, issueId]
      );
      
      logger.info(`[DB] Registered start for session ${sessionId} (issue ${issueId})`);
    } catch (err) {
      logger.error(`[DB] Failed to start session: ${err.message}`, err);
    }
  }

  async endSession(sessionId, tokenUtilised = 0) {
    if (!process.env.DATABASE_URL) return;

    try {
      await this.pool.query(
        `UPDATE agent_sessions 
         SET end_at = CURRENT_TIMESTAMP, token_utilised = $1 
         WHERE session_id = $2`,
        [tokenUtilised, sessionId]
      );
      logger.info(`[DB] Registered end for session ${sessionId} with ${tokenUtilised} tokens`);
    } catch (err) {
      logger.error(`[DB] Failed to end session: ${err.message}`, err);
    }
  }
}

// Export singleton instance
module.exports = new DbService();
