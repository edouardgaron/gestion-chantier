/**
 * isq-api.js — InnovaSpray Québec
 * Client d'API authentifié (jeton serveur signé).
 *
 * Charger APRÈS isq-storage.js et isq-auth.js.
 * Fournit ISQApi.* pour appeler les routes protégées (/api/session,
 * /api/daily-reports, /api/email-config) en joignant automatiquement
 * le jeton « Bearer ». Gère l'expiration (401 → reconnexion).
 */
window.ISQApi = (function () {
  'use strict';

  var TOKEN_KEY = 'isq_token';

  function getToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(t) {
    try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }
  function clearToken() { setToken(''); }

  /** Connexion serveur : obtient et conserve un jeton. */
  async function login(username, password) {
    var res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    });
    var data = await res.json().catch(function () { return {}; });
    if (res.ok && data.token) { setToken(data.token); return { ok: true, user: data.user }; }
    return { ok: false, error: data.error || 'Connexion refusée.', status: res.status };
  }

  /** Appel fetch authentifié. Renvoie { ok, status, data }. Redirige au login si 401. */
  async function request(method, url, body, opts) {
    opts = opts || {};
    var headers = { 'Authorization': 'Bearer ' + getToken() };
    var init = { method: method, headers: headers };
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    var res, data;
    try {
      res = await fetch(url, init);
    } catch (e) {
      return { ok: false, status: 0, data: { error: 'Erreur réseau — vérifiez votre connexion.' } };
    }
    try { data = await res.json(); } catch (e) { data = {}; }

    if (res.status === 401 && !opts.noRedirect) {
      // Session serveur expirée : nettoyer et renvoyer au login
      clearToken();
      try { sessionStorage.removeItem('isq_session'); } catch (e) {}
      window.location.replace('login.html');
      return { ok: false, status: 401, data: data };
    }
    return { ok: res.ok, status: res.status, data: data };
  }

  return {
    getToken:   getToken,
    setToken:   setToken,
    clearToken: clearToken,
    login:      login,
    get:    function (url, opts)       { return request('GET', url, null, opts); },
    post:   function (url, body, opts) { return request('POST', url, body, opts); },
    del:    function (url, opts)       { return request('DELETE', url, null, opts); }
  };
})();
