/**
 * isq-saves-db.js — InnovaSpray Québec
 * Historique de toutes les sauvegardes — stocké en SQLite via l'API serveur.
 * API publique identique à l'ancienne version IndexedDB (callbacks inchangés).
 */
window.ISQSavesDB = (function () {
  'use strict';

  var _lastLog = {};

  var DOC_LABELS = {
    bon_travail:    'Bon de travail',
    fiche_chantier: 'Fiche de chantier',
    checklist:      'Checklist qualité',
    materiaux:      'Suivi matériaux',
    satisfaction:   'Rapport satisfaction'
  };

  /* ── Nettoyage des données avant stockage ─────────────────────── */
  function _clean(data) {
    if (!data || typeof data !== 'object') return data;
    var out = {};
    Object.keys(data).forEach(function (k) {
      if (k === '_sig_foreman' || k === '_sig_client') return;
      out[k] = data[k];
    });
    return out;
  }

  /* ── Enregistrer une sauvegarde ───────────────────────────────── */
  function logSave(docType, jobNumber, trigger, data) {
    // Debounce : max 1 log "fermeture" par doc toutes les 30 secondes
    if (trigger !== 'envoi') {
      var key = docType + '|' + trigger;
      var now = Date.now();
      if (_lastLog[key] && (now - _lastLog[key]) < 30000) return;
      _lastLog[key] = now;
    }

    fetch('/api/saves', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        timestamp:  new Date().toISOString(),
        docType:    docType,
        jobNumber:  String(jobNumber || '').trim(),
        trigger:    trigger,
        data:       _clean(data)
      })
    }).catch(function () {});
  }

  /* ── Lire toutes les sauvegardes ──────────────────────────────── */
  function getAllSaves(cb) {
    fetch('/api/saves')
      .then(function (r) { return r.json(); })
      .then(function (saves) { cb(saves); })
      .catch(function () { cb([]); });
  }

  /* ── Supprimer une entrée ─────────────────────────────────────── */
  function deleteSave(id, cb) {
    fetch('/api/saves/' + id, { method: 'DELETE' })
      .then(function () { if (cb) cb(); })
      .catch(function () { if (cb) cb(); });
  }

  /* ── Tout effacer ─────────────────────────────────────────────── */
  function clearAll(cb) {
    fetch('/api/saves', { method: 'DELETE' })
      .then(function () { if (cb) cb(); })
      .catch(function () { if (cb) cb(); });
  }

  /* ── Statistiques ─────────────────────────────────────────────── */
  function getStats(cb) {
    fetch('/api/saves/stats')
      .then(function (r) { return r.json(); })
      .then(function (stats) { cb(stats); })
      .catch(function () {
        var stats = { total: 0, byDoc: {}, lastSave: null };
        Object.keys(DOC_LABELS).forEach(function (k) { stats.byDoc[k] = 0; });
        cb(stats);
      });
  }

  return {
    logSave:    logSave,
    getAllSaves: getAllSaves,
    deleteSave: deleteSave,
    clearAll:   clearAll,
    getStats:   getStats,
    DOC_LABELS: DOC_LABELS
  };
})();
