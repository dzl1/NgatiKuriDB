import sql from 'mssql';

export { sql };

// Signs in with Microsoft Entra ID only (no SQL passwords):
// - on App Service: the web app's managed identity
// - on a developer machine: the account signed in to the Azure CLI (`az login`)
function config() {
  const server = process.env.SQL_SERVER;
  const database = process.env.SQL_DATABASE;
  if (!server || !database) throw new Error('SQL_SERVER and SQL_DATABASE must be set to use Azure SQL.');
  return {
    server,
    database,
    authentication: { type: 'azure-active-directory-default', options: {} },
    options: { encrypt: true, trustServerCertificate: false },
    connectionTimeout: 60_000,
    requestTimeout: 120_000,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
  };
}

export function sqlConfigured() {
  return Boolean(process.env.SQL_SERVER && process.env.SQL_DATABASE);
}

let poolPromise = null;

// The serverless database pauses when idle and answers "not currently available" (40613)
// while it resumes, so the first connection retries for up to about two minutes.
export async function getPool() {
  if (!poolPromise) {
    poolPromise = connectWithRetry().catch((error) => {
      poolPromise = null;
      throw error;
    });
  }
  return poolPromise;
}

async function connectWithRetry() {
  const deadline = Date.now() + 120_000;
  let delay = 2_000;
  for (;;) {
    try {
      const pool = new sql.ConnectionPool(config());
      pool.on('error', (error) => console.error('[harbour] SQL pool error:', error.message));
      return await pool.connect();
    } catch (error) {
      if (Date.now() + delay > deadline) throw error;
      console.warn(`[harbour] SQL connection failed (${error.code ?? error.message}); retrying in ${delay / 1000}s…`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  }
}
