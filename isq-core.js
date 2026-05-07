/**
 * isq-core.js — InnovaSpray Québec
 * Fonctions partagées entre tous les documents du système.
 * Inclure ce fichier dans chaque HTML avant les scripts spécifiques.
 * Version 1.0 — 2026-04
 */
window.ISQ = (function () {
  'use strict';

  /* ── localStorage — lecture ───────────────────────────────── */
  function getWebhooks() {
    return window.ISQ_WEBHOOKS || {};
  }

  function getProjet() {
    try { return JSON.parse(ISQStore.getItem('isq_projet') || '{}'); } catch(e) { return {}; }
  }

  /* ── ISQStore — écriture fusionnée ──────────────────────── */
  function saveProjet(obj) {
    try {
      var p = getProjet();
      Object.keys(obj).forEach(function(k) {
        if (obj[k] !== undefined && obj[k] !== null) p[k] = obj[k];
      });
      ISQStore.setItem('isq_projet', JSON.stringify(p));
    } catch(e) {}
  }

  /* ── Statuts d'envoi ─────────────────────────────────────── */
  /**
   * Enregistre qu'un document a été envoyé au bureau avec succès.
   * Clés valides : 'bon_travail' | 'fiche_chantier' | 'checklist' | 'materiaux' | 'satisfaction'
   */
  function writeStatutEnvoi(docKey) {
    try {
      var p = getProjet();
      if (!p.statuts_envoi) p.statuts_envoi = {};
      p.statuts_envoi[docKey] = {
        envoye:    true,
        timestamp: new Date().toISOString(),
        heure:     new Date().toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' })
      };
      ISQStore.setItem('isq_projet', JSON.stringify(p));
    } catch(e) {}
  }

  /* ── Toast ────────────────────────────────────────────────── */
  function showToast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 2500);
  }

  /* ── Textarea auto-grow ───────────────────────────────────── */
  function autoGrow(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, 22) + 'px';
  }

  /**
   * Convertit input[data-jobber-field="work_type"] en textarea auto-growing.
   * @returns {HTMLTextAreaElement|null}
   */
  function initWorkType() {
    var inp = document.querySelector('input[data-jobber-field="work_type"]');
    if (!inp) return null;
    var ta = document.createElement('textarea');
    for (var i = 0; i < inp.attributes.length; i++) {
      var a = inp.attributes[i];
      if (a.name !== 'type') ta.setAttribute(a.name, a.value);
    }
    ta.value      = inp.value;
    ta.rows       = 1;
    ta.style.resize      = 'none';
    ta.style.overflow    = 'hidden';
    ta.style.lineHeight  = '1.4';
    inp.parentNode.replaceChild(ta, inp);
    var cell = ta.parentElement;
    var grid = cell && cell.parentElement;
    if (grid) grid.style.gridTemplateColumns = '';
    autoGrow(ta);
    ta.addEventListener('input', function () { autoGrow(ta); });
    return ta;
  }

  /* ── Formatage monétaire ─────────────────────────────────── */
  function formatMontant(val) {
    var n = parseFloat(val);
    if (isNaN(n)) return val || '';
    return n.toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
  }

  return {
    getWebhooks:      getWebhooks,
    getProjet:        getProjet,
    saveProjet:       saveProjet,
    writeStatutEnvoi: writeStatutEnvoi,
    showToast:        showToast,
    autoGrow:         autoGrow,
    initWorkType:     initWorkType,
    formatMontant:    formatMontant
  };
})();
