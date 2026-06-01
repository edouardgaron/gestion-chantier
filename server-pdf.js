/**
 * server-pdf.js — InnovaSpray Québec
 * Génération native de PDF professionnels (PDFKit) + fusion (pdf-lib).
 * Aucune dépendance navigateur, aucune dépendance n8n. Tout est local.
 *
 * Documents :
 *   1. genBonTravail()       — BonTravail_[Projet]_[Date].pdf
 *   2. genFicheChantier()    — FicheChantier_[Projet]_[Date].pdf
 *   3. genSuiviMateriaux()   — SuiviMateriaux_[Projet]_[Date].pdf
 *   4. genRapportComplet()   — RapportComplet_[Projet]_[Date].pdf (cover + fusion)
 *
 * Chaque PDF : logo, en-tête + pied de page de marque, numérotation des pages.
 */
'use strict';

const PDFDocument = require('pdfkit');
const { PDFDocument: LibPDF } = require('pdf-lib');

// ── Marque ──
const BLEU   = '#0170B9';
const BLEU_F = '#014d82';
const ORANGE = '#FF6600';
const GRIS   = '#F4F6F9';
const GRIS_B = '#D0D7E3';
const TEXTE  = '#1A1A2E';
const VERT   = '#2E7D32';
const ROUGE  = '#C62828';

const MARGIN_L = 48;
const MARGIN_R = 48;
const HEADER_H = 96;   // zone réservée en haut
const FOOTER_H = 56;   // zone réservée en bas

function makeDoc(title) {
  return new PDFDocument({
    size: 'A4',
    bufferPages: true,
    margins: { top: HEADER_H + 14, bottom: FOOTER_H + 10, left: MARGIN_L, right: MARGIN_R },
    info: { Title: title, Author: 'InnovaSpray Québec', Creator: 'Application Gestion Chantier' }
  });
}

function contentWidth(doc) { return doc.page.width - MARGIN_L - MARGIN_R; }

function toBuffer(doc) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    doc.on('data', function (c) { chunks.push(c); });
    doc.on('end', function () { resolve(Buffer.concat(chunks)); });
    doc.on('error', reject);
    doc.end();
  });
}

function s(v) { return (v == null || String(v).trim() === '') ? '—' : String(v); }
function has(v) { return !(v == null || String(v).trim() === ''); }

// ── En-tête / pied de page dessinés en dernière passe sur toutes les pages ──
function paintHeaderFooter(doc, docTitle, assets) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i);
    const W = doc.page.width;
    // Neutraliser les marges pour que le dessin hors zone de contenu
    // ne déclenche pas l'ajout automatique d'une page par PDFKit.
    doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };

    // ── En-tête ──
    doc.save();
    // bande supérieure
    doc.rect(0, 0, W, HEADER_H).fill('#ffffff');
    let logoRight = MARGIN_L;
    if (assets && assets.logo) {
      try { doc.image(assets.logo, MARGIN_L, 22, { fit: [54, 54] }); logoRight = MARGIN_L + 66; }
      catch (e) { logoRight = MARGIN_L; }
    }
    doc.fillColor(BLEU).font('Helvetica-Bold').fontSize(16)
       .text('INNOVASPRAY QUÉBEC', logoRight, 26, { lineBreak: false });
    doc.fillColor('#777').font('Helvetica').fontSize(9)
       .text('info@innovaspray.ca  •  innovaspray.ca', logoRight, 46, { lineBreak: false });
    // titre du document à droite
    doc.fillColor(TEXTE).font('Helvetica-Bold').fontSize(13)
       .text(docTitle, W / 2, 30, { width: W / 2 - MARGIN_R, align: 'right', lineBreak: false });
    // filet orange/bleu
    doc.rect(MARGIN_L, HEADER_H - 12, W - MARGIN_L - MARGIN_R, 3).fill(ORANGE);
    doc.restore();

    // ── Pied de page ──
    doc.save();
    const fy = doc.page.height - FOOTER_H + 16;
    doc.moveTo(MARGIN_L, fy - 8).lineTo(W - MARGIN_R, fy - 8).lineWidth(0.7).strokeColor(GRIS_B).stroke();
    doc.fillColor('#999').font('Helvetica').fontSize(8);
    doc.text('InnovaSpray Québec — Document généré automatiquement', MARGIN_L, fy, { lineBreak: false });
    doc.text('Page ' + (i + 1) + ' / ' + total, W / 2, fy, { width: W / 2 - MARGIN_R, align: 'right', lineBreak: false });
    doc.restore();
  }
}

