/**
 * isq-auth.js — InnovaSpray Québec
 * Authentification et gestion des sessions utilisateurs.
 * Inclure AVANT isq-core.js dans chaque page protégée.
 * Version 1.0 — 2026-05
 */
window.ISQAuth = (function () {
  'use strict';

  var USERS_KEY    = 'isq_users';
  var USERS_LS_KEY = 'isq_users_permanent';
  var SESSION_KEY  = 'isq_session';
  var SALT         = 'ISQ_INNOVASPRAY_2026';

  /* ── Hachage SHA-256 via SubtleCrypto ────────────────────────── */
  async function hashPwd(pwd) {
    var enc  = new TextEncoder();
    var data = enc.encode(SALT + ':' + pwd);
    var buf  = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }

  /* ── Utilisateurs — lecture / écriture ───────────────────────── */
  function getUsers() {
    try {
      var fromStore = JSON.parse(ISQStore.getItem(USERS_KEY) || '[]');
      if (fromStore.length > 0) return fromStore;
      /* Fallback : restaurer depuis localStorage si SQLite est vide */
      var fromLS = JSON.parse(localStorage.getItem(USERS_LS_KEY) || '[]');
      if (fromLS.length > 0) {
        ISQStore.setItem(USERS_KEY, JSON.stringify(fromLS));
        return fromLS;
      }
      return [];
    } catch (e) { return []; }
  }

  function saveUsers(users) {
    ISQStore.setItem(USERS_KEY, JSON.stringify(users));
    /* Backup permanent dans localStorage du navigateur */
    try { localStorage.setItem(USERS_LS_KEY, JSON.stringify(users)); } catch (e) {}
  }

  /* ── Session (sessionStorage — fermée quand onglet ferme) ─────── */
  function getSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
  }

  function getCurrentUser() { return getSession(); }

  function _setSession(user) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      id:       user.id,
      nom:      user.nom,
      username: user.username,
      role:     user.role,
      loginAt:  new Date().toISOString()
    }));
  }

  function logout() {
    sessionStorage.removeItem(SESSION_KEY);
    window.location.href = 'login.html';
  }

  /* ── Gardes d'accès ───────────────────────────────────────────── */
  function requireLogin() {
    if (!getSession()) {
      window.location.replace('login.html');
    }
  }

  function requireAdmin() {
    var s = getSession();
    if (!s) { window.location.replace('login.html'); return; }
    if (s.role !== 'admin') { window.location.replace('index.html'); }
  }

  /* ── Connexion ────────────────────────────────────────────────── */
  async function login(username, password) {
    var users = getUsers();
    var hash  = await hashPwd(password);
    for (var i = 0; i < users.length; i++) {
      if (users[i].username.toLowerCase() === username.trim().toLowerCase() &&
          users[i].passwordHash === hash) {
        _setSession(users[i]);
        return true;
      }
    }
    return false;
  }

  /* ── Création admin par défaut (première utilisation) ─────────── */
  async function initDefaultAdmin() {
    if (getUsers().length > 0) return;
    var hash = await hashPwd('admin123');
    saveUsers([{
      id:           'admin_default',
      nom:          'Administrateur',
      username:     'admin',
      role:         'admin',
      passwordHash: hash
    }]);
  }

  /* ── CRUD utilisateurs ────────────────────────────────────────── */
  async function createUser(nom, username, password, role) {
    var users = getUsers();
    var dup = users.find(function (u) {
      return u.username.toLowerCase() === username.trim().toLowerCase();
    });
    if (dup) return { ok: false, msg: "Ce nom d'utilisateur est déjà utilisé." };
    if (!password || !password.trim()) return { ok: false, msg: 'Le mot de passe est requis.' };
    var hash = await hashPwd(password);
    users.push({
      id:           Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      nom:          nom.trim(),
      username:     username.trim(),
      role:         role,
      passwordHash: hash
    });
    saveUsers(users);
    return { ok: true };
  }

  async function updateUser(id, nom, username, password, role) {
    var users = getUsers();
    var idx   = -1;
    for (var i = 0; i < users.length; i++) {
      if (users[i].id === id) { idx = i; break; }
    }
    if (idx === -1) return { ok: false, msg: 'Utilisateur introuvable.' };
    var dup = users.find(function (u, j) {
      return j !== idx && u.username.toLowerCase() === username.trim().toLowerCase();
    });
    if (dup) return { ok: false, msg: "Ce nom d'utilisateur est déjà utilisé." };
    users[idx].nom      = nom.trim();
    users[idx].username = username.trim();
    users[idx].role     = role;
    if (password && password.trim()) {
      users[idx].passwordHash = await hashPwd(password);
    }
    saveUsers(users);
    return { ok: true };
  }

  function deleteUser(id) {
    var users  = getUsers();
    var target = users.find(function (u) { return u.id === id; });
    if (!target) return { ok: false, msg: 'Utilisateur introuvable.' };
    if (target.role === 'admin') {
      var cnt = users.filter(function (u) { return u.role === 'admin'; }).length;
      if (cnt <= 1) return { ok: false, msg: 'Impossible de supprimer le dernier administrateur.' };
    }
    saveUsers(users.filter(function (u) { return u.id !== id; }));
    return { ok: true };
  }

  /* ── Badge utilisateur (injecté automatiquement au chargement) ── */
  function _injectBadge() {
    var s = getSession();
    if (!s) return;

    var roleLabel = s.role === 'admin' ? 'Admin' : 'Employé';
    var roleColor = s.role === 'admin' ? '#0170B9' : '#FF6600';

    /* Trouver la barre de navigation de la page */
    var navbar  = document.querySelector('.navbar');
    var topbar  = document.querySelector('.top-bar') || document.querySelector('.toolbar');
    var anyFlex = document.querySelector('div[style*="display:flex"]');
    var target  = navbar || topbar || anyFlex;
    if (!target) return;

    var isDark = !!navbar; /* Barre bleue vs barre blanche */

    /* Créer le badge */
    var badge = document.createElement('div');
    badge.id        = 'isq-user-badge';
    badge.className = 'no-print';
    badge.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0;margin-left:auto;';

    if (isDark) {
      badge.innerHTML =
        '<span style="font-size:12px;font-weight:700;color:rgba(255,255,255,.9);white-space:nowrap;">' +
          '👤 ' + _esc(s.nom) +
          ' <span style="background:rgba(255,255,255,.22);color:#fff;border-radius:99px;' +
          'padding:1px 8px;font-size:10px;font-weight:700;margin-left:3px;">' + roleLabel + '</span>' +
        '</span>' +
        '<button onclick="ISQAuth.logout()" class="no-print" style="background:rgba(255,255,255,.15);' +
        'border:1px solid rgba(255,255,255,.4);color:#fff;border-radius:5px;padding:5px 12px;' +
        'font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;' +
        'transition:background .2s;" onmouseover="this.style.background=\'rgba(255,255,255,.28)\'" ' +
        'onmouseout="this.style.background=\'rgba(255,255,255,.15)\'">Déconnexion</button>';
    } else {
      badge.innerHTML =
        '<span style="font-size:12px;font-weight:700;color:#1A1A2E;white-space:nowrap;">' +
          '👤 ' + _esc(s.nom) +
          ' <span style="background:' + roleColor + ';color:#fff;border-radius:99px;' +
          'padding:1px 8px;font-size:10px;font-weight:700;margin-left:3px;">' + roleLabel + '</span>' +
        '</span>' +
        '<button onclick="ISQAuth.logout()" class="no-print" style="background:#fff;border:2px solid #C62828;' +
        'color:#C62828;border-radius:5px;padding:5px 12px;font-size:12px;font-weight:700;' +
        'cursor:pointer;font-family:inherit;white-space:nowrap;transition:background .2s,color .2s;" ' +
        'onmouseover="this.style.background=\'#C62828\';this.style.color=\'#fff\'" ' +
        'onmouseout="this.style.background=\'#fff\';this.style.color=\'#C62828\'">Déconnexion</button>';
    }

    target.appendChild(badge);

    /* Règle print : masquer le badge à l'impression */
    var style = document.createElement('style');
    style.textContent = '@media print { #isq-user-badge { display:none !important; } }';
    document.head.appendChild(style);
  }

  function _esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  /* ── Auto-init au chargement ─────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    _injectBadge();
  });

  return {
    hashPwd:          hashPwd,
    getUsers:         getUsers,
    getSession:       getSession,
    getCurrentUser:   getCurrentUser,
    login:            login,
    logout:           logout,
    requireLogin:     requireLogin,
    requireAdmin:     requireAdmin,
    initDefaultAdmin: initDefaultAdmin,
    createUser:       createUser,
    updateUser:       updateUser,
    deleteUser:       deleteUser
  };
})();
