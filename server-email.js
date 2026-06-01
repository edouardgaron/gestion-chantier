/**
 * server-email.js — InnovaSpray Québec
 * Envoi de courriel natif via Nodemailer + SMTP Gmail.
 *
 * Remplace l'ancien workflow n8n (Gmail OAuth, fragile car le jeton expirait).
 * Le « mot de passe d'application » Gmail ne s'expire pas et fonctionne
 * directement en SMTP — beaucoup plus fiable.
 *
 * Configuration : voir data/secrets.json (clé "email") ou variables
 * d'environnement ISQ_SMTP_USER / ISQ_SMTP_PASS / ISQ_EMAIL_TO.
 */
'use strict';

const nodemailer = require('nodemailer');

// ── Couleurs de marque ──
const BLEU = '#0170B9';
const ORANGE = '#FF6600';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function nl2br(s) { return esc(s).replace(/\r?\n/g, '<br>'); }
function orDash(s) { return (s == null || String(s).trim() === '') ? '—' : s; }

/** Construit le transport SMTP à partir de la configuration. */
function buildTransport(cfg) {
  if (!cfg || !cfg.smtpUser || !cfg.smtpPass) {
    throw new Error('Configuration SMTP incomplète : identifiant ou mot de passe d\'application manquant.');
  }
  const port = Number(cfg.smtpPort) || 465;
  return nodemailer.createTransport({
    host: cfg.smtpHost || 'smtp.gmail.com',
    port: port,
    secure: port === 465,            // 465 = SSL ; 587 = STARTTLS
    auth: { user: cfg.smtpUser, pass: cfg.smtpPass },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000
  });
}

/** Vérifie que la connexion SMTP fonctionne (utilisé par le bouton « Tester »). */
async function verifyTransport(cfg) {
  const t = buildTransport(cfg);
  await t.verify();
  return true;
}

function buildSubject(report) {
  const chantier = report.job_name || report.job_number || 'Chantier';
  return 'Compte rendu quotidien - ' + chantier + ' - ' + (report.report_date || '');
}

/** Version texte brut (repli pour les clients sans HTML), format demandé. */
function buildText(report, photoLinks) {
  const lines = [];
  lines.push('Bonjour,');
  lines.push('');
  lines.push('Voici le compte rendu de fin de journée.');
  lines.push('');
  lines.push('Chantier :         ' + orDash(report.job_name || report.job_number));
  if (report.job_number && report.job_name) lines.push('Numéro :           ' + report.job_number);
  if (report.client_name) lines.push('Client :           ' + report.client_name);
  lines.push('Employé :          ' + orDash(report.employee_name));
  lines.push('Date :             ' + orDash(report.report_date));
  const plage = [report.arrival_time, report.departure_time].filter(Boolean).join(' → ');
  if (plage) lines.push('Heures sur place :  ' + plage);
  lines.push('Heures travaillées : ' + orDash(report.hours_worked));
  lines.push('');
  lines.push('Travaux réalisés :');
  lines.push(orDash(report.work_done));
  lines.push('');
  lines.push('Matériel utilisé :');
  lines.push(orDash(report.materials_used));
  lines.push('');
  lines.push('Problèmes rencontrés :');
  lines.push(orDash(report.problems));
  lines.push('');
  lines.push('Travaux restants :');
  lines.push(orDash(report.remaining_work));
  lines.push('');
  lines.push('Commentaires :');
  lines.push(orDash(report.comments));
  lines.push('');
  lines.push('Photos :');
  if (photoLinks && photoLinks.length) {
    photoLinks.forEach(function (p) { lines.push('  • ' + p.label + ' : ' + p.url); });
  } else {
    lines.push('  Aucune photo jointe.');
  }
  lines.push('');
  if (report.signature) lines.push('Confirmé par : ' + report.signature);
  lines.push('');
  lines.push('Merci.');
  lines.push('— Système InnovaSpray Québec');
  return lines.join('\n');
}

function row(label, value, opts) {
  opts = opts || {};
  const v = opts.raw ? value : nl2br(orDash(value));
  return (
    '<tr>' +
    '<td style="padding:10px 14px;background:#f4f6f9;font-size:12px;font-weight:700;color:#555;' +
    'text-transform:uppercase;letter-spacing:.4px;white-space:nowrap;vertical-align:top;' +
    'border-bottom:1px solid #e3e8ef;width:38%;">' + esc(label) + '</td>' +
    '<td style="padding:10px 14px;font-size:14px;color:#1a1a2e;vertical-align:top;' +
    'border-bottom:1px solid #e3e8ef;">' + v + '</td>' +
    '</tr>'
  );
}