// ── Briques de mise en page ──
function ensureSpace(doc, h) {
  const limit = doc.page.height - FOOTER_H - 14;
  if (doc.y + h > limit) doc.addPage();
}

function sectionTitle(doc, title) {
  ensureSpace(doc, 40);
  const W = contentWidth(doc);
  doc.moveDown(0.4);
  const y = doc.y;
  doc.save();
  doc.rect(MARGIN_L, y, W, 22).fill(BLEU);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(10.5)
     .text(' ' + title.toUpperCase(), MARGIN_L + 4, y + 6, { width: W - 8, lineBreak: false });
  doc.restore();
  doc.y = y + 30;
  doc.x = MARGIN_L;
  doc.fillColor(TEXTE);
}

// Tableau clé/valeur (deux colonnes), bordé
function kvTable(doc, rows) {
  const W = contentWidth(doc);
  const kW = Math.round(W * 0.34);
  const vW = W - kW;
  doc.font('Helvetica').fontSize(10);
  rows.forEach(function (r) {
    const label = r[0];
    const value = s(r[1]);
    const vH = doc.heightOfString(value, { width: vW - 16 });
    const kH = doc.heightOfString(label, { width: kW - 16 });
    const rowH = Math.max(vH, kH, 14) + 12;
    ensureSpace(doc, rowH);
    const y = doc.y;
    doc.save();
    doc.rect(MARGIN_L, y, kW, rowH).fill(GRIS);
    doc.rect(MARGIN_L, y, W, rowH).lineWidth(0.6).strokeColor(GRIS_B).stroke();
    doc.moveTo(MARGIN_L + kW, y).lineTo(MARGIN_L + kW, y + rowH).strokeColor(GRIS_B).stroke();
    doc.restore();
    doc.fillColor('#555').font('Helvetica-Bold').fontSize(8.5)
       .text(label.toUpperCase(), MARGIN_L + 8, y + 6, { width: kW - 16 });
    doc.fillColor(TEXTE).font('Helvetica').fontSize(10)
       .text(value, MARGIN_L + kW + 8, y + 6, { width: vW - 16 });
    doc.y = y + rowH;
  });
  doc.x = MARGIN_L;
}

// Bloc texte étiqueté (paragraphe libre)
function textBlock(doc, label, value) {
  const W = contentWidth(doc);
  const val = s(value);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#555');
  const lblH = 14;
  const valH = doc.heightOfString(val, { width: W - 16, lineGap: 1 });
  ensureSpace(doc, lblH + valH + 16);
  doc.text(label.toUpperCase(), MARGIN_L, doc.y);
  doc.moveDown(0.2);
  const y = doc.y;
  doc.save();
  doc.rect(MARGIN_L, y, W, valH + 12).lineWidth(0.6).strokeColor(GRIS_B).stroke();
  doc.restore();
  doc.fillColor(TEXTE).font('Helvetica').fontSize(10)
     .text(val, MARGIN_L + 8, y + 6, { width: W - 16, lineGap: 1 });
  doc.y = y + valH + 12;
  doc.x = MARGIN_L;
  doc.moveDown(0.4);
}

function progressBar(doc, percent) {
  const W = contentWidth(doc);
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  ensureSpace(doc, 40);
  const y = doc.y;
  const barW = W;
  doc.save();
  doc.roundedRect(MARGIN_L, y, barW, 18, 4).fill('#e7edf3');
  if (p > 0) doc.roundedRect(MARGIN_L, y, Math.max(barW * p / 100, 8), 18, 4).fill(p >= 100 ? VERT : BLEU);
  doc.fillColor(p > 12 ? '#fff' : TEXTE).font('Helvetica-Bold').fontSize(10)
     .text(p + ' % complété', MARGIN_L, y + 4, { width: barW, align: 'center', lineBreak: false });
  doc.restore();
  doc.y = y + 28;
  doc.x = MARGIN_L;
}

