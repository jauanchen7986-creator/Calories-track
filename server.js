const express = require('express');
const { Pool }  = require('pg');
const path      = require('path');

const app  = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Create table if not exists
pool.query(`
  CREATE TABLE IF NOT EXISTS logs (
    date_key  TEXT PRIMARY KEY,
    foods     JSONB NOT NULL DEFAULT '[]',
    exercises JSONB NOT NULL DEFAULT '[]',
    weight    REAL
  )
`).catch(err => console.error('DB init error:', err));

// GET all logs (for chart/report building on page load)
app.get('/api/logs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT date_key, foods, exercises, weight FROM logs ORDER BY date_key'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST (upsert) a single day's log
app.post('/api/logs/:date', async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Invalid date format' });

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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// DELETE a single day's log
app.delete('/api/logs/:date', async (req, res) => {
  const { date } = req.params;
  try {
    await pool.query('DELETE FROM logs WHERE date_key = $1', [date]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'index.html'))
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Calories Tracker running on port ${PORT}`));
