import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const user = process.env.API_DB_USER;
  const password = process.env.API_DB_PASSWORD;
  if (!user || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(user) || !password) throw new Error('Configure API_DB_USER e API_DB_PASSWORD.');

  const role = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
  const roleSql = await pool.query('SELECT format($fmt$%s %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION$fmt$, $1, $2, $3) AS sql', [role.rowCount ? 'ALTER ROLE' : 'CREATE ROLE', user, password]);
  await pool.query(roleSql.rows[0].sql);

  for (const filename of ['002_user_sessions.sql', '003_password_reset_tokens.sql']) {
    await pool.query(await fs.readFile(path.join(root, 'migrations', filename), 'utf8'));
  }
  const grants = await pool.query(`SELECT format(
    'GRANT CONNECT ON DATABASE %I TO %I; GRANT USAGE ON SCHEMA public TO %I; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I;',
    current_database(), $1, $1, $1, $1, $1, $1
  ) AS sql`, [user]);
  await pool.query(grants.rows[0].sql);
  console.log('Migrações aplicadas e usuário restrito da API configurado.');
}

main().catch((error) => { console.error('Falha nas migrações:', error.message); process.exitCode = 1; }).finally(() => pool.end());