// Grille de photos (3 par rangée) avec légendes
function photoGrid(doc, photos) {
  if (!photos || !photos.length) {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor('#999').text('Aucune photo pour cette journée.', MARGIN_L, doc.y);
    doc.fillColor(TEXTE);
    doc.moveDown(0.5);
    return;
  }
  const W = contentWidth(doc);
  const gap = 10;
  const cols = 3;
  const cw = (W - gap * (cols - 1)) / cols;
  const ch = cw * 0.75;
  for (let i = 0; i < photos.length; i += cols) {
    ensureSpace(doc, ch + 22);
    const rowY = doc.y;
    for (let j = 0; j < cols && (i + j) < photos.length; j++) {
      const ph = photos[i + j];
      const x = MARGIN_L + j * (cw + gap);
      doc.save();
      doc.rect(x, rowY, cw, ch).lineWidth(0.8).strokeColor(GRIS_B).stroke();
      try { doc.image(ph.path, x + 2, rowY + 2, { fit: [cw - 4, ch - 4], align: 'center', valign: 'center' }); }
      catch (e) {
        doc.fillColor('#bbb').fontSize(8).text('(image illisible)', x, rowY + ch / 2 - 4, { width: cw, align: 'center' });
      }
      doc.restore();
      doc.fillColor('#555').font('Helvetica-Bold').fontSize(8)
         .text(ph.label || '', x, rowY + ch + 3, { width: cw, align: 'center', lineBreak: false });
    }
    doc.y = rowY + ch + 18;
  }
  doc.x = MARGIN_L;
  doc.fillColor(TEXTE);
}

// Boîtes de signature
function signatureBoxes(doc, pairs) {
  const W = contentWidth(doc);
  const gap = 24;
  const bw = (W - gap) / 2;
  ensureSpace(doc, 70);
  const y = doc.y + 8;
  pairs.forEach(function (pr, idx) {
    const x = MARGIN_L + idx * (bw + gap);
    doc.fillColor(TEXTE).font('Helvetica').fontSize(11)
       .text(s(pr.value), x, y + 6, { width: bw, align: 'center', lineBreak: false });
    doc.moveTo(x, y + 32).lineTo(x + bw, y + 32).lineWidth(0.8).strokeColor('#888').stroke();
    doc.fillColor('#777').font('Helvetica-Bold').fontSize(8.5)
       .text(pr.label.toUpperCase(), x, y + 38, { width: bw, align: 'center', lineBreak: false });
  });
  doc.y = y + 56;
  doc.x = MARGIN_L;
}

function money(n) {
  const v = Number(n);
  if (isNaN(v)) return '—';
  return v.toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
}

// ════════════════════════════════════════════════════════════════════
//  PDF 1 — BON DE TRAVAIL QUOTIDIEN
// ════════════════════════════════════════════════════════════════════
async function genBonTravail(data) {
  const { report, details, photos, assets } = data;
  const d = details || {};
  const doc = makeDoc('Bon de travail');

  sectionTitle(doc, 'Informations générales');
  kvTable(doc, [
    ['Numéro du projet', report.job_number],
    ['Nom du client', report.client_name],
    ['Adresse du chantier', d.job_address],
    ['Date', report.report_date],
    ['Employé(s) présents', d.employees_present || report.employee_name],
    ["Chef d'équipe", d.foreman_name],
    ['Heure de début', report.arrival_time],
    ['Heure de fin', report.departure_time],
    ['Total d\'heures', report.hours_worked ? (report.hours_worked + ' h') : '']
  ]);

  sectionTitle(doc, 'Travaux réalisés');
  textBlock(doc, 'Description détaillée', report.work_done);
  textBlock(doc, 'Zones complétées', d.zones_completed);
  textBlock(doc, 'Travaux supplémentaires', d.extra_work);

  sectionTitle(doc, 'Photos du chantier');
  photoGrid(doc, photos);

  sectionTitle(doc, 'Validation');
  signatureBoxes(doc, [
    { label: 'Signature de l\'employé', value: report.signature },
    { label: "Signature du chef d'équipe", value: d.foreman_signature }
  ]);

  paintHeaderFooter(doc, 'Bon de travail', assets);
  return toBuffer(doc);
}

