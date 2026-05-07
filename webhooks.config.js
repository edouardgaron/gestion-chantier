/**
 * webhooks.config.js — InnovaSpray Québec
 * Configuration centralisée des webhooks n8n.
 * Modifier ce fichier avant chaque déploiement.
 */
window.ISQ_WEBHOOKS = {
  debut:           '',   // 🚀 Début de chantier
  fin:             '',   // 🏁 Fin de chantier
  materiaux:       '',   // 📦 Commande matériaux
  satisfaction:    '',   // ⭐ Sondage satisfaction
  facture:         '',   // 💰 Facturation
  meteo:           '',   // 🔔 Alerte météo
  lookup:          'https://edouardgaron.app.n8n.cloud/webhook/sheets-lookup',   // 🔍 Lookup Google Sheets
  liste_projets:   'https://edouardgaron.app.n8n.cloud/webhook/liste-projets',   // 📋 Liste des projets (retourne un tableau JSON)
  submit:          'https://edouardgaron.app.n8n.cloud/webhook/isq-fiches-chantier',   // 📤 Soumission de fiches au bureau
  google_place_id: ''    // ⭐ Google Place ID pour les avis Google
};
