const express = require('express');
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const path     = require('path');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});
const JWT_SECRET = process.env.JWT_SECRET || 'jlog_secret_change_me_in_railway';

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── DB INIT ──────────────────────────────────────────────────────────────────
async function initDB() {
  // Users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // If logs table exists but lacks user_id, drop and recreate
  // (phone data will be re-migrated after user registers)
  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'logs' AND column_name = 'user_id'
  `);
  if (rows.length === 0) {
    await pool.query('DROP TABLE IF EXISTS logs');
    console.log('Dropped old logs table — will recreate with user_id support');
  }

  // Logs table with per-user isolation
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logs (
      date_key  TEXT    NOT NULL,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      foods     JSONB   NOT NULL DEFAULT '[]',
      exercises JSONB   NOT NULL DEFAULT '[]',
      weight    REAL,
      PRIMARY KEY (date_key, user_id)
    )
  `);
}
initDB().catch(err => console.error('DB init error:', err));

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalid or expired' });
  }
}

// ── AUTH ENDPOINTS ────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: '請填寫用戶名稱和密碼' });
  if (password.length < 6)
    return res.status(400).json({ error: '密碼至少需要 6 個字元' });

  try {
    const { rows: cnt } = await pool.query('SELECT COUNT(*) FROM users');
    const isFirst = parseInt(cnt[0].count) === 0;

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username.trim(), hash]
    );
    const user = rows[0];

    // First user claims any orphaned (pre-auth) logs
    if (isFirst) {
      await pool.query(
        'UPDATE logs SET user_id = $1 WHERE user_id IS NULL',
        [user.id]
      );
    }

    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '90d' }
    );
    res.json({ token, username: user.username });
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ error: '此用戶名稱已被使用' });
    console.error(e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username?.trim()]
    );
    if (!rows.length)
      return res.status(401).json({ error: '用戶名稱或密碼錯誤' });
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid)
      return res.status(401).json({ error: '用戶名稱或密碼錯誤' });

    const token = jwt.sign(
      { id: rows[0].id, username: rows[0].username },
      JWT_SECRET,
      { expiresIn: '90d' }
    );
    res.json({ token, username: rows[0].username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ── LOG ENDPOINTS (auth required) ────────────────────────────────────────────
app.get('/api/logs', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT date_key, foods, exercises, weight FROM logs WHERE user_id = $1 ORDER BY date_key',
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.post('/api/logs/:date', requireAuth, async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Invalid date format' });
  const { foods = [], exercises = [], weight = null } = req.body;
  try {
    await pool.query(`
      INSERT INTO logs (date_key, user_id, foods, exercises, weight)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (date_key, user_id) DO UPDATE SET
        foods     = EXCLUDED.foods,
        exercises = EXCLUDED.exercises,
        weight    = EXCLUDED.weight
    `, [date, req.user.id, JSON.stringify(foods), JSON.stringify(exercises), weight || null]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.delete('/api/logs/:date', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM logs WHERE date_key = $1 AND user_id = $2',
      [req.params.date, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'index.html'))
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Calories Tracker running on port ${PORT}`));
