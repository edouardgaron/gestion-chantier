/**
 * server.js — InnovaSpray Québec
 * Serveur Express + SQLite (module natif Node.js 22).
 *
 * Fonctions :
 *   • Sert les fichiers statiques + injecte window.__ISQ_PRELOAD__ dans chaque page
 *   • API clé-valeur (/api/kv) et sauvegardes (/api/saves) — existant
 *   • Authentification serveur par jeton signé (/api/session) — voir server-auth.js
 *   • Comptes rendus quotidiens (/api/daily-reports) avec envoi de courriel
 *     NATIF (Nodemailer + SMTP Gmail) — remplace l'ancien workflow n8n
 *   • Gestion des photos et configuration courriel
 *
 * Démarrage : npm install && npm start
 * Accès     : http://localhost:3000
 */

'use strict';

const express          = require('express');
const path             = require('path');
const fs               = require('fs');
const crypto           = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const { makeAuth }     = require('./server-auth');
const email            = require('./server-email');
const render           = require('./server-render');
const { PDFDocument: LibPDF } = require('pdf-lib');
const archiver         = require('archiver');

const app         = express();
const PORT        = process.env.PORT || 3000;
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH     = path.join(DATA_DIR, 'chantier.db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PROJECTS_DIR = path.join(DATA_DIR, 'Projets');     // archivage par projet
const ASSETS_DIR  = path.join(DATA_DIR, 'assets');
const SECRETS_PATH = path.join(DATA_DIR, 'secrets.json');
const LOGO_URL    = 'https://innovaspray.com/wp-content/uploads/2025/09/organization_logo_par.jpg';

// Créer les dossiers nécessaires
if (!fs.existsSync(DATA_DIR))     fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR))  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!fs.existsSync(ASSETS_DIR))   fs.mkdirSync(ASSETS_DIR, { recursive: true });

