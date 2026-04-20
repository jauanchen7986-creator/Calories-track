const express = require('express');
const { Pool } = require('pg');
const path     = require('path');

const app  = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

function getToken(req) {
  return (req.query.token || '').trim() || null;
}

async function initDB() {
  // 1. Drop old user_id schema if present
  try {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='logs' AND column_name='user_id'
    `);
    if (rows.length > 0) {
      await pool.query('DROP TABLE IF EXISTS logs');
      console.log('Dropped old user_id logs table');
    }
  } catch(e) { console.error('user_id check error:', e.message); }

  // 2. Migrate logs to multi-token schema
  try {
    const { rows: tbl } = await pool.query(`
      SELECT table_name FROM information_schema.tables WHERE table_name='logs'
    `);
    if (tbl.length > 0) {
      const { rows: col } = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='logs' AND column_name='user_token'
      `);
      if (col.length === 0) {
        await pool.query(`ALTER TABLE logs ADD COLUMN IF NOT EXISTS user_token TEXT NOT NULL DEFAULT 'joanne'`);
        const { rows: pk } = await pool.query(`
          SELECT constraint_name FROM information_schema.table_constraints
          WHERE table_name='logs' AND constraint_type='PRIMARY KEY'
        `);
        if (pk.length > 0)
          await pool.query(`ALTER TABLE logs DROP CONSTRAINT "${pk[0].constraint_name}"`);
        await pool.query(`ALTER TABLE logs ADD PRIMARY KEY (user_token, date_key)`);
        console.log('Migrated logs → multi-token');
      }
    }
  } catch(e) {
    console.error('logs migration failed, dropping for recreate:', e.message);
    try { await pool.query('DROP TABLE IF EXISTS logs'); } catch(_) {}
  }

  // 3. Migrate app_profile to multi-token schema
  try {
    const { rows: tbl } = await pool.query(`
      SELECT table_name FROM information_schema.tables WHERE table_name='app_profile'
    `);
    if (tbl.length > 0) {
      const { rows: col } = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='app_profile' AND column_name='user_token'
      `);
      if (col.length === 0) {
        let existing = [];
        try {
          const r = await pool.query('SELECT * FROM app_profile LIMIT 1');
          existing = r.rows;
        } catch(_) {}
        await pool.query('DROP TABLE IF EXISTS app_profile');
        await pool.query(`
          CREATE TABLE app_profile (
            user_token    TEXT PRIMARY KEY,
            gender        TEXT,
            age           INTEGER,
            height_cm     REAL,
            weight_kg     REAL,
            target_kg     REAL,
            activity      TEXT,
            bmr           INTEGER,
            tdee          INTEGER,
            goal_cal      INTEGER,
            macro_protein INTEGER,
            macro_carb    INTEGER,
            macro_fat     INTEGER
          )
        `);
        if (existing.length > 0) {
          const p = existing[0];
          await pool.query(`
            INSERT INTO app_profile
              (user_token, gender, age, height_cm, weight_kg, target_kg, activity,
               bmr, tdee, goal_cal, macro_protein, macro_carb, macro_fat)
            VALUES ('joanne',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          `, [p.gender, p.age, p.height_cm, p.weight_kg, p.target_kg, p.activity,
              p.bmr, p.tdee, p.goal_cal, p.macro_protein, p.macro_carb, p.macro_fat]);
          console.log('Migrated app_profile → joanne');
        }
      }
    }
  } catch(e) {
    console.error('app_profile migration failed, dropping for recreate:', e.message);
    try { await pool.query('DROP TABLE IF EXISTS app_profile'); } catch(_) {}
  }

  // 4. Always ensure tables exist with correct schema
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logs (
      user_token TEXT NOT NULL,
      date_key   TEXT NOT NULL,
      foods      JSONB NOT NULL DEFAULT '[]',
      exercises  JSONB NOT NULL DEFAULT '[]',
      weight     REAL,
      PRIMARY KEY (user_token, date_key)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_profile (
      user_token    TEXT PRIMARY KEY,
      gender        TEXT,
      age           INTEGER,
      height_cm     REAL,
      weight_kg     REAL,
      target_kg     REAL,
      activity      TEXT,
      bmr           INTEGER,
      tdee          INTEGER,
      goal_cal      INTEGER,
      macro_protein INTEGER,
      macro_carb    INTEGER,
      macro_fat     INTEGER
    )
  `);
  console.log('DB ready');
}
initDB().catch(err => console.error('DB init fatal:', err));

// ── LOGS ─────────────────────────────────────────────────────────────────────
app.get('/api/logs', async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM logs WHERE user_token=$1 ORDER BY date_key', [token]
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.post('/api/logs/:date', async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Invalid date' });
  const token = getToken(req);
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const { foods = [], exercises = [], weight = null } = req.body;
  try {
    await pool.query(`
      INSERT INTO logs (user_token, date_key, foods, exercises, weight)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_token, date_key) DO UPDATE SET
        foods     = EXCLUDED.foods,
        exercises = EXCLUDED.exercises,
        weight    = EXCLUDED.weight
    `, [token, date, JSON.stringify(foods), JSON.stringify(exercises), weight || null]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.delete('/api/logs/:date', async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    await pool.query(
      'DELETE FROM logs WHERE user_token=$1 AND date_key=$2', [token, req.params.date]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

// ── PROFILE ───────────────────────────────────────────────────────────────────
app.get('/api/profile', async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM app_profile WHERE user_token=$1', [token]
    );
    res.json(rows[0] || null);
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.post('/api/profile', async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const { gender, age, height_cm, weight_kg, target_kg, activity,
          bmr, tdee, goal_cal, macro_protein, macro_carb, macro_fat } = req.body;
  try {
    await pool.query(`
      INSERT INTO app_profile
        (user_token, gender, age, height_cm, weight_kg, target_kg, activity,
         bmr, tdee, goal_cal, macro_protein, macro_carb, macro_fat)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (user_token) DO UPDATE SET
        gender=EXCLUDED.gender, age=EXCLUDED.age, height_cm=EXCLUDED.height_cm,
        weight_kg=EXCLUDED.weight_kg, target_kg=EXCLUDED.target_kg,
        activity=EXCLUDED.activity, bmr=EXCLUDED.bmr, tdee=EXCLUDED.tdee,
        goal_cal=EXCLUDED.goal_cal, macro_protein=EXCLUDED.macro_protein,
        macro_carb=EXCLUDED.macro_carb, macro_fat=EXCLUDED.macro_fat
    `, [token, gender, age, height_cm, weight_kg, target_kg, activity,
        bmr, tdee, goal_cal, macro_protein, macro_carb, macro_fat]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'index.html'))
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Calories Tracker running on port ${PORT}`));
