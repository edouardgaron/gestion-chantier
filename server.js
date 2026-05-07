/**
 * server.js — InnovaSpray Québec
 * Serveur Express + SQLite (module natif Node.js 22).
 * Sert les fichiers statiques et expose une API clé-valeur.
 * Chaque page HTML reçoit window.__ISQ_PRELOAD__ avec toutes les données.
 *
 * Démarrage : npm install && npm start
 * Accès     : http://localhost:3000
 */

'use strict';

const express              = require('express');
const path                 = require('path');
const fs                   = require('fs');
const { DatabaseSync }     = require('node:sqlite');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH  = path.join(DATA_DIR, 'chantier.db');

// Créer le dossier data si absent
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Base de données ────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS saves (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp  TEXT NOT NULL,
    doc_type   TEXT NOT NULL,
    job_number TEXT NOT NULL,
    trigger    TEXT NOT NULL,
    data       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_saves_ts ON saves (timestamp);
  CREATE INDEX IF NOT EXISTS idx_saves_dt ON saves (doc_type);
  CREATE INDEX IF NOT EXISTS idx_saves_jn ON saves (job_number);
`);

const stmtGet    = db.prepare('SELECT value FROM kv WHERE key = ?');
const stmtSet    = db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))");
const stmtDel    = db.prepare('DELETE FROM kv WHERE key = ?');
const stmtGetAll = db.prepare('SELECT key, value FROM kv');

const stmtSaveInsert = db.prepare('INSERT INTO saves (timestamp, doc_type, job_number, trigger, data) VALUES (?, ?, ?, ?, ?)');
const stmtSaveGetAll = db.prepare('SELECT * FROM saves ORDER BY timestamp DESC');
const stmtSaveDelete = db.prepare('DELETE FROM saves WHERE id = ?');
const stmtSaveClear  = db.prepare('DELETE FROM saves');
const stmtSaveStats  = db.prepare('SELECT doc_type, COUNT(*) as cnt, MAX(timestamp) as last_ts FROM saves GROUP BY doc_type');
const stmtSaveCount  = db.prepare('SELECT COUNT(*) as cnt FROM saves');

// ── Middleware ─────────────────────────────────────────────────────
app.use(express.json());

// ── API /api/kv ────────────────────────────────────────────────────

// GET /api/kv — toutes les paires clé-valeur
app.get('/api/kv', (req, res) => {
  const rows = stmtGetAll.all();
  const data = {};
  rows.forEach(r => { data[r.key] = r.value; });
  res.json(data);
});

// GET /api/kv/:key
app.get('/api/kv/:key', (req, res) => {
  const row = stmtGet.get(req.params.key);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ value: row.value });
});

// POST /api/kv/:key  { "value": "..." }
app.post('/api/kv/:key', (req, res) => {
  const { value } = req.body;
  if (value === undefined || value === null) {
    return res.status(400).json({ error: 'Missing value' });
  }
  stmtSet.run(req.params.key, String(value));
  res.json({ ok: true });
});

// DELETE /api/kv/:key
app.delete('/api/kv/:key', (req, res) => {
  stmtDel.run(req.params.key);
  res.json({ ok: true });
});

// ── API /api/saves ─────────────────────────────────────────────────

// POST /api/saves  { timestamp, docType, jobNumber, trigger, data }
app.post('/api/saves', (req, res) => {
  const { timestamp, docType, jobNumber, trigger, data } = req.body;
  if (!timestamp || !docType) return res.status(400).json({ error: 'Missing fields' });
  stmtSaveInsert.run(timestamp, docType, String(jobNumber || ''), String(trigger || ''), JSON.stringify(data || {}));
  res.json({ ok: true });
});

// GET /api/saves — toutes les sauvegardes, du plus récent au plus ancien
app.get('/api/saves', (req, res) => {
  const rows = stmtSaveGetAll.all();
  const saves = rows.map(r => ({
    id:        r.id,
    timestamp: r.timestamp,
    docType:   r.doc_type,
    jobNumber: r.job_number,
    trigger:   r.trigger,
    data:      JSON.parse(r.data)
  }));
  res.json(saves);
});

// GET /api/saves/stats
app.get('/api/saves/stats', (req, res) => {
  const total      = stmtSaveCount.get().cnt;
  const byDocRows  = stmtSaveStats.all();
  const byDoc      = { bon_travail: 0, fiche_chantier: 0, checklist: 0, materiaux: 0, satisfaction: 0 };
  let   lastSave   = null;
  byDocRows.forEach(r => {
    byDoc[r.doc_type] = r.cnt;
    if (!lastSave || r.last_ts > lastSave) lastSave = r.last_ts;
  });
  res.json({ total, byDoc, lastSave });
});

// DELETE /api/saves/:id — supprimer une entrée
app.delete('/api/saves/:id', (req, res) => {
  stmtSaveDelete.run(Number(req.params.id));
  res.json({ ok: true });
});

// DELETE /api/saves — tout effacer
app.delete('/api/saves', (req, res) => {
  stmtSaveClear.run();
  res.json({ ok: true });
});

// ── Pages HTML — injection de __ISQ_PRELOAD__ ──────────────────────
const STATIC_DIR = __dirname;

// Endpoint de diagnostic (temporaire)
app.get('/debug-fs', (req, res) => {
  const htmlFiles = fs.readdirSync(STATIC_DIR).filter(f => f.endsWith('.html'));
  const bonPath   = path.join(STATIC_DIR, 'Bon de travail.html');
  res.json({
    dirname:    __dirname,
    bonExists:  fs.existsSync(bonPath),
    bonPath,
    htmlFiles
  });
});

app.get(/\.html$/, (req, res) => {
  const filePath = path.join(STATIC_DIR, req.path);
  if (!fs.existsSync(filePath)) return res.status(404).send('Page introuvable.');

  let html = fs.readFileSync(filePath, 'utf8');

  // Charger toutes les données et les injecter comme script synchrone
  const rows    = stmtGetAll.all();
  const preload = {};
  rows.forEach(r => { preload[r.key] = r.value; });

  const tag = `<script>window.__ISQ_PRELOAD__ = ${JSON.stringify(preload)};</script>`;
  html = html.replace('<head>', '<head>\n  ' + tag);

  res.type('html').send(html);
});

// Fichiers statiques (JS, CSS, images…)
app.use(express.static(STATIC_DIR));

// Rediriger / vers /index.html
app.get('/', (req, res) => res.redirect('/index.html'));

// ── Démarrage ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`InnovaSpray Chantier v2 — http://localhost:${PORT}`);
  console.log(`Base de données        — ${DB_PATH}`);
});
