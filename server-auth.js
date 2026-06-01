/**
 * server-auth.js — InnovaSpray Québec
 * Authentification côté serveur (jeton HMAC signé).
 *
 * Les utilisateurs sont stockés dans la table KV sous la clé `isq_users`
 * (créés par l'interface, voir isq-auth.js). Le hachage du mot de passe
 * utilise EXACTEMENT le même algorithme que le client (SHA-256 avec sel)
 * afin que la validation serveur corresponde aux comptes existants.
 *
 * Aucun mot de passe en clair n'est jamais stocké ni transmis.
 */
'use strict';

const crypto = require('crypto');

// DOIT correspondre au SALT de isq-auth.js (côté navigateur)
const SALT = 'ISQ_INNOVASPRAY_2026';

// Durée de vie d'un jeton de session : 12 heures
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/** Hachage identique au client : SHA-256( "SALT:motdepasse" ) en hexadécimal. */
function hashPwd(pwd) {
  return crypto.createHash('sha256').update(SALT + ':' + String(pwd)).digest('hex');
}

/**
 * Construit le module d'authentification.
 * @param {object} deps
 * @param {(key:string)=>string|null} deps.getKV   Lecture d'une clé KV.
 * @param {()=>string}                 deps.getSecret  Secret de signature des jetons.
 */
function makeAuth({ getKV, getSecret }) {

  function getUsers() {
    try { return JSON.parse(getKV('isq_users') || '[]'); } catch (e) { return []; }
  }

  function findUser(uid) {
    return getUsers().find(function (u) { return u.id === uid; }) || null;
  }

  // ── Signature / vérification de jetons (HMAC-SHA256, format payload.signature) ──
  function sign(payloadObj) {
    const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
    const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
    return payload + '.' + sig;
  }

  function verify(token) {
    if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const payload = parts[0];
    const sig = parts[1];
    const expected = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
    if (sig.length !== expected.length) return null;
    let ok = false;
    try { ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch (e) { return null; }
    if (!ok) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
    if (!data || !data.exp || data.exp < Date.now()) return null;
    return data;
  }

  /** Connexion : valide les identifiants et renvoie un jeton, ou null. */
  function login(username, password) {
    const users = getUsers();
    if (!users.length) return { error: 'no_users' };
    const hash = hashPwd(password);
    const uname = String(username || '').trim().toLowerCase();
    const u = users.find(function (x) {
      return x.username && x.username.toLowerCase() === uname && x.passwordHash === hash;
    });
    if (!u) return null;
    const exp = Date.now() + TOKEN_TTL_MS;
    const token = sign({ uid: u.id, nom: u.nom, username: u.username, role: u.role, exp: exp });
    return { token: token, exp: exp, user: { id: u.id, nom: u.nom, username: u.username, role: u.role } };
  }

  // ── Signatures de ressources (liens photo dans les courriels, sans session) ──
  function signResource(resourceId) {
    return crypto.createHmac('sha256', getSecret()).update('res:' + resourceId).digest('base64url');
  }
  function verifyResource(resourceId, sig) {
    if (!sig) return false;
    const expected = signResource(resourceId);
    if (sig.length !== expected.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch (e) { return false; }
  }

  // ── Extraction du jeton depuis une requête (header Bearer ou ?token=) ──
  function authFromReq(req) {
    let token = '';
    const h = req.headers['authorization'] || '';
    if (h.indexOf('Bearer ') === 0) token = h.slice(7);
    if (!token && req.query && req.query.token) token = String(req.query.token);
    return verify(token);
  }

  // ── Middlewares Express ──
  function requireAuth(req, res, next) {
    const data = authFromReq(req);
    if (!data) return res.status(401).json({ error: 'Non authentifié — veuillez vous reconnecter.' });
    req.user = data;
    next();
  }

  function requireAdmin(req, res, next) {
    const data = authFromReq(req);
    if (!data) return res.status(401).json({ error: 'Non authentifié — veuillez vous reconnecter.' });
    if (data.role !== 'admin') return res.status(403).json({ error: "Accès réservé à l'administrateur." });
    req.user = data;
    next();
  }

  return {
    hashPwd: hashPwd,
    getUsers: getUsers,
    findUser: findUser,
    login: login,
    verify: verify,
    sign: sign,
    signResource: signResource,
    verifyResource: verifyResource,
    authFromReq: authFromReq,
    requireAuth: requireAuth,
    requireAdmin: requireAdmin
  };
}

module.exports = { makeAuth: makeAuth, hashPwd: hashPwd };