// ════════════════════════════════════════════════════════════════════
//  PDF 2 — FICHE DE CHANTIER
// ════════════════════════════════════════════════════════════════════
async function genFicheChantier(data) {
  const { report, details, photos, assets, history } = data;
  const d = details || {};
  const doc = makeDoc('Fiche de chantier');

  sectionTitle(doc, 'Client');
  kvTable(doc, [
    ['Nom', report.client_name],
    ['Téléphone', d.client_phone],
    ['Courriel', d.client_email]
  ]);

  sectionTitle(doc, 'Projet');
  kvTable(doc, [
    ['Numéro', report.job_number],
    ['Adresse', d.job_address],
    ['Type de travaux', d.work_type],
    ['Date de début', d.start_date],
    ['Date prévue de fin', d.end_date]
  ]);

  sectionTitle(doc, 'État du chantier');
  progressBar(doc, d.percent_complete);
  kvTable(doc, [
    ['Étape actuelle', d.current_step],
    ['Étapes restantes', d.remaining_steps]
  ]);

  sectionTitle(doc, 'Problèmes rencontrés');
  kvTable(doc, [
    ['Priorité', d.problem_priority]
  ]);
  textBlock(doc, 'Description', report.problems);
  textBlock(doc, 'Action corrective', d.corrective_action);

  sectionTitle(doc, 'Photos du chantier');
  photoGrid(doc, photos);

  sectionTitle(doc, 'Commentaires du superviseur');
  textBlock(doc, 'Commentaires', d.supervisor_comments);
  textBlock(doc, 'Notes importantes', d.important_notes);

  sectionTitle(doc, 'Historique des interventions');
  historyTable(doc, history);

  paintHeaderFooter(doc, 'Fiche de chantier', assets);
  return toBuffer(doc);
}

function historyTable(doc, history) {
  const W = contentWidth(doc);
  const cols = [
    { t: 'Date', w: W * 0.18 },
    { t: 'Employé', w: W * 0.27 },
    { t: 'Heures', w: W * 0.12 },
    { t: 'Travaux réalisés', w: W * 0.43 }
  ];
  // en-tête
  ensureSpace(doc, 24);
  let y = doc.y;
  let x = MARGIN_L;
  doc.save(); doc.rect(MARGIN_L, y, W, 18).fill(BLEU_F); doc.restore();
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8.5);
  cols.forEach(function (c) { doc.text(c.t, x + 5, y + 5, { width: c.w - 8, lineBreak: false }); x += c.w; });
  doc.y = y + 18;

  if (!history || !history.length) {
    doc.fillColor('#999').font('Helvetica-Oblique').fontSize(9).text('Aucune intervention antérieure enregistrée.', MARGIN_L + 5, doc.y + 4);
    doc.fillColor(TEXTE); doc.moveDown(0.6); return;
  }
  doc.font('Helvetica').fontSize(8.5).fillColor(TEXTE);
  history.forEach(function (h, idx) {
    const cells = [h.date || '', h.employee || '', (h.hours ? h.hours + ' h' : ''), h.work || ''];
    let rowH = 14;
    cells.forEach(function (txt, ci) { rowH = Math.max(rowH, doc.heightOfString(String(txt), { width: cols[ci].w - 10 })); });
    rowH += 10;
    ensureSpace(doc, rowH);
    y = doc.y; x = MARGIN_L;
    if (idx % 2 === 0) { doc.save(); doc.rect(MARGIN_L, y, W, rowH).fill('#f9fafb'); doc.restore(); }
    doc.save(); doc.rect(MARGIN_L, y, W, rowH).lineWidth(0.5).strokeColor(GRIS_B).stroke(); doc.restore();
    doc.fillColor(TEXTE).font('Helvetica').fontSize(8.5);
    cells.forEach(function (txt, ci) { doc.text(String(txt), x + 5, y + 5, { width: cols[ci].w - 10 }); x += cols[ci].w; });
    doc.y = y + rowH;
  });
  doc.x = MARGIN_L; doc.moveDown(0.4);
}

// ════════════════════════════════════════════════════════════════════
//  PDF 3 — SUIVI DES MATÉRIAUX
// ════════════════════════════════════════════════════════════════════
const CATEGORY_LABELS = { peinture: 'Peintures', materiau: 'Matériaux', outil: 'Outils' };