/** Version HTML professionnelle et épurée, aux couleurs InnovaSpray. */
function buildHtml(report, photoLinks) {
  const plage = [report.arrival_time, report.departure_time].filter(Boolean).join(' &rarr; ');

  let photosBlock = '<p style="margin:0;color:#888;font-size:14px;">Aucune photo jointe.</p>';
  if (photoLinks && photoLinks.length) {
    photosBlock = photoLinks.map(function (p) {
      return (
        '<a href="' + esc(p.url) + '" target="_blank" ' +
        'style="display:inline-block;margin:0 8px 8px 0;padding:8px 14px;background:#eef4fb;' +
        'color:' + BLEU + ';text-decoration:none;border:1px solid #cfe0f2;border-radius:7px;' +
        'font-size:13px;font-weight:700;">📷 ' + esc(p.label) + '</a>'
      );
    }).join('');
  }

  return (
'<!DOCTYPE html><html><body style="margin:0;padding:0;background:#eef1f5;font-family:Segoe UI,Arial,sans-serif;">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:24px 12px;">' +
    '<tr><td align="center">' +
      '<table role="presentation" width="600" cellpadding="0" cellspacing="0" ' +
        'style="max-width:600px;width:100%;background:#fff;border-radius:14px;overflow:hidden;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.08);">' +

        // En-tête
        '<tr><td style="background:linear-gradient(135deg,' + BLEU + ' 0%,#014d82 100%);padding:24px 28px;">' +
          '<div style="font-size:20px;font-weight:800;color:#fff;letter-spacing:.5px;">INNOVASPRAY QUÉBEC</div>' +
          '<div style="font-size:13px;color:rgba(255,255,255,.85);margin-top:4px;">Compte rendu quotidien de chantier</div>' +
        '</td></tr>' +

        // Bandeau chantier
        '<tr><td style="padding:22px 28px 8px;">' +
          '<div style="font-size:12px;color:#888;">Bonjour,</div>' +
          '<div style="font-size:15px;color:#1a1a2e;margin-top:6px;">Voici le compte rendu de fin de journée.</div>' +
          '<div style="margin-top:16px;font-size:22px;font-weight:800;color:' + BLEU + ';">' +
            esc(orDash(report.job_name || report.job_number)) + '</div>' +
          '<div style="font-size:13px;color:#666;margin-top:2px;">' +
            esc(report.report_date || '') + (report.employee_name ? ' &nbsp;•&nbsp; ' + esc(report.employee_name) : '') +
          '</div>' +
        '</td></tr>' +

        // Tableau d'infos
        '<tr><td style="padding:14px 28px 0;">' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
            'style="border:1px solid #e3e8ef;border-radius:10px;overflow:hidden;">' +
            (report.job_number ? row('Numéro de chantier', report.job_number) : '') +
            (report.client_name ? row('Client', report.client_name) : '') +
            row('Employé', report.employee_name) +
            row('Date', report.report_date) +
            (plage ? row('Heures sur place', plage, { raw: true }) : '') +
            row('Heures travaillées', report.hours_worked) +
            row('Travaux réalisés', report.work_done) +
            row('Matériel utilisé', report.materials_used) +
            row('Problèmes rencontrés', report.problems) +
            row('Travaux restants', report.remaining_work) +
            row('Commentaires', report.comments) +
          '</table>' +
        '</td></tr>' +

        // Photos
        '<tr><td style="padding:20px 28px 4px;">' +
          '<div style="font-size:12px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.4px;margin-bottom:10px;">Photos du chantier</div>' +
          photosBlock +
          (photoLinks && photoLinks.length ? '<div style="font-size:12px;color:#999;margin-top:6px;">Les photos sont aussi jointes à ce courriel.</div>' : '') +
        '</td></tr>' +

        // Signature
        (report.signature ?
          '<tr><td style="padding:14px 28px 0;">' +
            '<div style="font-size:13px;color:#444;">✍️ Confirmé par : <strong>' + esc(report.signature) + '</strong></div>' +
          '</td></tr>' : '') +

        // Pied
        '<tr><td style="padding:24px 28px;">' +
          '<div style="border-top:1px solid #e3e8ef;padding-top:16px;font-size:13px;color:#666;">Merci.</div>' +
          '<div style="font-size:12px;color:#aaa;margin-top:8px;">Envoyé automatiquement par l\'application de gestion de chantier — ' +
            '<span style="color:' + ORANGE + ';font-weight:700;">InnovaSpray Québec</span></div>' +
        '</td></tr>' +

      '</table>' +
    '</td></tr>' +
  '</table>' +
'</body></html>'
  );
}

/**
 * Envoie le courriel de compte rendu.
 * @param {object} p
 * @param {object} p.cfg          Configuration email { smtpUser, smtpPass, recipient, fromName, smtpHost, smtpPort }
 * @param {object} p.report       Données du rapport
 * @param {Array}  p.attachments  Pièces jointes Nodemailer [{ filename, path|content, contentType }]
 * @param {Array}  p.photoLinks   [{ label, url }] liens sécurisés vers les photos
 * @returns {Promise<{messageId:string, accepted:Array, response:string}>}
 */
async function sendReportEmail(p) {
  const cfg = p.cfg || {};
  const recipient = cfg.recipient || cfg.smtpUser;
  if (!recipient) throw new Error('Aucune adresse destinataire configurée.');

  const transport = buildTransport(cfg);
  const fromName = cfg.fromName || 'InnovaSpray Québec';

  const info = await transport.sendMail({
    from: '"' + fromName + '" <' + cfg.smtpUser + '>',
    to: recipient,
    subject: buildSubject(p.report),
    text: buildText(p.report, p.photoLinks),
    html: buildHtml(p.report, p.photoLinks),
    attachments: p.attachments || []
  });

  return { messageId: info.messageId, accepted: info.accepted || [], response: info.response || '' };
}

module.exports = {
  sendReportEmail: sendReportEmail,
  verifyTransport: verifyTransport,
  buildSubject: buildSubject
};