// ── Logo de marque pour les PDF (mise en cache locale, best-effort) ──
const LOGO_PATH = path.join(ASSETS_DIR, 'logo.jpg');
let LOGO_BUF = null;
function loadLogo() {
  try { if (fs.existsSync(LOGO_PATH)) { LOGO_BUF = fs.readFileSync(LOGO_PATH); return; } } catch (e) {}
  // Télécharger une fois, puis mettre en cache
  fetch(LOGO_URL).then(function (r) { return r.ok ? r.arrayBuffer() : null; })
    .then(function (ab) {
      if (!ab) return;
      LOGO_BUF = Buffer.from(ab);
      try { fs.writeFileSync(LOGO_PATH, LOGO_BUF); } catch (e) {}
    })
    .catch(function () { /* en-tête texte utilisé en repli */ });
}
loadLogo();

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

  CREATE TABLE IF NOT EXISTS daily_reports (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at     TEXT NOT NULL,
    report_date    TEXT,
    employee_name  TEXT,
    employee_uid   TEXT,
    job_number     TEXT,
    job_name       TEXT,
    client_name    TEXT,
    arrival_time   TEXT,
    departure_time TEXT,
    hours_worked   TEXT,
    work_done      TEXT,
    materials_used TEXT,
    problems       TEXT,
    remaining_work TEXT,
    comments       TEXT,
    signature      TEXT,
    status         TEXT NOT NULL DEFAULT 'brouillon',
    email_to       TEXT,
    email_error    TEXT,
    email_sent_at  TEXT,
    photos_json    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_dr_date ON daily_reports (report_date);
  CREATE INDEX IF NOT EXISTS idx_dr_job  ON daily_reports (job_number);
  CREATE INDEX IF NOT EXISTS idx_dr_emp  ON daily_reports (employee_name);
  CREATE INDEX IF NOT EXISTS idx_dr_stat ON daily_reports (status);

  CREATE TABLE IF NOT EXISTS email_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id    INTEGER NOT NULL,
    attempted_at TEXT NOT NULL,
    success      INTEGER NOT NULL,
    message      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_el_report ON email_logs (report_id);
`);

// ── Migration : colonnes ajoutées pour le module PDF (idempotent) ──
function ensureColumn(table, col, type) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
  if (!cols.some(function (c) { return c.name === col; })) {
    db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + type);
  }
}
ensureColumn('daily_reports', 'details_json', 'TEXT');  // champs étendus + matériaux + coûts
ensureColumn('daily_reports', 'pdfs_json', 'TEXT');     // métadonnées des PDF générés

// ── Statements (existant) ──────────────────────────────────────────
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

// ── Statements (comptes rendus) ────────────────────────────────────
const stmtDRInsert = db.prepare(`
  INSERT INTO daily_reports
    (created_at, report_date, employee_name, employee_uid, job_number, job_name, client_name,
     arrival_time, departure_time, hours_worked, work_done, materials_used, problems,
     remaining_work, comments, signature, status, email_to, photos_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
const stmtDRGet      = db.prepare('SELECT * FROM daily_reports WHERE id = ?');
const stmtDRSetSent  = db.prepare("UPDATE daily_reports SET status='envoye', email_sent_at=?, email_error=NULL WHERE id=?");
const stmtDRSetError = db.prepare("UPDATE daily_reports SET status='erreur', email_error=? WHERE id=?");
const stmtDRPhotos   = db.prepare('UPDATE daily_reports SET photos_json=? WHERE id=?');
const stmtDRDetails  = db.prepare('UPDATE daily_reports SET details_json=? WHERE id=?');
const stmtDRPdfs     = db.prepare('UPDATE daily_reports SET pdfs_json=? WHERE id=?');
const stmtDRByJob    = db.prepare('SELECT * FROM daily_reports WHERE job_number = ? ORDER BY report_date ASC, created_at ASC');

const stmtLogInsert  = db.prepare('INSERT INTO email_logs (report_id, attempted_at, success, message) VALUES (?,?,?,?)');
const stmtLogByReport = db.prepare('SELECT * FROM email_logs WHERE report_id = ? ORDER BY attempted_at DESC');

// ── Secrets (fichier server-only, jamais servi au navigateur) ──────
function loadSecrets() {
  try { return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')); } catch (e) { return {}; }
}
function saveSecrets(obj) {
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(obj, null, 2), 'utf8');
}
// Garantir un secret de signature de jetons
let _secrets = loadSecrets();
if (!_secrets.tokenSecret) {
  _secrets.tokenSecret = crypto.randomBytes(32).toString('hex');
  saveSecrets(_secrets);
}
function getTokenSecret() { return loadSecrets().tokenSecret || _secrets.tokenSecret; }

/** Configuration courriel effective : variables d'environnement > fichier > défauts. */
function getEmailConfig() {
  const f = loadSecrets().email || {};
  return {
    smtpUser:  process.env.ISQ_SMTP_USER       || f.smtpUser  || '',
    smtpPass:  process.env.ISQ_SMTP_PASS       || f.smtpPass  || '',
    recipient: process.env.ISQ_EMAIL_TO        || f.recipient || 'garonedouard@gmail.com',
    fromName:  process.env.ISQ_EMAIL_FROM_NAME || f.fromName  || 'InnovaSpray Québec',
    smtpHost:  process.env.ISQ_SMTP_HOST       || f.smtpHost  || 'smtp.gmail.com',
    smtpPort:  Number(process.env.ISQ_SMTP_PORT || f.smtpPort || 465)
  };
}

// ── Authentification ───────────────────────────────────────────────
const auth = makeAuth({
  getKV: function (key) { const r = stmtGet.get(key); return r ? r.value : null; },
  getSecret: getTokenSecret
});

// ── Middleware ─────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));

// Bloquer l'accès statique aux fichiers sensibles (base de données, secrets,
// code serveur, dépendances). Sécurité : empêche le téléchargement de /data/chantier.db, etc.
const BLOCKED_PATHS = /^\/(data|node_modules)(\/|$)/i;
const BLOCKED_FILES = /^\/(server(-auth|-email)?\.js|package(-lock)?\.json|secrets\.json)$/i;
app.use(function (req, res, next) {
  if (BLOCKED_PATHS.test(req.path) || BLOCKED_FILES.test(req.path)) {
    return res.status(403).send('Accès interdit.');
  }
  next();
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

// ── API /api/kv (existant) ─────────────────────────────────────────
app.get('/api/kv', (req, res) => {
  const rows = stmtGetAll.all();
  const data = {};
  rows.forEach(r => { data[r.key] = r.value; });
  res.json(data);
});
app.get('/api/kv/:key', (req, res) => {
  const row = stmtGet.get(req.params.key);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ value: row.value });
});
app.post('/api/kv/:key', (req, res) => {
  const { value } = req.body;
  if (value === undefined || value === null) return res.status(400).json({ error: 'Missing value' });
  stmtSet.run(req.params.key, String(value));
  res.json({ ok: true });
});
app.delete('/api/kv/:key', (req, res) => {
  stmtDel.run(req.params.key);
  res.json({ ok: true });
});

// ── API /api/saves (existant) ──────────────────────────────────────
app.post('/api/saves', (req, res) => {
  const { timestamp, docType, jobNumber, trigger, data } = req.body;
  if (!timestamp || !docType) return res.status(400).json({ error: 'Missing fields' });
  stmtSaveInsert.run(timestamp, docType, String(jobNumber || ''), String(trigger || ''), JSON.stringify(data || {}));
  res.json({ ok: true });
});
app.get('/api/saves', (req, res) => {
  const rows = stmtSaveGetAll.all();
  res.json(rows.map(r => ({
    id: r.id, timestamp: r.timestamp, docType: r.doc_type,
    jobNumber: r.job_number, trigger: r.trigger, data: JSON.parse(r.data)
  })));
});
app.get('/api/saves/stats', (req, res) => {
  const total     = stmtSaveCount.get().cnt;
  const byDocRows = stmtSaveStats.all();
  const byDoc     = { bon_travail: 0, fiche_chantier: 0, checklist: 0, materiaux: 0, satisfaction: 0 };
  let   lastSave  = null;
  byDocRows.forEach(r => { byDoc[r.doc_type] = r.cnt; if (!lastSave || r.last_ts > lastSave) lastSave = r.last_ts; });
  res.json({ total, byDoc, lastSave });
});
app.delete('/api/saves/:id', (req, res) => { stmtSaveDelete.run(Number(req.params.id)); res.json({ ok: true }); });
app.delete('/api/saves', (req, res) => { stmtSaveClear.run(); res.json({ ok: true }); });

// ════════════════════════════════════════════════════════════════════
//  AUTHENTIFICATION
// ════════════════════════════════════════════════════════════════════

// POST /api/session — connexion, renvoie un jeton signé
app.post('/api/session', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
  const result = auth.login(username, password);
  if (result && result.error === 'no_users') {
    return res.status(503).json({ error: "Aucun compte n'existe encore. Ouvrez l'application une première fois pour créer le compte admin." });
  }
  if (!result) return res.status(401).json({ error: "Nom d'utilisateur ou mot de passe incorrect." });
  res.json({ ok: true, token: result.token, exp: result.exp, user: result.user });
});

// GET /api/session/me — vérifier le jeton courant
app.get('/api/session/me', auth.requireAuth, (req, res) => {
  res.json({ ok: true, user: { id: req.user.uid, nom: req.user.nom, username: req.user.username, role: req.user.role } });
});

// ════════════════════════════════════════════════════════════════════
//  CONFIGURATION COURRIEL (admin)
// ════════════════════════════════════════════════════════════════════

// GET /api/email-config — config effective (mot de passe masqué)
app.get('/api/email-config', auth.requireAdmin, (req, res) => {
  const cfg = getEmailConfig();
  const envManaged = !!process.env.ISQ_SMTP_PASS;
  res.json({
    smtpUser: cfg.smtpUser,
    recipient: cfg.recipient,
    fromName: cfg.fromName,
    smtpHost: cfg.smtpHost,
    smtpPort: cfg.smtpPort,
    hasPassword: !!cfg.smtpPass,
    envManaged: envManaged
  });
});

// POST /api/email-config — enregistrer la config (mot de passe optionnel : si vide, conserve l'ancien)
app.post('/api/email-config', auth.requireAdmin, (req, res) => {
  const b = req.body || {};
  const s = loadSecrets();
  const prev = s.email || {};
  s.email = {
    smtpUser:  (b.smtpUser  != null ? String(b.smtpUser).trim()  : prev.smtpUser)  || '',
    recipient: (b.recipient != null ? String(b.recipient).trim() : prev.recipient) || '',
    fromName:  (b.fromName  != null ? String(b.fromName).trim()  : prev.fromName)  || 'InnovaSpray Québec',
    smtpHost:  (b.smtpHost  != null ? String(b.smtpHost).trim()  : prev.smtpHost)  || 'smtp.gmail.com',
    smtpPort:  Number(b.smtpPort || prev.smtpPort || 465),
    // Si un nouveau mot de passe est fourni, le remplacer ; sinon conserver l'ancien
    smtpPass:  (b.smtpPass && String(b.smtpPass).trim()) ? String(b.smtpPass).trim() : (prev.smtpPass || '')
  };
  saveSecrets(s);
  res.json({ ok: true });
});

// POST /api/email-config/test — vérifier la connexion SMTP
app.post('/api/email-config/test', auth.requireAdmin, async (req, res) => {
  try {
    await email.verifyTransport(getEmailConfig());
    res.json({ ok: true, message: 'Connexion SMTP réussie. La configuration courriel est valide.' });
  } catch (err) {
    res.status(400).json({ ok: false, error: 'Échec de la connexion SMTP : ' + (err && err.message ? err.message : String(err)) });
  }
});

// ════════════════════════════════════════════════════════════════════
//  COMPTES RENDUS QUOTIDIENS
// ════════════════════════════════════════════════════════════════════

const STAGE_LABELS = { avant: 'Avant', pendant: 'Pendant', apres: 'Après' };
const EXT_BY_MIME  = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };
const MAX_ATTACH_BYTES = 18 * 1024 * 1024; // ~18 Mo de pièces jointes max