async function genSuiviMateriaux(data) {
  const { report, details, assets } = data;
  const d = details || {};
  const materials = Array.isArray(d.materials) ? d.materials : [];
  const doc = makeDoc('Suivi des matériaux');

  sectionTitle(doc, 'Identification');
  kvTable(doc, [
    ['Projet', report.job_number || report.job_name],
    ['Client', report.client_name],
    ['Date', report.report_date],
    ['Employé', report.employee_name]
  ]);

  // Regrouper par catégorie
  const groups = { peinture: [], materiau: [], outil: [] };
  materials.forEach(function (m) {
    const cat = groups[m.category] ? m.category : 'materiau';
    groups[cat].push(m);
  });

  let dayCost = 0;
  ['peinture', 'materiau', 'outil'].forEach(function (cat) {
    const items = groups[cat];
    if (!items.length) return;
    sectionTitle(doc, CATEGORY_LABELS[cat]);
    dayCost += materialsTable(doc, cat, items);
  });

  if (!materials.length) {
    sectionTitle(doc, 'Matériaux');
    doc.font('Helvetica-Oblique').fontSize(10).fillColor('#999')
       .text('Aucun matériau saisi pour cette journée.', MARGIN_L, doc.y);
    doc.fillColor(TEXTE); doc.moveDown(0.5);
  }

  // Totaux
  sectionTitle(doc, 'Calcul automatique des coûts');
  const totalProject = (Number(d.total_cost_before) || 0) + dayCost;
  kvTable(doc, [
    ['Valeur consommée (jour)', money(dayCost)],
    ['Coût matériel de la journée', money(dayCost)],
    ['Coût total du chantier à ce jour', money(totalProject)]
  ]);

  // exposer le coût du jour calculé
  data._dayCost = dayCost;
  data._totalCost = totalProject;

  paintHeaderFooter(doc, 'Suivi des matériaux', assets);
  return toBuffer(doc);
}

// Renvoie le coût total de la catégorie
function materialsTable(doc, cat, items) {
  const W = contentWidth(doc);
  const isTool = (cat === 'outil');
  // Colonnes
  let cols;
  if (isTool) {
    cols = [
      { t: 'Outil', w: W * 0.40, key: 'item' },
      { t: 'Utilisé', w: W * 0.18, key: 'used' },
      { t: 'Restant', w: W * 0.18, key: 'remaining' },
      { t: 'Bris / perte', w: W * 0.12, key: 'broken' },
      { t: 'Rempl.', w: W * 0.12, key: 'replace' }
    ];
  } else {
    cols = [
      { t: (cat === 'peinture' ? 'Produit / couleur' : 'Matériau'), w: W * 0.30, key: 'item' },
      { t: 'Utilisé', w: W * 0.13, key: 'used' },
      { t: 'Restant', w: W * 0.13, key: 'remaining' },
      { t: 'Bris', w: W * 0.10, key: 'broken' },
      { t: 'Coût unit.', w: W * 0.16, key: 'unit_cost' },
      { t: 'Valeur', w: W * 0.18, key: 'value' }
    ];
  }
  // en-tête
  ensureSpace(doc, 22);
  let y = doc.y, x = MARGIN_L;
  doc.save(); doc.rect(MARGIN_L, y, W, 18).fill(BLEU_F); doc.restore();
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8.5);
  cols.forEach(function (c) { doc.text(c.t, x + 5, y + 5, { width: c.w - 8, lineBreak: false }); x += c.w; });
  doc.y = y + 18;

  let catCost = 0;
  doc.font('Helvetica').fontSize(8.5).fillColor(TEXTE);
  items.forEach(function (m, idx) {
    const product = (cat === 'peinture' && has(m.color)) ? (s(m.item) + ' — ' + m.color) : s(m.item);
    const value = (Number(m.used) || 0) * (Number(m.unit_cost) || 0);
    if (!isTool) catCost += value;
    let cells;
    if (isTool) {
      cells = [product, s(m.used), s(m.remaining), (m.broken ? 'Oui' : '—'), (m.replace ? 'Oui' : '—')];
    } else {
      cells = [product, s(m.used), s(m.remaining), (m.broken ? 'Oui' : '—'), has(m.unit_cost) ? money(m.unit_cost) : '—', money(value)];
    }
    let rowH = 13;
    cells.forEach(function (txt, ci) { rowH = Math.max(rowH, doc.heightOfString(String(txt), { width: cols[ci].w - 10 })); });
    rowH += 9;
    ensureSpace(doc, rowH);
    y = doc.y; x = MARGIN_L;
    if (idx % 2 === 0) { doc.save(); doc.rect(MARGIN_L, y, W, rowH).fill('#f9fafb'); doc.restore(); }
    doc.save(); doc.rect(MARGIN_L, y, W, rowH).lineWidth(0.5).strokeColor(GRIS_B).stroke(); doc.restore();
    doc.fillColor(TEXTE).font('Helvetica').fontSize(8.5);
    cells.forEach(function (txt, ci) {
      const alignRight = !isTool && (ci >= 4);
      doc.text(String(txt), x + 5, y + 5, { width: cols[ci].w - 10, align: alignRight ? 'right' : 'left' });
      x += cols[ci].w;
    });
    doc.y = y + rowH;
  });
  doc.x = MARGIN_L; doc.moveDown(0.3);
  return catCost;
}

