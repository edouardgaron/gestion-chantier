/**
 * isq-saves-db.js — InnovaSpray Québec
 * Historique de toutes les sauvegardes — stocké en SQLite via l'API serveur.
 * API publique identique à l'ancienne version IndexedDB (callbacks inchangés).
 */
window.ISQSavesDB = (function () {
  'use strict';

  var _lastLog = {};
  var _PROJ_LIST_KEY = 'isq_projets_liste';

  var DOC_LABELS = {
    bon_travail:    'Bon de travail',
    fiche_chantier: 'Fiche de chantier',
    checklist:      'Checklist qualité',
    materiaux:      'Suivi matériaux',
    satisfaction:   'Rapport satisfaction'
  };

  /* ── Mettre à jour isq_projets_liste à chaque sauvegarde ─────── */
  function _updateProjectEntry(proj) {
    if (!proj || !proj.job_number) return;
    var list = [];
    try { list = JSON.parse(ISQStore.getItem(_PROJ_LIST_KEY) || '[]'); } catch(e) {}
    var entry = {};
    Object.keys(proj).forEach(function(k) {
      if (k !== '_sig_foreman' && k !== '_sig_client') entry[k] = proj[k];
    });
    entry.saved_at = new Date().toLocaleString('fr-CA', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].job_number === proj.job_number) { idx = i; break; }
    }
    if (idx >= 0) { list[idx] = entry; } else { list.unshift(entry); }
    try { ISQStore.setItem(_PROJ_LIST_KEY, JSON.stringify(list)); } catch(e) {}
  }

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

    // Synchroniser isq_projets_liste avec les infos projet actuelles
    try {
      var _proj = JSON.parse((window.ISQStore && ISQStore.getItem('isq_projet')) || '{}');
      _updateProjectEntry(_proj);
    } catch(e) {}

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
