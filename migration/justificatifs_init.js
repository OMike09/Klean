// Initialisation justificatifs - voir contenu plus haut
const { db } = require('../db');
const DEFAULTS = [
  { category_id: 4, label: "Carte professionnelle d'artisan", required: 1 },
  { category_id: 4, label: "Diplôme / certificat de formation", required: 1 },
  { category_id: 4, label: "Certificat de qualification", required: 0 },
  { category_id: 4, label: "Autre justificatif accepté par l'administration", required: 0 },
  { category_id: 3, label: "Carte professionnelle / justificatif adapté", required: 1 },
  { category_id: 3, label: "Diplôme / certificat", required: 1 },
  { category_id: 3, label: "Certificat de qualification", required: 0 },
  { category_id: 2, label: "Carte professionnelle d'artisan", required: 1 },
  { category_id: 2, label: "Diplôme / certificat", required: 1 },
];
try {
  const cnt = db.prepare("SELECT count(*) as n FROM justificatif_types").get().n;
  if (cnt === 0) {
    const ins = db.prepare("INSERT INTO justificatif_types(category_id, label, required, active) VALUES(?,?,?,1)");
    for (const d of DEFAULTS) ins.run(d.category_id, d.label, d.required);
    console.log(`📄 Justificatifs init: ${DEFAULTS.length} types créés`);
  }
} catch(e){ console.error("Justificatifs init err", e.message); }
