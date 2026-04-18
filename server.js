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

async function initDB() {
  // If logs table has user_id column, drop it (revert multi-user schema)
  const { rows } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'logs' AND column_name = 'user_id'
  `);
  if (rows.length > 0) {
    await pool.query('DROP TABLE IF EXISTS logs');
    console.log('Reverted to single-user logs table');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS logs (
      date_key  TEXT PRIMARY KEY,
      foods     JSONB NOT NULL DEFAULT '[]',
      exercises JSONB NOT NULL DEFAULT '[]',
      weight    REAL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_profile (
      id            INTEGER PRIMARY KEY DEFAULT 1,
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
}
initDB().catch(err => console.error('DB init error:', err));

// ── LOGS ─────────────────────────────────────────────────────────────────────
app.get('/api/logs', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM logs ORDER BY date_key');
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.post('/api/logs/:date', async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Invalid date' });
  const { foods = [], exercises = [], weight = null } = req.body;
  try {
    await pool.query(`
      INSERT INTO logs (date_key, foods, exercises, weight)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (date_key) DO UPDATE SET
        foods     = EXCLUDED.foods,
        exercises = EXCLUDED.exercises,
        weight    = EXCLUDED.weight
    `, [date, JSON.stringify(foods), JSON.stringify(exercises), weight || null]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.delete('/api/logs/:date', async (req, res) => {
  try {
    await pool.query('DELETE FROM logs WHERE date_key = $1', [req.params.date]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

// ── PROFILE (single user) ─────────────────────────────────────────────────────
app.get('/api/profile', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM app_profile WHERE id = 1');
    res.json(rows[0] || null);
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.post('/api/profile', async (req, res) => {
  const { gender, age, height_cm, weight_kg, target_kg, activity,
          bmr, tdee, goal_cal, macro_protein, macro_carb, macro_fat } = req.body;
  try {
    await pool.query(`
      INSERT INTO app_profile
        (id, gender, age, height_cm, weight_kg, target_kg, activity,
         bmr, tdee, goal_cal, macro_protein, macro_carb, macro_fat)
      VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO UPDATE SET
        gender=EXCLUDED.gender, age=EXCLUDED.age, height_cm=EXCLUDED.height_cm,
        weight_kg=EXCLUDED.weight_kg, target_kg=EXCLUDED.target_kg,
        activity=EXCLUDED.activity, bmr=EXCLUDED.bmr, tdee=EXCLUDED.tdee,
        goal_cal=EXCLUDED.goal_cal, macro_protein=EXCLUDED.macro_protein,
        macro_carb=EXCLUDED.macro_carb, macro_fat=EXCLUDED.macro_fat
    `, [gender, age, height_cm, weight_kg, target_kg, activity,
        bmr, tdee, goal_cal, macro_protein, macro_carb, macro_fat]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB error' }); }
});

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'index.html'))
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Calories Tracker running on port ${PORT}`));
