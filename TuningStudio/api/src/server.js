import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pg from 'pg';

const { Pool } = pg;
const app = express();
const port = Number(process.env.API_PORT || 3000);
const sessionDays = 7;
const isProduction = process.env.NODE_ENV === 'production';
const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  max: 10, idleTimeoutMillis: 30_000
});
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 1025),
  secure: process.env.SMTP_SECURE === 'true',
  ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } } : {})
}) : null;
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '64kb', strict: true }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api', apiLimiter);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
function text(value, field, max, required = true) {
  if (value === undefined || value === null || value === '') {
    if (!required) return null;
    throw httpError(400, `${field} é obrigatório.`);
  }
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw httpError(400, `${field} inválido.`);
  return value.trim();
}
function sessionCookie(res, value, maxAge) {
  res.cookie('ts_session', value, { httpOnly: true, secure: isProduction, sameSite: 'strict', path: '/', maxAge });
}
function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
function verifyPassword(password, encoded) {
  try {
    const [kind, n, r, p, saltText, hashText] = encoded.split('$');
    if (kind !== 'scrypt' || n !== '16384' || r !== '8' || p !== '1') return false;
    const expected = Buffer.from(hashText, 'base64url');
    const actual = crypto.scryptSync(password, Buffer.from(saltText, 'base64url'), expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}
async function requireUser(req, res, next) {
  try {
    const token = req.cookies?.ts_session;
    if (!token || token.length > 100) throw httpError(401, 'Faça login para continuar.');
    const result = await pool.query(
      `SELECT u.id, u.email FROM user_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active' AND u.deleted_at IS NULL`,
      [tokenHash(token)]
    );
    if (!result.rowCount) throw httpError(401, 'Sessão inválida ou expirada.');
    req.user = result.rows[0];
    next();
  } catch (error) { next(error); }
}

app.get('/api/health', async (_req, res, next) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); } catch (error) { next(error); }
});

