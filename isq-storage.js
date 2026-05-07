/**
 * isq-storage.js — InnovaSpray Québec
 * Remplace localStorage par un cache synchrone préchargé + persistance SQLite côté serveur.
 * Charger AVANT isq-auth.js et isq-core.js.
 */
window.ISQStore = (function () {
  'use strict';

  var _cache = {};

  // Initialiser depuis le préchargement injecté par le serveur dans chaque page HTML
  if (window.__ISQ_PRELOAD__) {
    Object.assign(_cache, window.__ISQ_PRELOAD__);
  }

  function _persist(key, value) {
    fetch('/api/kv/' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: value })
    }).catch(function () {});
  }

  function _delete(key) {
    fetch('/api/kv/' + encodeURIComponent(key), {
      method: 'DELETE'
    }).catch(function () {});
  }

  return {
    getItem: function (key) {
      return _cache.hasOwnProperty(key) ? _cache[key] : null;
    },
    setItem: function (key, value) {
      _cache[key] = String(value);
      _persist(key, String(value));
    },
    removeItem: function (key) {
      delete _cache[key];
      _delete(key);
    },
    get length() {
      return Object.keys(_cache).length;
    },
    key: function (n) {
      return Object.keys(_cache)[n] || null;
    }
  };
})();
