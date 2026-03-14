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
            status VARCHAR(50) DEFAULT 'queued',
            technical_plan TEXT,
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

  async enqueueSession(sessionId, issueId) {
    if (!process.env.DATABASE_URL) return;

    try {
      await this.pool.query(
        `INSERT INTO agent_sessions (session_id, issue_id, status)
         VALUES ($1, $2, 'queued')`,
        [sessionId, issueId]
      );
      
      logger.info(`[DB] Enqueued session ${sessionId} (issue ${issueId})`);
    } catch (err) {
      logger.error(`[DB] Failed to enqueue session: ${err.message}`, err);
    }
  }

  async getNextSessionByStatus(status) {
    if (!process.env.DATABASE_URL) return null;

    try {
      const result = await this.pool.query(`
        SELECT session_id, issue_id 
        FROM agent_sessions 
        WHERE status = $1 
        ORDER BY started_at ASC 
        LIMIT 1 
        FOR UPDATE SKIP LOCKED
      `, [status]);

      if (result.rows.length > 0) {
        return result.rows[0];
      }
      return null;
    } catch (err) {
      logger.error(`[DB] Failed to get next ${status} session: ${err.message}`, err);
      return null;
    }
  }

  async getNextQueuedSession() {
    return this.getNextSessionByStatus('queued');
  }

  async getNextPlannedSession() {
    return this.getNextSessionByStatus('planned');
  }

  async updateSessionStatus(sessionId, status) {
    if (!process.env.DATABASE_URL) return;

    try {
      await this.pool.query(
        `UPDATE agent_sessions 
         SET status = $1 
         WHERE session_id = $2`,
        [status, sessionId]
      );
    } catch (err) {
      logger.error(`[DB] Failed to update session status: ${err.message}`, err);
    }
  }

  async startSession(sessionId, issueId) {
    // We already inserted the row in enqueueSession, so just update status
    this.updateSessionStatus(sessionId, 'processing');
    logger.info(`[DB] Marked session ${sessionId} as processing`);
  }

  async savePlan(sessionId, plan) {
    if (!process.env.DATABASE_URL) return;

    try {
      await this.pool.query(
        `UPDATE agent_sessions SET technical_plan = $1 WHERE session_id = $2`,
        [plan, sessionId]
      );
      logger.info(`[DB] Saved technical plan for session ${sessionId} (${plan.length} chars)`);
    } catch (err) {
      logger.error(`[DB] Failed to save plan: ${err.message}`, err);
    }
  }

  async getPlan(sessionId) {
    if (!process.env.DATABASE_URL) return null;

    try {
      const result = await this.pool.query(
        `SELECT technical_plan FROM agent_sessions WHERE session_id = $1`,
        [sessionId]
      );
      return result.rows[0]?.technical_plan || null;
    } catch (err) {
      logger.error(`[DB] Failed to get plan: ${err.message}`, err);
      return null;
    }
  }

  /**
   * On startup, reset any sessions stuck in transient states caused by a previous crash.
   * - 'planning' → 'queued'   (planning never finished; retry from scratch)
   * - 'building' → 'planned'  (plan exists; only the build phase needs to be retried)
   *
   * @returns {{ planning: number, building: number }} count of recovered sessions per state
   */
  async recoverStuckSessions() {
    if (!process.env.DATABASE_URL) return { planning: 0, building: 0 };

    try {
      const [planningResult, buildingResult] = await Promise.all([
        this.pool.query(
          `UPDATE agent_sessions SET status = 'queued'
           WHERE status = 'planning'
           RETURNING session_id`
        ),
        this.pool.query(
          `UPDATE agent_sessions SET status = 'planned'
           WHERE status = 'building'
           RETURNING session_id`
        ),
      ]);

      const planning = planningResult.rowCount;
      const building = buildingResult.rowCount;

      if (planning > 0) {
        logger.info(`[DB] Recovered ${planning} stuck 'planning' session(s) → reset to 'queued'`);
      }
      if (building > 0) {
        logger.info(`[DB] Recovered ${building} stuck 'building' session(s) → reset to 'planned'`);
      }
      if (planning === 0 && building === 0) {
        logger.info(`[DB] No stuck sessions found`);
      }

      return { planning, building };
    } catch (err) {
      logger.error(`[DB] Failed to recover stuck sessions: ${err.message}`, err);
      return { planning: 0, building: 0 };
    }
  }

  async endSession(sessionId, tokenUtilised = 0) {
    if (!process.env.DATABASE_URL) return;

    try {
      await this.pool.query(
        `UPDATE agent_sessions 
         SET end_at = CURRENT_TIMESTAMP, token_utilised = $1, status = 'completed'
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