// ════════════════════════════════════════════════════════════════════
//  PDF 4 — RAPPORT JOURNALIER COMPLET (cover PDFKit + fusion pdf-lib)
// ════════════════════════════════════════════════════════════════════
async function genRapportComplet(data) {
  const { report, details, photos, assets, summary, parts } = data;
  const d = details || {};

  // ── Page de garde / résumé ──
  const doc = makeDoc('Rapport journalier complet');

  // grand bloc titre
  ensureSpace(doc, 90);
  let y = doc.y;
  const W = contentWidth(doc);
  doc.save();
  doc.roundedRect(MARGIN_L, y, W, 76, 8).fill(GRIS);
  doc.restore();
  doc.fillColor(BLEU).font('Helvetica-Bold').fontSize(22)
     .text(s(report.job_name || report.job_number), MARGIN_L + 16, y + 14, { width: W - 32, lineBreak: false });
  doc.fillColor('#555').font('Helvetica').fontSize(12)
     .text('Rapport journalier complet — ' + s(report.report_date), MARGIN_L + 16, y + 44, { width: W - 32, lineBreak: false });
  doc.y = y + 90;
  doc.x = MARGIN_L;

  sectionTitle(doc, 'Résumé de la journée');
  kvTable(doc, [
    ['Chantier', (report.job_name || '') + (report.job_number ? (' (' + report.job_number + ')') : '')],
    ['Client', report.client_name],
    ['Employé(s) présents', d.employees_present || report.employee_name],
    ["Chef d'équipe", d.foreman_name],
    ['Heures travaillées', report.hours_worked ? (report.hours_worked + ' h') : ''],
    ['Avancement', has(d.percent_complete) ? (d.percent_complete + ' %') : ''],
    ['Coût matériel du jour', summary && summary.dayCost != null ? money(summary.dayCost) : ''],
    ['Coût total du chantier', summary && summary.totalCost != null ? money(summary.totalCost) : '']
  ]);

  sectionTitle(doc, 'Travaux réalisés');
  textBlock(doc, 'Description', report.work_done);

  sectionTitle(doc, 'Problèmes rencontrés');
  textBlock(doc, 'Description', report.problems);

  sectionTitle(doc, 'Travaux prévus demain');
  textBlock(doc, 'Planification', d.tomorrow_work);

  sectionTitle(doc, 'Photos importantes');
  photoGrid(doc, (photos || []).slice(0, 6));

  // note table des matières
  ensureSpace(doc, 40);
  doc.fillColor('#777').font('Helvetica-Oblique').fontSize(9)
     .text('Les documents détaillés suivants sont joints à ce rapport : Bon de travail, Fiche de chantier, Suivi des matériaux.', MARGIN_L, doc.y + 6, { width: W });

  paintHeaderFooter(doc, 'Rapport journalier complet', assets);
  const coverBuf = await toBuffer(doc);

  // ── Fusion : cover + parties (pdf-lib) ──
  const merged = await LibPDF.create();
  const buffers = [coverBuf].concat((parts || []).filter(Boolean));
  for (const buf of buffers) {
    try {
      const src = await LibPDF.load(buf);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(function (p) { merged.addPage(p); });
    } catch (e) { /* ignorer une partie illisible */ }
  }
  const bytes = await merged.save();
  return Buffer.from(bytes);
}

module.exports = {
  genBonTravail: genBonTravail,
  genFicheChantier: genFicheChantier,
  genSuiviMateriaux: genSuiviMateriaux,
  genRapportComplet: genRapportComplet
};