function rowToReport(r) {
  let photos = [], details = {}, pdfs = [];
  try { photos = JSON.parse(r.photos_json || '[]'); } catch (e) {}
  try { details = JSON.parse(r.details_json || '{}'); } catch (e) {}
  try { pdfs = JSON.parse(r.pdfs_json || '[]'); } catch (e) {}
  return {
    id: r.id, created_at: r.created_at, report_date: r.report_date,
    employee_name: r.employee_name, employee_uid: r.employee_uid,
    job_number: r.job_number, job_name: r.job_name, client_name: r.client_name,
    arrival_time: r.arrival_time, departure_time: r.departure_time, hours_worked: r.hours_worked,
    work_done: r.work_done, materials_used: r.materials_used, problems: r.problems,
    remaining_work: r.remaining_work, comments: r.comments, signature: r.signature,
    status: r.status, email_to: r.email_to, email_error: r.email_error, email_sent_at: r.email_sent_at,
    photos: photos, details: details, pdfs: pdfs
  };
}

function decodeDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  try { return { mime: m[1].toLowerCase(), buffer: Buffer.from(m[2], 'base64') }; }
  catch (e) { return null; }
}

// Écrit les photos sur disque et renvoie les métadonnées
function storePhotos(reportId, photosInput) {
  const dir = path.join(UPLOADS_DIR, String(reportId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const meta = [];
  const counters = {};
  (photosInput || []).forEach(function (ph) {
    const stage = (ph && ph.stage && STAGE_LABELS[ph.stage]) ? ph.stage : 'pendant';
    const decoded = decodeDataUrl(ph && ph.dataUrl);
    if (!decoded) return;
    counters[stage] = (counters[stage] || 0) + 1;
    const ext = EXT_BY_MIME[decoded.mime] || 'jpg';
    const filename = stage + '_' + counters[stage] + '.' + ext;
    fs.writeFileSync(path.join(dir, filename), decoded.buffer);
    meta.push({ stage: stage, label: STAGE_LABELS[stage] + ' ' + counters[stage], filename: filename, size: decoded.buffer.length, mime: decoded.mime });
  });
  return meta;
}

function baseUrlFromReq(req) {
  const override = (loadSecrets().appBaseUrl || process.env.ISQ_APP_URL || '').trim();
  if (override) return override.replace(/\/$/, '');
  return req.protocol + '://' + req.get('host');
}

// ── Archivage & génération PDF ──────────────────────────────────────
function sanitizeSeg(str) {
  return String(str == null ? '' : str)
    .replace(/[\/\\:*?"<>|]+/g, '-')   // caractères interdits dans les noms de fichier
    .replace(/\s+/g, ' ').trim().slice(0, 80) || 'Projet';
}

function projectFolderName(report) {
  return sanitizeSeg(report.job_name || report.job_number || 'Projet');
}

// Crée la structure Projets/<NomProjet>/{ComptesRendus,Photos,BonsTravail,...}
function ensureProjectDirs(name) {
  const base = path.join(PROJECTS_DIR, sanitizeSeg(name));
  const dirs = {
    base:     base,
    cr:       path.join(base, 'ComptesRendus'),
    photos:   path.join(base, 'Photos'),
    bons:     path.join(base, 'BonsTravail'),
    fiches:   path.join(base, 'FichesChantier'),
    mat:      path.join(base, 'Materiaux'),
    complets: path.join(base, 'RapportsComplets')
  };
  Object.keys(dirs).forEach(function (k) { if (!fs.existsSync(dirs[k])) fs.mkdirSync(dirs[k], { recursive: true }); });
  return dirs;
}

// Coût matériel de la journée = somme(qté utilisée × coût unitaire), hors outils
function computeDayCost(materials) {
  let total = 0;
  (materials || []).forEach(function (m) {
    if (!m || m.category === 'outil') return;
    total += (Number(m.used) || 0) * (Number(m.unit_cost) || 0);
  });
  return Math.round(total * 100) / 100;
}

// Coût matériel cumulé des autres comptes rendus du même chantier
function getTotalCostBefore(jobNumber, excludeId) {
  if (!jobNumber) return 0;
  let sum = 0;
  stmtDRByJob.all(jobNumber).forEach(function (r) {
    if (r.id === excludeId) return;
    try { const d = JSON.parse(r.details_json || '{}'); sum += (Number(d.day_cost) || 0); } catch (e) {}
  });
  return Math.round(sum * 100) / 100;
}

// Historique des interventions (autres comptes rendus du même chantier)
function getHistory(jobNumber, excludeId) {
  if (!jobNumber) return [];
  return stmtDRByJob.all(jobNumber)
    .filter(function (r) { return r.id !== excludeId; })
    .map(function (r) {
      return { date: r.report_date, employee: r.employee_name, hours: r.hours_worked, work: (r.work_done || '').slice(0, 160) };
    })
    .slice(-15);
}

// Photos sur disque avec chemins absolus
function getPhotoFiles(report) {
  const dir = path.join(UPLOADS_DIR, String(report.id));
  return (report.photos || [])
    .map(function (p) { return { stage: p.stage, label: p.label, filename: p.filename, path: path.join(dir, p.filename) }; })
    .filter(function (p) { return fs.existsSync(p.path); });
}

// Pages réelles de l'app rendues en PDF (fidèles aux documents remplis)
const RENDER_DOCS = [
  { type: 'bon_travail',    label: 'Bon de travail',      page: 'Bon de travail.html',  title: 'Bon de travail',      fileBase: 'BonTravail',     dirKey: 'bons' },
  { type: 'fiche_chantier', label: 'Fiche de chantier',   page: 'fiche_chantier.html',  title: 'Fiche de chantier',   fileBase: 'FicheChantier',  dirKey: 'fiches' },
  { type: 'materiaux',      label: 'Suivi des matériaux', page: 'suivi_materiaux.html', title: 'Suivi des matériaux', fileBase: 'SuiviMateriaux', dirKey: 'mat' }
];

// Génère les PDF en rendant les VRAIES pages du chantier, les archive,
// fusionne en Rapport complet, met à jour pdfs_json ; renvoie les métadonnées.
async function generateAndArchivePdfs(reportRow) {
  const report  = rowToReport(reportRow);
  const details = report.details || {};
  const photos  = getPhotoFiles(report);

  const dirs = ensureProjectDirs(projectFolderName(report));
  const proj = projectFolderName(report);
  const date = sanitizeSeg(report.report_date || 'sans-date');
  const baseUrl = 'http://127.0.0.1:' + PORT;
  const dateStr = report.report_date || '';
  const logoDataUrl = LOGO_BUF ? ('data:image/jpeg;base64,' + LOGO_BUF.toString('base64')) : '';

  // Paramètres d'URL : identité du chantier (les pages chargent ensuite les
  // données sauvegardées isq_bon_travail_<job>, isq_fiche_<job>_jX, etc.)
  const params = {};
  if (report.job_number)   params.job_number   = report.job_number;
  if (report.client_name)  params.client_name  = report.client_name;
  if (details.job_address) params.job_address  = details.job_address;
  if (details.foreman_name)params.foreman_name = details.foreman_name;
  if (details.start_date)  params.start_date   = details.start_date;

  const meta = [];
  const buffers = {};
  for (const def of RENDER_DOCS) {
    try {
      const buf = await render.renderPageToPdf({
        baseUrl: baseUrl, pagePath: def.page, params: params,
        docTitle: def.title, dateStr: dateStr, logoDataUrl: logoDataUrl,
        sessionName: details.foreman_name || report.employee_name || ''
      });
      const name = def.fileBase + '_' + proj + '_' + date + '.pdf';
      const full = path.join(dirs[def.dirKey], name);
      fs.writeFileSync(full, buf);
      meta.push({ type: def.type, label: def.label, filename: name, path: full, size: buf.length });
      buffers[def.type] = buf;
    } catch (e) { console.error('Rendu PDF ' + def.type + ' échoué:', e && e.message ? e.message : e); }
  }

  // Rapport complet = fusion des documents rendus (archive officielle)
  try {
    const merged = await LibPDF.create();
    for (const def of RENDER_DOCS) {
      const b = buffers[def.type];
      if (!b) continue;
      const src = await LibPDF.load(b);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(function (p) { merged.addPage(p); });
    }
    if (merged.getPageCount() > 0) {
      const cbuf = Buffer.from(await merged.save());
      const cname = 'RapportComplet_' + proj + '_' + date + '.pdf';
      const cfull = path.join(dirs.complets, cname);
      fs.writeFileSync(cfull, cbuf);
      meta.push({ type: 'complet', label: 'Rapport complet', filename: cname, path: cfull, size: cbuf.length });
    }
  } catch (e) { console.error('Fusion rapport complet échouée:', e && e.message ? e.message : e); }

  // Archiver aussi les photos du jour
  try {
    const pdir = path.join(dirs.photos, date + '_cr' + report.id);
    if (!fs.existsSync(pdir)) fs.mkdirSync(pdir, { recursive: true });
    photos.forEach(function (ph) { try { fs.copyFileSync(ph.path, path.join(pdir, ph.filename)); } catch (e) {} });
  } catch (e) {}

  stmtDRPdfs.run(JSON.stringify(meta), report.id);
  return meta;
}

// Tente l'envoi du courriel (avec les 4 PDF joints) ; met à jour statut + logs
async function attemptSend(reportRow, baseUrl) {
  let report = rowToReport(reportRow);
  const cfg = getEmailConfig();

  // S'assurer que les PDF existent (les générer au besoin)
  let pdfs = report.pdfs;
  if (!pdfs || !pdfs.length || !pdfs.every(function (p) { return fs.existsSync(p.path); })) {
    try { pdfs = await generateAndArchivePdfs(reportRow); report = rowToReport(stmtDRGet.get(report.id)); }
    catch (e) { pdfs = report.pdfs || []; }
  }

  // Pièces jointes PDF
  const attachments = pdfs.filter(function (p) { return fs.existsSync(p.path); })
                          .map(function (p) { return { filename: p.filename, path: p.path }; });

  // Photos : jusqu'à 3 intégrées (cid) + liens de secours signés
  const dir = path.join(UPLOADS_DIR, String(report.id));
  const inlinePhotos = [];
  const photoLinks = [];
  report.photos.forEach(function (p, idx) {
    const filePath = path.join(dir, p.filename);
    const sig = auth.signResource(report.id + '/' + p.filename);
    photoLinks.push({
      label: p.label,
      url: baseUrl + '/api/daily-reports/' + report.id + '/photos/' + encodeURIComponent(p.filename) + '?sig=' + sig
    });
    if (fs.existsSync(filePath) && inlinePhotos.length < 3) {
      inlinePhotos.push({ cid: 'photo' + idx, path: filePath, label: p.label });
    }
  });

  try {
    const info = await email.sendReportEmail({
      cfg: cfg, report: report, details: report.details,
      attachments: attachments, inlinePhotos: inlinePhotos, photoLinks: photoLinks
    });
    const sentAt = new Date().toISOString();
    stmtDRSetSent.run(sentAt, report.id);
    stmtLogInsert.run(report.id, sentAt, 1, 'Envoyé à ' + cfg.recipient + ' avec ' + attachments.length + ' PDF' + (info.messageId ? ' (id: ' + info.messageId + ')' : ''));
    return { ok: true, status: 'envoye', sentAt: sentAt, recipient: cfg.recipient };
  } catch (err) {
    const msg = (err && err.message ? err.message : String(err));
    stmtDRSetError.run(msg, report.id);
    stmtLogInsert.run(report.id, new Date().toISOString(), 0, msg);
    return { ok: false, status: 'erreur', error: msg };
  }
}

// POST /api/daily-reports — créer + envoyer (tout utilisateur connecté)
app.post('/api/daily-reports', auth.requireAuth, async (req, res) => {
  const b = req.body || {};

  // Validation
  const missing = [];
  if (!b.employee_name || !String(b.employee_name).trim()) missing.push('nom de l\'employé');
  if (!b.report_date   || !String(b.report_date).trim())   missing.push('date');
  if ((!b.job_number || !String(b.job_number).trim()) && (!b.job_name || !String(b.job_name).trim())) missing.push('chantier');
  if (!b.work_done || !String(b.work_done).trim())         missing.push('travaux réalisés');
  if (missing.length) {
    return res.status(400).json({ ok: false, error: 'Champs requis manquants : ' + missing.join(', ') + '.' });
  }

  const cfg = getEmailConfig();
  const createdAt = new Date().toISOString();

  // 1. Sauvegarder le rapport (statut initial : brouillon)
  const info = stmtDRInsert.run(
    createdAt,
    String(b.report_date || ''),
    String(b.employee_name || '').trim(),
    req.user.uid || '',
    String(b.job_number || '').trim(),
    String(b.job_name || '').trim(),
    String(b.client_name || '').trim(),
    String(b.arrival_time || ''),
    String(b.departure_time || ''),
    String(b.hours_worked || ''),
    String(b.work_done || ''),
    String(b.materials_used || ''),
    String(b.problems || ''),
    String(b.remaining_work || ''),
    String(b.comments || ''),
    String(b.signature || '').trim(),
    'brouillon',
    cfg.recipient,
    '[]'
  );
  const reportId = Number(info.lastInsertRowid);

  // 2. Stocker les photos
  let photosMeta = [];
  try { photosMeta = storePhotos(reportId, b.photos); } catch (e) { photosMeta = []; }
  stmtDRPhotos.run(JSON.stringify(photosMeta), reportId);

  // 2b. Champs étendus + matériaux + calcul des coûts
  const details = (b.details && typeof b.details === 'object') ? b.details : {};
  const materials = Array.isArray(b.materials) ? b.materials
                    : (Array.isArray(details.materials) ? details.materials : []);
  details.materials = materials;
  const dayCost = computeDayCost(materials);
  const totalBefore = getTotalCostBefore(String(b.job_number || '').trim(), reportId);
  details.day_cost = dayCost;
  details.total_cost_before = totalBefore;
  details.total_cost = Math.round((totalBefore + dayCost) * 100) / 100;
  stmtDRDetails.run(JSON.stringify(details), reportId);

  // 2c. Générer + archiver les 4 PDF (même si le courriel n'est pas configuré)
  try { await generateAndArchivePdfs(stmtDRGet.get(reportId)); }
  catch (e) { console.error('Génération PDF échouée:', e && e.message ? e.message : e); }

  // 3. Tenter l'envoi
  if (!cfg.smtpUser || !cfg.smtpPass) {
    const msg = "Courriel non configuré : un administrateur doit saisir l'identifiant Gmail et le mot de passe d'application dans Configuration.";
    stmtDRSetError.run(msg, reportId);
    stmtLogInsert.run(reportId, new Date().toISOString(), 0, msg);
    return res.status(200).json({
      ok: true, saved: true, emailSent: false, id: reportId, status: 'erreur',
      message: 'Compte rendu enregistré et PDF générés, mais le courriel n\'a pas pu être envoyé.', error: msg
    });
  }

  const sendResult = await attemptSend(stmtDRGet.get(reportId), baseUrlFromReq(req));
  if (sendResult.ok) {
    return res.status(201).json({
      ok: true, saved: true, emailSent: true, id: reportId, status: 'envoye',
      message: 'Compte rendu envoyé au bureau (' + sendResult.recipient + ').'
    });
  }
  return res.status(200).json({
    ok: true, saved: true, emailSent: false, id: reportId, status: 'erreur',
    message: 'Compte rendu enregistré, mais l\'envoi du courriel a échoué. Vous pouvez réessayer.',
    error: sendResult.error
  });
});

// GET /api/daily-reports — liste filtrée (admin)
app.get('/api/daily-reports', auth.requireAdmin, (req, res) => {
  const cond = [];
  const params = [];
  if (req.query.date)     { cond.push('report_date = ?');       params.push(String(req.query.date)); }
  if (req.query.from)     { cond.push('report_date >= ?');      params.push(String(req.query.from)); }
  if (req.query.to)       { cond.push('report_date <= ?');      params.push(String(req.query.to)); }
  if (req.query.job)      { cond.push('(job_number = ? OR job_name LIKE ?)'); params.push(String(req.query.job)); params.push('%' + req.query.job + '%'); }
  if (req.query.employee) { cond.push('employee_name LIKE ?');  params.push('%' + req.query.employee + '%'); }
  if (req.query.status)   { cond.push('status = ?');            params.push(String(req.query.status)); }

  const where = cond.length ? (' WHERE ' + cond.join(' AND ')) : '';
  const rows = db.prepare('SELECT * FROM daily_reports' + where + ' ORDER BY created_at DESC').all(...params);
  res.json(rows.map(rowToReport));
});

// GET /api/daily-reports/:id — détail + logs (admin)
app.get('/api/daily-reports/:id', auth.requireAdmin, (req, res) => {
  const row = stmtDRGet.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Compte rendu introuvable.' });
  const report = rowToReport(row);
  report.logs = stmtLogByReport.all(report.id).map(l => ({
    attempted_at: l.attempted_at, success: !!l.success, message: l.message
  }));
  res.json(report);
});

// POST /api/daily-reports/:id/resend — renvoyer (admin OU propriétaire du rapport)
app.post('/api/daily-reports/:id/resend', auth.requireAuth, async (req, res) => {
  const row = stmtDRGet.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Compte rendu introuvable.' });
  if (req.user.role !== 'admin' && row.employee_uid !== req.user.uid) {
    return res.status(403).json({ error: 'Vous ne pouvez renvoyer que vos propres comptes rendus.' });
  }
  const cfg = getEmailConfig();
  if (!cfg.smtpUser || !cfg.smtpPass) {
    return res.status(400).json({ ok: false, error: "Courriel non configuré. Un administrateur doit compléter la configuration." });
  }
  const result = await attemptSend(row, baseUrlFromReq(req));
  if (result.ok) return res.json({ ok: true, status: 'envoye', message: 'Courriel renvoyé à ' + result.recipient + '.' });
  return res.status(200).json({ ok: false, status: 'erreur', error: result.error, message: "L'envoi a de nouveau échoué." });
});

// GET /api/daily-reports/:id/photos/:filename — photo (jeton de session OU signature de ressource)
app.get('/api/daily-reports/:id/photos/:filename', (req, res) => {
  const id = String(Number(req.params.id));
  const filename = String(req.params.filename);
  // Anti-traversée : nom de fichier strict
  if (!/^[\w.\-]+$/.test(filename)) return res.status(400).send('Nom de fichier invalide.');

  const okSig = auth.verifyResource(id + '/' + filename, req.query.sig);
  const session = auth.authFromReq(req);
  if (!okSig && !session) return res.status(401).send('Accès non autorisé.');

  const filePath = path.join(UPLOADS_DIR, id, filename);
  const resolved = path.resolve(filePath);
  if (resolved.indexOf(path.resolve(UPLOADS_DIR)) !== 0 || !fs.existsSync(resolved)) {
    return res.status(404).send('Photo introuvable.');
  }
  res.sendFile(resolved);
});

// ════════════════════════════════════════════════════════════════════
//  DOCUMENTATION PDF DES PROJETS
// ════════════════════════════════════════════════════════════════════

// GET /api/daily-reports/:id/pdf/:type — servir un PDF (inline=prévisualiser, ?download=1=télécharger)
app.get('/api/daily-reports/:id/pdf/:type', (req, res) => {
  const id = Number(req.params.id);
  const type = String(req.params.type);
  const okSig = auth.verifyResource('pdf:' + id + '/' + type, req.query.sig);
  const session = auth.authFromReq(req);
  if (!okSig && !session) return res.status(401).send('Accès non autorisé.');

  const row = stmtDRGet.get(id);
  if (!row) return res.status(404).send('Compte rendu introuvable.');
  const report = rowToReport(row);
  const pdf = (report.pdfs || []).find(function (p) { return p.type === type; });
  if (!pdf || !fs.existsSync(pdf.path)) return res.status(404).send('PDF introuvable. Régénérez-le depuis la documentation.');

  res.setHeader('Content-Type', 'application/pdf');
  const disp = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', disp + '; filename="' + pdf.filename.replace(/[^\w.\-]+/g, '_') + '"');
  fs.createReadStream(pdf.path).pipe(res);
});

// GET /api/daily-reports/:id/pdf-zip — télécharger les 4 PDF en lot (admin)
app.get('/api/daily-reports/:id/pdf-zip', auth.requireAdmin, (req, res) => {
  const row = stmtDRGet.get(Number(req.params.id));
  if (!row) return res.status(404).send('Compte rendu introuvable.');
  const report = rowToReport(row);
  const pdfs = (report.pdfs || []).filter(function (p) { return fs.existsSync(p.path); });
  if (!pdfs.length) return res.status(404).send('Aucun PDF disponible.');

  const zipName = 'Documents_' + projectFolderName(report) + '_' + sanitizeSeg(report.report_date) + '.zip';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="' + zipName.replace(/[^\w.\-]+/g, '_') + '"');
  const arch = archiver('zip', { zlib: { level: 6 } });
  arch.on('error', function () { try { res.status(500).end(); } catch (e) {} });
  arch.pipe(res);
  pdfs.forEach(function (p) { arch.file(p.path, { name: p.filename }); });
  arch.finalize();
});

// POST /api/daily-reports/:id/regenerate — régénérer les 4 PDF (admin)
app.post('/api/daily-reports/:id/regenerate', auth.requireAdmin, async (req, res) => {
  const row = stmtDRGet.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Compte rendu introuvable.' });
  try {
    const meta = await generateAndArchivePdfs(row);
    res.json({ ok: true, pdfs: meta.map(function (m) { return { type: m.type, label: m.label, filename: m.filename, size: m.size }; }), message: 'Documents PDF régénérés.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Échec de la régénération : ' + (e && e.message ? e.message : String(e)) });
  }
});

// GET /api/documentation — documentation regroupée par projet (admin)
app.get('/api/documentation', auth.requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM daily_reports ORDER BY report_date DESC, created_at DESC').all();
  const projects = {};
  const order = [];
  rows.forEach(function (r) {
    const rep = rowToReport(r);
    const key = rep.job_number || rep.job_name || 'Sans projet';
    if (!projects[key]) {
      projects[key] = { project: rep.job_name || rep.job_number || 'Sans projet', job_number: rep.job_number, client_name: rep.client_name, reports: [] };
      order.push(key);
    }
    projects[key].reports.push({
      id: rep.id, report_date: rep.report_date, employee_name: rep.employee_name,
      status: rep.status, hours_worked: rep.hours_worked,
      day_cost: rep.details ? rep.details.day_cost : null,
      total_cost: rep.details ? rep.details.total_cost : null,
      pdfs: (rep.pdfs || []).map(function (p) { return { type: p.type, label: p.label, filename: p.filename, size: p.size }; })
    });
  });
  res.json(order.map(function (k) { return projects[k]; }));
});

// ── Pages HTML — injection de __ISQ_PRELOAD__ ──────────────────────
const STATIC_DIR = __dirname;

app.get(/\.html$/, (req, res) => {
  const filePath = path.join(STATIC_DIR, decodeURIComponent(req.path));
  if (!fs.existsSync(filePath)) return res.status(404).send('Page introuvable.');

  let html = fs.readFileSync(filePath, 'utf8');

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
  const cfg = getEmailConfig();
  console.log(`InnovaSpray Chantier v2 — http://localhost:${PORT}`);
  console.log(`Base de données        — ${DB_PATH}`);
  console.log(`Courriel               — ${cfg.smtpUser ? (cfg.smtpUser + ' → ' + cfg.recipient) : 'NON CONFIGURÉ (voir Configuration)'}`);
});