app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const email = text(req.body?.email, 'E-mail', 254).toLowerCase();
    const password = req.body?.password;
    const displayName = text(req.body?.displayName, 'Nome', 80);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'E-mail inválido.');
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw httpError(400, 'A senha deve ter entre 12 e 128 caracteres.');
    await client.query('BEGIN');
    const user = await client.query(
      `INSERT INTO users(email, password_hash, status, email_verified_at)
       VALUES ($1, $2, 'active', now()) RETURNING id, email`, [email, hashPassword(password)]
    );
    await client.query('INSERT INTO user_profiles(user_id, display_name) VALUES ($1, $2)', [user.rows[0].id, displayName]);
    const token = newSessionToken();
    await client.query('INSERT INTO user_sessions(user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval \'7 days\')', [user.rows[0].id, tokenHash(token)]);
    await client.query('COMMIT');
    sessionCookie(res, token, sessionDays * 24 * 60 * 60 * 1000);
    res.status(201).json({ user: user.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return next(httpError(409, 'Este e-mail já está cadastrado.'));
    next(error);
  } finally { client.release(); }
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res, next) => {
  try {
    const email = text(req.body?.email, 'E-mail', 254).toLowerCase();
    if (!mailer) throw httpError(503, 'O envio de e-mail ainda não está configurado.');
    const found = await pool.query("SELECT id FROM users WHERE lower(email) = $1 AND status = 'active' AND deleted_at IS NULL", [email]);
    if (found.rowCount) {
      const rawToken = crypto.randomBytes(32).toString('base64url');
      const tokenHashValue = tokenHash(rawToken);
      await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [found.rows[0].id]);
      await pool.query("INSERT INTO password_reset_tokens(user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')", [found.rows[0].id, tokenHashValue]);
      const resetUrl = `${process.env.PUBLIC_APP_URL || `http://localhost:${process.env.APP_PORT || 3000}`}/?token=${encodeURIComponent(rawToken)}`;
      try {
        await mailer.sendMail({
          from: process.env.MAIL_FROM || 'TuningStudio <nao-responda@localhost>', to: email,
          subject: 'Redefinição de senha do TuningStudio',
          text: `Recebemos um pedido para redefinir a senha da sua conta. Use este link em até 30 minutos:\n\n${resetUrl}\n\nSe você não pediu a redefinição, ignore esta mensagem.`
        });
      } catch (mailError) {
        await pool.query('DELETE FROM password_reset_tokens WHERE token_hash = $1', [tokenHashValue]);
        throw mailError;
      }
    }
    res.status(202).json({ message: 'Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.' });
  } catch (error) { next(error); }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const token = text(req.body?.token, 'Token', 100);
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw httpError(400, 'A senha deve ter entre 12 e 128 caracteres.');
    await client.query('BEGIN');
    const found = await client.query('SELECT user_id FROM password_reset_tokens WHERE token_hash = $1 AND expires_at > now() FOR UPDATE', [tokenHash(token)]);
    if (!found.rowCount) throw httpError(400, 'Link inválido ou expirado. Solicite uma nova redefinição.');
    const userId = found.rows[0].user_id;
    await client.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hashPassword(password), userId]);
    await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);
    await client.query('COMMIT');
    res.clearCookie('ts_session', { httpOnly: true, secure: isProduction, sameSite: 'strict', path: '/' });
    res.json({ message: 'Senha redefinida. Agora você pode entrar com a nova senha.' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client.release(); }
});

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const email = text(req.body?.email, 'E-mail', 254).toLowerCase();
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length > 128) throw httpError(400, 'Credenciais inválidas.');
    const result = await pool.query(
      `SELECT id, email, password_hash FROM users WHERE lower(email) = $1 AND status = 'active' AND deleted_at IS NULL`, [email]
    );
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) throw httpError(401, 'E-mail ou senha incorretos.');
    const token = newSessionToken();
    await pool.query('INSERT INTO user_sessions(user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval \'7 days\')', [user.id, tokenHash(token)]);
    await pool.query('UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1', [user.id]);
    sessionCookie(res, token, sessionDays * 24 * 60 * 60 * 1000);
    res.json({ user: { id: user.id, email: user.email } });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    if (req.cookies?.ts_session) await pool.query('DELETE FROM user_sessions WHERE token_hash = $1', [tokenHash(req.cookies.ts_session)]);
    res.clearCookie('ts_session', { httpOnly: true, secure: isProduction, sameSite: 'strict', path: '/' });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/api/auth/me', requireUser, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, p.display_name AS "displayName", p.phone, p.city, p.state_code AS "stateCode"
       FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = $1`, [req.user.id]
    );
    res.json({ user: result.rows[0] });
  } catch (error) { next(error); }
});

app.get('/api/vehicles', requireUser, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM vehicles WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC', [req.user.id]);
    res.json({ vehicles: result.rows });
  } catch (error) { next(error); }
});
app.post('/api/vehicles', requireUser, async (req, res, next) => {
  try {
    const b = req.body || {};
    const make = text(b.make, 'Marca', 80), model = text(b.model, 'Modelo', 100);
    const year = b.modelYear == null ? null : Number(b.modelYear);
    if (year !== null && (!Number.isInteger(year) || year < 1886 || year > 2200)) throw httpError(400, 'Ano inválido.');
    const result = await pool.query(
      `INSERT INTO vehicles(owner_id, make, model, trim, model_year, nickname, color, engine_code, transmission, fuel_type, odometer_km, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.user.id, make, model, text(b.trim, 'Versão', 100, false), year, text(b.nickname, 'Apelido', 80, false), text(b.color, 'Cor', 40, false), text(b.engineCode, 'Motor', 40, false), text(b.transmission, 'Câmbio', 40, false), text(b.fuelType, 'Combustível', 40, false), b.odometerKm == null ? null : Number(b.odometerKm), text(b.notes, 'Observações', 2000, false)]
    );
    res.status(201).json({ vehicle: result.rows[0] });
  } catch (error) { next(error); }
});
app.delete('/api/vehicles/:id', requireUser, async (req, res, next) => {
  try {
    const result = await pool.query('UPDATE vehicles SET deleted_at = now(), updated_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [req.params.id, req.user.id]);
    if (!result.rowCount) throw httpError(404, 'Carro não encontrado.');
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/api/projects', requireUser, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM projects WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC', [req.user.id]);
    res.json({ projects: result.rows });
  } catch (error) { next(error); }
});
app.post('/api/projects', requireUser, async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = text(b.name, 'Nome do projeto', 120);
    const configuration = b.configuration ?? {};
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || Buffer.byteLength(JSON.stringify(configuration)) > 256_000) throw httpError(400, 'Configuração inválida ou muito grande.');
    const result = await pool.query(
      `INSERT INTO projects(owner_id, vehicle_id, name, description, configuration, estimated_cost_cents, estimated_power_hp, estimated_torque_nm)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING *`,
      [req.user.id, b.vehicleId || null, name, text(b.description, 'Descrição', 2000, false), JSON.stringify(configuration), b.estimatedCostCents ?? null, b.estimatedPowerHp ?? null, b.estimatedTorqueNm ?? null]
    );
    res.status(201).json({ project: result.rows[0] });
  } catch (error) { next(error); }
});
app.delete('/api/projects/:id', requireUser, async (req, res, next) => {
  try {
    const result = await pool.query('UPDATE projects SET deleted_at = now(), updated_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [req.params.id, req.user.id]);
    if (!result.rowCount) throw httpError(404, 'Projeto não encontrado.');
    res.status(204).end();
  } catch (error) { next(error); }
});

app.use('/api', (_req, _res, next) => next(httpError(404, 'Rota não encontrada.')));
app.use(express.static(publicDir, { index: 'tuning_dashboard.html', dotfiles: 'deny', fallthrough: true, maxAge: isProduction ? '1h' : 0 }));
app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'JSON inválido.' });
  if (error.code === '23503') return res.status(400).json({ error: 'Referência inválida.' });
  if (error.code === '23514') return res.status(400).json({ error: 'Os dados não passaram pelas validações.' });
  const status = error.status || 500;
  if (status >= 500) console.error('API error:', error.message);
  res.status(status).json({ error: status >= 500 ? 'Erro interno do servidor.' : error.message });
});

async function start() {
  await pool.query('SELECT 1 FROM user_sessions LIMIT 0');
  await pool.query('SELECT 1 FROM password_reset_tokens LIMIT 0');
  app.listen(port, '0.0.0.0', () => console.log(`TuningStudio API ouvindo na porta ${port}`));
}
start().catch((error) => { console.error('Falha ao iniciar API:', error.message); process.exit(1); });
