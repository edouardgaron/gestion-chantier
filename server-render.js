/**
 * server-render.js — InnovaSpray Québec
 * Rend les VRAIES pages de l'application en PDF (fidèles à l'écran/impression)
 * via Chromium intégré (Puppeteer). Aucune dépendance n8n.
 *
 * Chaque page est ouverte par un navigateur invisible avec :
 *   • une session injectée (pour passer ISQAuth.requireLogin)
 *   • les paramètres d'URL du chantier (job_number, client_name, …)
 *   • le préchargement des données (window.__ISQ_PRELOAD__ injecté par le serveur)
 * puis imprimée en A4 avec un cadrage propre (marges, en-tête/pied, numéros de page).
 */
'use strict';

const puppeteer = require('puppeteer');

let _browser = null;
let _launching = null;

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  if (_launching) return _launching;
  _launching = puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none']
  }).then(function (b) { _browser = b; _launching = null; return b; });
  return _launching;
}

async function closeBrowser() {
  try { if (_browser) await _browser.close(); } catch (e) {}
  _browser = null;
}

// Session injectée pour que requireLogin() ne redirige pas vers login.html.
// Le `nom` est repris du chef d'équipe / employé : certaines pages préremplissent
// des champs (ex. « Chef d'équipe ») avec le nom de l'utilisateur connecté.
function buildSession(name) {
  return JSON.stringify({
    id: 'pdf_render', nom: name || 'InnovaSpray Québec', username: 'system', role: 'admin', loginAt: '2026-01-01T00:00:00.000Z'
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Rend une page de l'app en PDF.
 * @param {object} o
 * @param {string} o.baseUrl    ex. http://127.0.0.1:3000
 * @param {string} o.pagePath   ex. "Bon de travail.html"
 * @param {object} o.params     paramètres d'URL (job_number, client_name, …)
 * @param {string} o.docTitle   titre affiché dans l'en-tête du PDF
 * @param {string} o.dateStr    date affichée dans l'en-tête
 * @param {string} [o.logoDataUrl] logo en data URL (optionnel, pour l'en-tête)
 * @returns {Promise<Buffer>}
 */
async function renderPageToPdf(o) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1100, height: 1400, deviceScaleFactor: 1 });

    // IMPORTANT — rendu STRICTEMENT en lecture seule : on bloque toute
    // écriture vers la base (POST/DELETE /api/kv|saves) pour qu'imprimer un
    // PDF ne puisse JAMAIS écraser les données réelles saisies par l'employé.
    // Les données d'affichage proviennent du préchargement synchrone
    // (window.__ISQ_PRELOAD__), donc bloquer les écritures n'affecte pas le rendu.
    await page.setRequestInterception(true);
    page.on('request', function (req) {
      const m = req.method();
      const u = req.url();
      if ((m === 'POST' || m === 'PUT' || m === 'DELETE') && /\/api\/(kv|saves|daily-reports)/.test(u)) {
        return req.abort();
      }
      req.continue();
    });

    // Injecter la session AVANT l'exécution des scripts de la page
    await page.evaluateOnNewDocument(function (sess) {
      try { window.sessionStorage.setItem('isq_session', sess); } catch (e) {}
    }, buildSession(o.sessionName));

    const qs = new URLSearchParams(o.params || {}).toString();
    const url = o.baseUrl + '/' + encodeURI(o.pagePath) + (qs ? ('?' + qs) : '');

    // 'load' (et non 'networkidle') : les données sauvegardées sont préchargées
    // de façon synchrone ; on évite ainsi de bloquer sur d'éventuels appels
    // webhook d'arrière-plan (lookup Google Sheets) qui pourraient traîner.
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });

    // Attendre le chargement des polices puis laisser le JS remplir le formulaire
    try { await page.evaluate(function () { return document.fonts ? document.fonts.ready : null; }); } catch (e) {}
    await new Promise(function (r) { setTimeout(r, 1000); });

    // Cadrage : masquer les éléments d'écran non imprimables (boutons, etc.)
    await page.addStyleTag({ content:
      '@page { margin: 0; }' +
      '.no-print, .btn-print, .btn-save, .toast, .btn-home, .top-bar button, #isq-user-badge { display:none !important; }' +
      'html, body { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }'
    });

    const logo = o.logoDataUrl
      ? '<img src="' + o.logoDataUrl + '" style="height:24px;width:auto;margin-right:8px;border-radius:3px;">'
      : '';

    // En-tête de marque (sur chaque page) — le « cadrage »
    const headerTemplate =
      '<div style="font-family:Arial,sans-serif; width:100%; box-sizing:border-box; padding:4px 10mm 0;">' +
        '<div style="display:flex; align-items:center;">' +
          '<div style="display:flex; align-items:center; flex:1;">' + logo +
            '<span style="font-size:9px; font-weight:bold; color:#0170B9; letter-spacing:.3px;">INNOVASPRAY QUÉBEC</span>' +
          '</div>' +
          '<span style="font-size:9px; color:#555; font-weight:bold;">' + esc(o.docTitle || '') + '</span>' +
          '<span style="font-size:8px; color:#999; margin-left:10px;">' + esc(o.dateStr || '') + '</span>' +
        '</div>' +
        '<div style="height:2px; background:#FF6600; margin-top:3px;"></div>' +
      '</div>';

    const footerTemplate =
      '<div style="font-family:Arial,sans-serif; width:100%; box-sizing:border-box; padding:0 10mm 4px; ' +
        'font-size:8px; color:#999; display:flex; justify-content:space-between; align-items:center;">' +
        '<span>InnovaSpray Québec — Document généré automatiquement</span>' +
        '<span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>' +
      '</div>';

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: headerTemplate,
      footerTemplate: footerTemplate,
      margin: { top: '24mm', bottom: '16mm', left: '8mm', right: '8mm' }
    });

    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  } finally {
    try { await page.close(); } catch (e) {}
  }
}

module.exports = { renderPageToPdf: renderPageToPdf, closeBrowser: closeBrowser, getBrowser: getBrowser };
