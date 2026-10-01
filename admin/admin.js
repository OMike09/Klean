/* ============================================================
   KLEAN-SERVICES CI — Tableau de bord administrateur
   ============================================================ */
'use strict';
const root = document.getElementById('root');
let TOKEN = localStorage.getItem('ks_admin_token') || null;
let STATS = {};
let VIEW = location.hash.replace('#', '') || 'dashboard';

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtD(s) { if (!s) return ''; const d = new Date(s.replace(' ', 'T') + 'Z'); return d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function fcfa(n) { return (n ?? 0).toLocaleString('fr-FR') + ' F'; }
function toast(m, cls) { const z = document.getElementById('toast'); const t = document.createElement('div'); t.className = 'toast ' + (cls || ''); t.textContent = m; z.appendChild(t); setTimeout(() => t.remove(), 4500); }

async function api(path, opts = {}) {
  const headers = {};
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  let res;
  try { res = await fetch('/api' + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined }); }
  catch { throw new Error('Connexion impossible. Vérifiez votre connexion.'); }
  let data = {};
  try { data = await res.json(); } catch { }
  if (!res.ok) {
    if (res.status === 401) { TOKEN = null; localStorage.removeItem('ks_admin_token'); renderLogin(); }
    throw new Error(data.error || 'Erreur serveur.');
  }
  return data;
}

function openModal(html) { closeModal(); const bg = document.createElement('div'); bg.className = 'modal-bg'; bg.id = 'modal'; bg.innerHTML = `<div class="modal">${html}</div>`; bg.onclick = e => { if (e.target === bg) closeModal(); }; document.body.appendChild(bg); }
function closeModal() { const m = document.getElementById('modal'); if (m) m.remove(); }

/* ---------- Connexion ---------- */
function renderLogin() {
  root.innerHTML = `<div class="login-wrap"><div class="login-box">
    <h2 style="margin:0 0 4px">🖥️ Administration</h2>
    <div class="muted small" style="margin-bottom:18px">Klean-Services CI</div>
    <label class="small muted">Identifiant</label>
    <input type="text" id="l-phone" placeholder="Identifiant administrateur">
    <label class="small muted">Mot de passe</label>
    <input type="password" id="l-pass">
    <button class="btn" id="l-btn">Se connecter</button>
  </div></div>`;
  document.getElementById('l-btn').onclick = async e => {
    e.target.disabled = true;
    try {
      const r = await api('/auth/login', { method: 'POST', body: { phone: document.getElementById('l-phone').value, password: document.getElementById('l-pass').value } });
      if (r.user.role !== 'admin') { toast('Ce compte n\u2019est pas administrateur.', 'err'); e.target.disabled = false; return; }
      TOKEN = r.token; localStorage.setItem('ks_admin_token', TOKEN);
      render();
    } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
  };
  document.getElementById('l-pass').addEventListener('keydown', ev => { if (ev.key === 'Enter') document.getElementById('l-btn').click(); });
}

/* ---------- Structure ---------- */
const MENU = [
  ['TABLEAU DE BORD', [['dashboard', '📊 Vue d\u2019ensemble']]],
  ['UTILISATEURS', [['users', '👥 Tous les comptes'], ['pros', '✅ Validations pro', 'pros_pending']]],
  ['SERVICES', [['catalog', '🗂️ Catégories & services'], ['questions', '❓ Questions dynamiques']]],
  ['MISSIONS', [['missions', '🧰 Demandes & missions'], ['payments', '💰 Paiements & commissions']]],
  ['COMMUNICATION', [['ads', '📣 Publicités & infos'], ['broadcast', '📨 Message système']]],
  ['SÉCURITÉ', [['rules', '📜 Règles & conditions'], ['reports', '⚠️ Signalements', 'signalements'], ['urgences', '🚨 Urgences', 'urgences'], ['files', '🗄️ Gestion des fichiers']]],
  ['CONTENU', [['avis', '📢 Avis de recherche'], ['jobs', '💼 Je cherche un job'], ['ecole', '🏫 École & famille'], ['games', '🎮 Quiz / Flip Fizz / Kdo']]],
  ['CONFIGURATION', [['settings', '⚙️ Paramètres généraux']]],
];

function shell(content) {
  root.innerHTML = `
  <div class="layout">
    <div class="side" id="side">
      <div class="logo">Klean-Services CI<br><span class="small" style="color:#6d9c94;font-weight:600">Administration</span></div>
      ${MENU.map(([grp, items]) => `<div class="grp">${grp}</div>` + items.map(([id, lb, cnt]) =>
        `<button class="${VIEW === id ? 'on' : ''}" onclick="go('${id}')">${lb}${cnt && STATS[cnt] ? `<span class="cnt">${STATS[cnt]}</span>` : ''}</button>`).join('')).join('')}
      <div class="grp"></div>
      <button onclick="location.href='/'">📱 Ouvrir l'application</button>
      <button onclick="adminLogout()">🚪 Se déconnecter</button>
    </div>
    <div class="main">${content}</div>
  </div>
  <button class="menu-toggle" onclick="document.getElementById('side').classList.toggle('open')">☰</button>`;
}
function go(v) { VIEW = v; location.hash = v; render(); }
function adminLogout() { TOKEN = null; localStorage.removeItem('ks_admin_token'); renderLogin(); }
window.go = go; window.adminLogout = adminLogout; window.closeModal = closeModal;

const views = {};

/* ---------- Vue d'ensemble ---------- */
views.dashboard = async () => {
  const s = STATS;
  shell(`<h1>📊 Vue d'ensemble</h1>
  <div class="cards">
    <div class="kpi"><div class="v">${s.users ?? 0}</div><div class="l">Utilisateurs</div></div>
    <div class="kpi"><div class="v">${s.pros ?? 0}</div><div class="l">Professionnels validés</div></div>
    <div class="kpi"><div class="v">${s.pros_pending ?? 0}</div><div class="l">Comptes pro en attente</div></div>
    <div class="kpi"><div class="v">${s.missions ?? 0}</div><div class="l">Missions totales</div></div>
    <div class="kpi"><div class="v">${s.missions_actives ?? 0}</div><div class="l">Missions actives</div></div>
    <div class="kpi"><div class="v">${s.missions_terminees ?? 0}</div><div class="l">Missions terminées</div></div>
    <div class="kpi"><div class="v">${fcfa(s.ca)}</div><div class="l">Volume payé</div></div>
    <div class="kpi"><div class="v">${fcfa(s.commissions)}</div><div class="l">Commissions perçues</div></div>
    <div class="kpi"><div class="v">${s.litiges ?? 0}</div><div class="l">Litiges</div></div>
    <div class="kpi"><div class="v">${s.signalements ?? 0}</div><div class="l">Signalements à traiter</div></div>
    <div class="kpi"><div class="v">${s.urgences ?? 0}</div><div class="l">Urgences non traitées</div></div>
    <div class="kpi"><div class="v">${s.moderation ?? 0}</div><div class="l">Contenus à modérer</div></div>
  </div>
  <div class="panel small muted">Toute modification effectuée ici (commission, délais, questions, services, règles, publicités, jeux…) est appliquée immédiatement dans l'application utilisateur.</div>`);
};

/* ---------- Utilisateurs ---------- */
views.users = async () => {
  const f = sessionStorage.getItem('adm_uf') || 'all';
  const list = await api('/admin/users?filter=' + f);
  shell(`<h1>👥 Utilisateurs</h1>
  <div class="tabs">${[['all', 'Tous'], ['clients', 'Clients'], ['pros', 'Professionnels'], ['pending', 'Pro en attente'], ['suspended', 'Suspendus'], ['verified', 'Vérifiés']]
    .map(([id, lb]) => `<button class="${f === id ? 'on' : ''}" onclick="sessionStorage.setItem('adm_uf','${id}');render()">${lb}</button>`).join('')}</div>
  <div class="panel"><table><tr><th>Nom</th><th>Téléphone</th><th>Localisation</th><th>Statut</th><th>Inscrit le</th><th>Actions</th></tr>
  ${list.map(u => `<tr>
    <td><b>${esc(u.name)}</b> ${u.verified ? '✅' : ''}</td><td>${esc(u.phone)}</td><td>${esc(u.address || '—')}</td>
    <td>${u.suspended ? '<span class="pill bad">Suspendu</span>' : u.pro_status === 'approved' ? '<span class="pill ok">Client • Pro</span>' : u.pro_status === 'pending' ? '<span class="pill warn">Pro en attente</span>' : '<span class="pill info">Client</span>'}</td>
    <td class="small">${fmtD(u.created_at)}</td>
    <td>
      <button class="btn sm sec" onclick="A.userDetail(${u.id})">Détails</button>
      <button class="btn sm ${u.suspended ? '' : 'warn'}" onclick="A.suspend(${u.id},${u.suspended ? 0 : 1})">${u.suspended ? 'Réactiver' : 'Suspendre'}</button>
      <button class="btn sm sec" onclick="A.verify(${u.id},${u.verified ? 0 : 1})">${u.verified ? 'Retirer ✓' : 'Vérifier'}</button>
    </td></tr>`).join('')}
  ${!list.length ? '<tr><td colspan="6" class="muted">Aucun compte.</td></tr>' : ''}</table></div>`);
};

/* ---------- Validations professionnelles ---------- */
views.pros = async () => {
  const list = await api('/admin/pros/pending');
  shell(`<h1>✅ Validations professionnelles</h1>
  ${list.length ? list.map(p => `<div class="panel">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div>
        <b style="font-size:16px">${esc(p.name)}</b> — ${esc(p.profession)}<br>
        <span class="small muted">📞 ${esc(p.phone)} • 📍 ${esc(p.address || '—')} • Demande du ${fmtD(p.created_at)}</span><br>
        <span class="small"><b>Zone :</b> ${esc(p.zone)} • <b>Expérience :</b> ${esc(p.experience || '—')}</span><br>
        <span class="small"><b>Description :</b> ${esc(p.description || '—')}</span><br>
        <span class="small"><b>Documents :</b> ${p.documents.length ? p.documents.map(d => `<a href="${esc(d)}" target="_blank">📄 Voir</a>`).join(' ') : 'Aucun'}</span>
      </div>
      <div style="display:flex;gap:8px;align-items:flex-start">
        <button class="btn" onclick="A.approvePro(${p.user_id})">✅ Valider</button>
        <button class="btn warn" onclick="A.rejectPro(${p.user_id})">Refuser</button>
      </div>
    </div></div>`).join('') : '<div class="panel muted">Aucune demande en attente. Les nouvelles demandes apparaîtront ici.</div>'}`);
};

/* ---------- Catalogue services ---------- */
views.catalog = async () => {
  const d = await api('/admin/catalog');
  shell(`<h1>🗂️ Catégories & services</h1>
  <div class="panel">
    <h2 style="margin-top:0">Ajouter</h2>
    <div class="frow">
      <div><label>Nouvelle catégorie</label><input id="c-name" placeholder="Nom"></div>
      <div><label>Icône (émoji)</label><input id="c-icon" style="width:70px" placeholder="🔹"></div>
      <button class="btn" onclick="A.addCat()">＋ Catégorie</button>
    </div>
    <div class="frow">
      <div><label>Nouveau service</label><input id="s-name" placeholder="Nom du service"></div>
      <div><label>Catégorie</label><select id="s-cat">${d.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div style="flex:1;min-width:200px"><label>Mots-clés (recherche intelligente, séparés par des virgules)</label><input id="s-kw" style="width:100%" placeholder="plombier,fuite,robinet…"></div>
      <button class="btn" onclick="A.addSvc()">＋ Service</button>
    </div>
  </div>
  ${d.categories.map(c => `<div class="panel">
    <h2 style="margin-top:0">${esc(c.icon || '')} ${esc(c.name)} ${c.active ? '' : '<span class="pill off">Inactive</span>'}
      <button class="btn sm sec" onclick="A.toggleCat(${c.id},${c.active ? 0 : 1})">${c.active ? 'Désactiver' : 'Activer'}</button></h2>
    <table><tr><th>Service</th><th>Mots-clés</th><th>État</th><th>Actions</th></tr>
    ${d.services.filter(s => s.category_id === c.id).map(s => `<tr>
      <td><b>${esc(s.name)}</b></td><td class="small muted">${esc(s.keywords)}</td>
      <td>${s.active ? '<span class="pill ok">Actif</span>' : '<span class="pill off">Inactif</span>'}</td>
      <td><button class="btn sm sec" onclick="A.editSvc(${s.id},'${esc(s.name).replace(/'/g, "\\'")}','${esc(s.keywords).replace(/'/g, "\\'")}')">Modifier</button>
      <button class="btn sm ${s.active ? 'warn' : ''}" onclick="A.toggleSvc(${s.id},${s.active ? 0 : 1})">${s.active ? 'Désactiver' : 'Activer'}</button></td></tr>`).join('')}
    </table></div>`).join('')}`);
};

/* ---------- Questions dynamiques ---------- */
views.questions = async () => {
  const d = await api('/admin/catalog');
  const sid = parseInt(sessionStorage.getItem('adm_qsvc') || d.services[0]?.id || 0, 10);
  const qs = d.questions.filter(q => q.service_id === sid).sort((a, b) => a.sort - b.sort);
  shell(`<h1>❓ Questions dynamiques par service</h1>
  <div class="panel small muted">Ces questions s'affichent dans l'application lorsque le client fait une demande pour le service choisi. Vous pouvez ajouter, modifier, réorganiser, activer/désactiver ou supprimer sans affecter les autres services.</div>
  <div class="frow"><div><label>Service</label>
    <select id="q-svc" onchange="sessionStorage.setItem('adm_qsvc',this.value);render()">
      ${d.services.map(s => `<option value="${s.id}" ${s.id === sid ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
    </select></div>
    <button class="btn" onclick="A.qForm(${sid})">＋ Ajouter une question</button></div>
  <div class="panel"><table><tr><th>Ordre</th><th>Question</th><th>Type</th><th>Options</th><th>Obligatoire</th><th>État</th><th>Actions</th></tr>
  ${qs.map((q, i) => `<tr>
    <td>
      <button class="btn sm sec" ${i === 0 ? 'disabled' : ''} onclick="A.qMove(${q.id},${qs[i - 1] ? qs[i - 1].sort : 0},${q.sort},${qs[i - 1] ? qs[i - 1].id : 0})">↑</button>
      <button class="btn sm sec" ${i === qs.length - 1 ? 'disabled' : ''} onclick="A.qMove(${q.id},${qs[i + 1] ? qs[i + 1].sort : 0},${q.sort},${qs[i + 1] ? qs[i + 1].id : 0})">↓</button>
    </td>
    <td><b>${esc(q.label)}</b></td><td>${q.type}</td><td class="small muted">${q.options.map(esc).join(', ')}</td>
    <td>${q.required ? '<span class="pill warn">Oui</span>' : 'Non'}</td>
    <td>${q.active ? '<span class="pill ok">Active</span>' : '<span class="pill off">Inactive</span>'}</td>
    <td><button class="btn sm sec" onclick='A.qForm(${sid},${JSON.stringify(q).replace(/'/g, "&#39;")})'>Modifier</button>
    <button class="btn sm sec" onclick="A.qToggle(${q.id},${q.active ? 0 : 1})">${q.active ? 'Désactiver' : 'Activer'}</button>
    <button class="btn sm warn" onclick="A.qDel(${q.id})">🗑️</button></td></tr>`).join('')}
  ${!qs.length ? '<tr><td colspan="7" class="muted">Aucune question pour ce service.</td></tr>' : ''}</table></div>`);
};

/* ---------- Missions ---------- */
views.missions = async () => {
  const f = sessionStorage.getItem('adm_mf') || 'all';
  const list = await api('/admin/missions?filter=' + f);
  const SL = { recherche: ['warn', 'Recherche'], sans_pro: ['bad', 'Sans pro'], acceptee: ['info', 'Acceptée'], confirmee: ['info', 'Programmée'], en_cours: ['info', 'En cours'], terminee: ['ok', 'Terminée'], payee: ['ok', 'Payée'], annulee: ['off', 'Annulée'], litige: ['bad', 'Litige'] };
  shell(`<h1>🧰 Demandes & missions</h1>
  <div class="tabs">${[['all', 'Toutes'], ['demandes', 'Demandes'], ['attente', 'En attente'], ['en_cours', 'En cours'], ['terminees', 'Terminées'], ['litiges', 'Litiges']]
    .map(([id, lb]) => `<button class="${f === id ? 'on' : ''}" onclick="sessionStorage.setItem('adm_mf','${id}');render()">${lb}</button>`).join('')}</div>
  <div class="panel"><table><tr><th>N°</th><th>Service</th><th>Client</th><th>Professionnel</th><th>Montant</th><th>Statut</th><th>Date</th><th>Actions</th></tr>
  ${list.map(m => { const [cls, lb] = SL[m.status] || ['off', m.status]; return `<tr>
    <td class="small">${esc(m.code)}</td><td><b>${esc(m.service_name)}</b>${m.urgence ? ' 🔥' : ''}</td>
    <td>${esc(m.client_name)}</td><td>${esc(m.pro_name || '—')}</td>
    <td>${m.amount ? fcfa(m.amount) : '—'}</td><td><span class="pill ${cls}">${lb}</span></td>
    <td class="small">${fmtD(m.created_at)}</td>
    <td>${m.status === 'litige'
      ? `<button class="btn sm" onclick="A.litige(${m.id},false)">Résoudre</button>`
      : `<button class="btn sm warn" onclick="A.litige(${m.id},true)">Litige</button>`}</td></tr>`; }).join('')}
  ${!list.length ? '<tr><td colspan="8" class="muted">Aucune mission.</td></tr>' : ''}</table></div>`);
};

/* ---------- Paiements ---------- */
views.payments = async () => {
  const list = await api('/admin/payments');
  const valid = list.filter(p => p.status === 'valide');
  shell(`<h1>💰 Paiements & commissions</h1>
  <div class="cards">
    <div class="kpi"><div class="v">${fcfa(valid.reduce((s, p) => s + p.amount, 0))}</div><div class="l">Total encaissé (validé)</div></div>
    <div class="kpi"><div class="v">${fcfa(valid.reduce((s, p) => s + p.commission_amount, 0))}</div><div class="l">Commissions Klean-Services</div></div>
    <div class="kpi"><div class="v">${fcfa(valid.reduce((s, p) => s + p.pro_amount, 0))}</div><div class="l">Reversé aux professionnels</div></div>
    <div class="kpi"><div class="v">${list.filter(p => p.status !== 'valide').length}</div><div class="l">En attente de confirmation</div></div>
  </div>
  <div class="panel"><table><tr><th>Mission</th><th>Client</th><th>Professionnel</th><th>Montant</th><th>Commission</th><th>Part pro</th><th>Mode</th><th>Statut</th><th>Date</th></tr>
  ${list.map(p => `<tr><td class="small">${esc(p.code)}</td><td>${esc(p.client_name)}</td><td>${esc(p.pro_name || '—')}</td>
    <td><b>${fcfa(p.amount)}</b></td><td>${fcfa(p.commission_amount)} <span class="small muted">(${p.commission_rate}%)</span></td><td>${fcfa(p.pro_amount)}</td>
    <td>Espèces</td>
    <td>${p.status === 'valide' ? '<span class="pill ok">Validé</span>' : p.status === 'en_attente' ? '<span class="pill warn">En attente</span>' : '<span class="pill info">Partiel</span>'}</td>
    <td class="small">${fmtD(p.created_at)}</td></tr>`).join('')}
  ${!list.length ? '<tr><td colspan="9" class="muted">Aucun paiement.</td></tr>' : ''}</table></div>`);
};

/* ---------- Publicités ---------- */
views.ads = async () => {
  const list = await api('/admin/ads');
  shell(`<h1>📣 Publicités & informations</h1>
  <div class="panel">
    <h2 style="margin-top:0">Publier</h2>
    <div class="frow">
      <div><label>Type</label><select id="ad-type"><option value="texte">Texte</option><option value="image">Image</option><option value="video">Vidéo</option></select></div>
      <div><label>Titre</label><input id="ad-title"></div>
      <div style="flex:1;min-width:220px"><label>Contenu / texte</label><input id="ad-content" style="width:100%"></div>
    </div>
    <div class="frow">
      <div><label>Fichier (image/vidéo)</label><input type="file" id="ad-file" accept="image/*,video/*"></div>
      <div><label>Emplacement</label><select id="ad-place"><option value="accueil">Accueil</option><option value="services">Services</option></select></div>
      <div><label>Durée d'affichage (s)</label><input type="number" id="ad-dur" value="6" style="width:90px"></div>
      <button class="btn" onclick="A.addAd()">Publier</button>
    </div>
    <div class="small muted">Les images/vidéos trop lourdes sont limitées à 15 Mo. Les publicités s'affichent sans bloquer l'utilisation de l'application.</div>
  </div>
  <div class="panel"><table><tr><th>Type</th><th>Titre</th><th>Contenu</th><th>Emplacement</th><th>État</th><th>Actions</th></tr>
  ${list.map(a => `<tr><td>${a.type}</td><td><b>${esc(a.title || '')}</b></td>
    <td class="small">${esc((a.content || '').slice(0, 60))} ${a.file ? `<a href="${esc(a.file)}" target="_blank">📎</a>` : ''}</td>
    <td>${a.placement}</td><td>${a.active ? '<span class="pill ok">Active</span>' : '<span class="pill off">Inactive</span>'}</td>
    <td><button class="btn sm sec" onclick="A.toggleAd(${a.id},${a.active ? 0 : 1})">${a.active ? 'Désactiver' : 'Activer'}</button>
    <button class="btn sm warn" onclick="A.delAd(${a.id})">🗑️</button></td></tr>`).join('')}
  ${!list.length ? '<tr><td colspan="6" class="muted">Aucune publicité.</td></tr>' : ''}</table></div>`);
};

/* ---------- Message système ---------- */
views.broadcast = async () => {
  shell(`<h1>📨 Message système</h1>
  <div class="panel">
    <div class="small muted" style="margin-bottom:10px">Envoie une notification à tous les utilisateurs actifs de l'application.</div>
    <div class="frow"><div style="flex:1"><label>Titre</label><input id="bc-title" style="width:100%"></div></div>
    <div class="frow"><div style="flex:1"><label>Message</label><textarea id="bc-body"></textarea></div></div>
    <button class="btn" onclick="A.broadcast()">📨 Envoyer à tous</button>
  </div>`);
};

/* ---------- Règles ---------- */
views.rules = async () => {
  const s = await api('/admin/settings');
  shell(`<h1>📜 Règles & conditions</h1>
  <div class="panel"><h2 style="margin-top:0">Règles client</h2>
    <textarea class="rules-ta" id="r-client">${esc(s.rules_client || '')}</textarea>
    <button class="btn" style="margin-top:8px" onclick="A.saveRules('rules_client','r-client')">Enregistrer les règles client</button></div>
  <div class="panel"><h2 style="margin-top:0">Règles professionnel</h2>
    <textarea class="rules-ta" id="r-pro">${esc(s.rules_pro || '')}</textarea>
    <button class="btn" style="margin-top:8px" onclick="A.saveRules('rules_pro','r-pro')">Enregistrer les règles professionnel</button></div>
  <div class="panel small muted">Ces textes sont affichés et doivent être acceptés : à la création d'un compte (règles client) et lors de la demande professionnelle (règles professionnel). L'acceptation est enregistrée avec la date.</div>`);
};

/* ---------- Signalements ---------- */
views.reports = async () => {
  const list = await api('/admin/signalements');
  shell(`<h1>⚠️ Signalements</h1>
  <div class="panel"><table><tr><th>Par</th><th>Visé</th><th>Mission</th><th>Motif</th><th>Statut</th><th>Date</th><th></th></tr>
  ${list.map(s => `<tr><td>${esc(s.reporter)}</td><td>${esc(s.target || '—')}</td><td class="small">${s.mission_id || '—'}</td>
    <td class="small">${esc(s.reason)}</td>
    <td>${s.status === 'traite' ? '<span class="pill ok">Traité</span>' : '<span class="pill warn">Nouveau</span>'}</td>
    <td class="small">${fmtD(s.created_at)}</td>
    <td>${s.status !== 'traite' ? `<button class="btn sm" onclick="A.treatReport(${s.id})">Marquer traité</button>` : ''}</td></tr>`).join('')}
  ${!list.length ? '<tr><td colspan="7" class="muted">Aucun signalement.</td></tr>' : ''}</table></div>`);
};

/* ---------- Urgences ---------- */
views.urgences = async () => {
  const list = await api('/admin/urgences');
  shell(`<h1>🚨 Urgences</h1>
  <div class="panel"><table><tr><th>Utilisateur</th><th>Téléphone</th><th>Message</th><th>Position</th><th>Date</th><th>Statut</th><th></th></tr>
  ${list.map(u => `<tr><td><b>${esc(u.name)}</b></td><td><a href="tel:${esc(u.phone)}">${esc(u.phone)}</a></td>
    <td class="small">${esc(u.message || '—')}</td>
    <td class="small">${u.lat ? `<a href="https://maps.google.com/?q=${u.lat},${u.lng}" target="_blank">📍 Carte</a>` : '—'}</td>
    <td class="small">${fmtD(u.created_at)}</td>
    <td>${u.handled ? '<span class="pill ok">Traitée</span>' : '<span class="pill bad">À traiter</span>'}</td>
    <td>${!u.handled ? `<button class="btn sm" onclick="A.treatUrg(${u.id})">Marquer traitée</button>` : ''}</td></tr>`).join('')}
  ${!list.length ? '<tr><td colspan="7" class="muted">Aucune urgence.</td></tr>' : ''}</table></div>`);
};

/* ---------- Fichiers ---------- */
views.files = async () => {
  const d = await api('/admin/files');
  shell(`<h1>🗄️ Gestion des fichiers</h1>
  <div class="cards">
    <div class="kpi"><div class="v">${d.total}</div><div class="l">Fichiers stockés</div></div>
    <div class="kpi"><div class="v">${(d.total_size / 1048576).toFixed(1)} Mo</div><div class="l">Espace utilisé</div></div>
    <div class="kpi"><div class="v">${d.retention_days} j</div><div class="l">Durée de conservation</div></div>
  </div>
  <div class="panel">
    <div class="small muted" style="margin-bottom:10px">Les fichiers plus anciens que la durée de conservation (modifiable dans Paramètres) sont supprimés automatiquement toutes les 12 h. Vous pouvez aussi lancer le nettoyage manuellement.</div>
    <button class="btn warn" onclick="A.cleanup()">🧹 Lancer le nettoyage maintenant</button>
  </div>
  <div class="panel"><table><tr><th>Fichier</th><th>Taille</th><th>Âge</th></tr>
  ${d.files.slice(0, 100).map(f => `<tr><td><a href="/uploads/${esc(f.name)}" target="_blank">${esc(f.name)}</a></td>
    <td>${(f.size / 1024).toFixed(0)} Ko</td><td>${f.age_days} jour(s)</td></tr>`).join('')}
  ${!d.files.length ? '<tr><td colspan="3" class="muted">Aucun fichier.</td></tr>' : ''}</table></div>`);
};

/* ---------- Contenu : avis, jobs, école ---------- */
views.avis = async () => {
  const list = await api('/admin/avis-recherche');
  shell(`<h1>📢 Avis de recherche</h1>
  <div class="panel"><table><tr><th></th><th>Nom</th><th>Publié par</th><th>Détails</th><th>Contact</th><th>Statut</th><th>Actions</th></tr>
  ${list.map(a => `<tr>
    <td>${a.photo ? `<img class="thumb" src="${esc(a.photo)}">` : '—'}</td>
    <td><b>${esc(a.nom)}</b></td><td class="small">${esc(a.publisher)}<br>${esc(a.phone)}</td>
    <td class="small">${esc([a.date_disparition, a.dernier_lieu, a.description_physique].filter(Boolean).join(' • '))}</td>
    <td class="small">${esc(a.contact)}</td>
    <td>${a.status === 'approved' ? '<span class="pill ok">Publié</span>' : a.status === 'pending' ? '<span class="pill warn">En attente</span>' : a.status === 'resolved' ? '<span class="pill info">Résolu</span>' : '<span class="pill bad">Refusé</span>'}</td>
    <td>
      ${a.status === 'pending' ? `<button class="btn sm" onclick="A.avisStatus(${a.id},'approved')">Publier</button><button class="btn sm warn" onclick="A.avisStatus(${a.id},'rejected')">Refuser</button>` : ''}
      ${a.status === 'approved' ? `<button class="btn sm sec" onclick="A.avisStatus(${a.id},'resolved')">Marquer résolu</button>` : ''}
    </td></tr>`).join('')}
  ${!list.length ? '<tr><td colspan="7" class="muted">Aucun avis de recherche.</td></tr>' : ''}</table></div>`);
};

views.jobs = async () => {
  const list = await api('/admin/jobs');
  shell(`<h1>💼 Je cherche un job</h1>
  <div class="panel"><table><tr><th>Métier</th><th>Publié par</th><th>Détails</th><th>Contact</th><th>Statut</th><th>Actions</th></tr>
  ${list.map(j => `<tr><td><b>${esc(j.metier)}</b></td><td class="small">${esc(j.publisher)}<br>${esc(j.phone)}</td>
    <td class="small">${esc([j.competences, j.experience, j.localisation, j.disponibilite].filter(Boolean).join(' • '))} ${j.cv ? `<a href="${esc(j.cv)}" target="_blank">📄 CV</a>` : ''}</td>
    <td class="small">${esc(j.contact)}</td>
    <td>${j.status === 'approved' ? '<span class="pill ok">Publié</span>' : j.status === 'pending' ? '<span class="pill warn">En attente</span>' : '<span class="pill bad">Refusé</span>'}</td>
    <td>${j.status === 'pending' ? `<button class="btn sm" onclick="A.jobStatus(${j.id},'approved')">Publier</button><button class="btn sm warn" onclick="A.jobStatus(${j.id},'rejected')">Refuser</button>` : ''}</td></tr>`).join('')}
  ${!list.length ? '<tr><td colspan="6" class="muted">Aucun profil.</td></tr>' : ''}</table></div>`);
};

views.ecole = async () => {
  const list = await api('/admin/ecole-famille');
  shell(`<h1>🏫 École & famille</h1>
  <div class="panel"><table><tr><th>Type</th><th>Demandeur</th><th>Détails</th><th>Contact</th><th>Statut</th><th>Actions</th></tr>
  ${list.map(x => `<tr><td><b>${esc(x.type)}</b></td><td class="small">${esc(x.name)}<br>${esc(x.phone)}</td>
    <td class="small">${esc(x.details)}</td><td class="small">${esc(x.contact || '')}</td>
    <td>${x.status === 'traite' ? '<span class="pill ok">Traitée</span>' : x.status === 'en_traitement' ? '<span class="pill info">En traitement</span>' : '<span class="pill warn">Nouvelle</span>'}</td>
    <td>${x.status === 'nouveau' ? `<button class="btn sm sec" onclick="A.efStatus(${x.id},'en_traitement')">Prendre en charge</button>` : ''}
    ${x.status !== 'traite' ? `<button class="btn sm" onclick="A.efStatus(${x.id},'traite')">Marquer traitée</button>` : ''}</td></tr>`).join('')}
  ${!list.length ? '<tr><td colspan="6" class="muted">Aucune demande.</td></tr>' : ''}</table></div>`);
};

/* ---------- Jeux ---------- */
views.games = async () => {
  const s = await api('/admin/settings');
  const quiz = await api('/admin/quiz');
  const kdo = await api('/admin/kdo');
  const plays = await api('/admin/game-plays');
  shell(`<h1>🎮 Quiz / Flip Fizz / Kdo</h1>
  <div class="panel">
    <h2 style="margin-top:0">Activation (visibles sur l'accueil uniquement si activés)</h2>
    <div class="frow">
      ${[['quiz_enabled', '🧠 Quiz'], ['flipfizz_enabled', '🎲 Flip Fizz'], ['kdo_enabled', '🎁 Kdo']].map(([k, lb]) =>
        `<button class="btn ${s[k] === '1' ? '' : 'sec'}" onclick="A.toggleSetting('${k}',${s[k] === '1' ? "'0'" : "'1'"})">${lb} : ${s[k] === '1' ? 'Activé ✅' : 'Désactivé'}</button>`).join('')}
    </div></div>
  <div class="panel"><h2 style="margin-top:0">Questions du quiz</h2>
    <div class="frow">
      <div style="flex:1"><label>Question</label><input id="qz-q" style="width:100%"></div>
      <div><label>Options (séparées par ;)</label><input id="qz-opts" placeholder="Option A;Option B;Option C"></div>
      <div><label>N° bonne réponse (1,2,3…)</label><input type="number" id="qz-ans" value="1" style="width:80px"></div>
      <button class="btn" onclick="A.addQuiz()">＋</button>
    </div>
    <table><tr><th>Question</th><th>Options</th><th>Réponse</th><th></th></tr>
    ${quiz.map(q => `<tr><td>${esc(q.question)}</td><td class="small">${q.options.map(esc).join(' / ')}</td>
      <td><b>${esc(q.options[q.answer] || '')}</b></td>
      <td><button class="btn sm warn" onclick="A.delQuiz(${q.id})">🗑️</button></td></tr>`).join('')}</table></div>
  <div class="panel"><h2 style="margin-top:0">Codes Kdo (récompenses)</h2>
    <div class="frow">
      <div><label>Code</label><input id="kdo-code" placeholder="KLEAN2026"></div>
      <div style="flex:1"><label>Récompense</label><input id="kdo-reward" style="width:100%" placeholder="Ex : 1 nettoyage de fauteuil offert"></div>
      <button class="btn" onclick="A.addKdo()">＋</button>
    </div>
    <table><tr><th>Code</th><th>Récompense</th><th>Utilisé par</th><th></th></tr>
    ${kdo.map(k => `<tr><td><b>${esc(k.code)}</b></td><td>${esc(k.reward)}</td>
      <td>${k.used_by_name ? esc(k.used_by_name) + ' <span class="small muted">' + fmtD(k.used_at) + '</span>' : '<span class="pill ok">Disponible</span>'}</td>
      <td><button class="btn sm warn" onclick="A.delKdo(${k.id})">🗑️</button></td></tr>`).join('')}</table></div>
  <div class="panel"><h2 style="margin-top:0">Participations récentes</h2>
    <table><tr><th>Joueur</th><th>Jeu</th><th>Résultat</th><th>Date</th></tr>
    ${plays.slice(0, 50).map(p => `<tr><td>${esc(p.name)} <span class="small muted">${esc(p.phone)}</span></td><td>${p.game}</td><td>${esc(p.result || p.score || '')}</td><td class="small">${fmtD(p.created_at)}</td></tr>`).join('')}
    ${!plays.length ? '<tr><td colspan="4" class="muted">Aucune participation.</td></tr>' : ''}</table></div>`);
};

/* ---------- Paramètres ---------- */
views.settings = async () => {
  const s = await api('/admin/settings');
  const contacts = JSON.parse(s.urgence_contacts || '[]');
  shell(`<h1>⚙️ Paramètres généraux</h1>
  <div class="panel">
    <h2 style="margin-top:0">Missions & paiements</h2>
    <div class="frow">
      <div><label>Commission Klean-Services CI (%)</label><input type="number" id="st-comm" value="${esc(s.commission_rate)}" min="0" max="100" step="0.5" style="width:110px"></div>
      <div><label>Délai de réponse d'un professionnel (secondes)</label><input type="number" id="st-wait" value="${esc(s.dispatch_wait_seconds)}" min="15" max="3600" style="width:130px"></div>
      <div><label>Conservation des fichiers (jours)</label><input type="number" id="st-ret" value="${esc(s.file_retention_days)}" min="1" style="width:110px"></div>
    </div>
    <div class="frow">
      <button class="btn ${s.payment_especes === '1' ? '' : 'sec'}" onclick="A.toggleSetting('payment_especes',${s.payment_especes === '1' ? "'0'" : "'1'"})">💵 Paiement espèces : ${s.payment_especes === '1' ? 'Activé ✅' : 'Désactivé'}</button>
      <button class="btn ${s.payment_mobile_money === '1' ? '' : 'sec'}" onclick="A.toggleSetting('payment_mobile_money',${s.payment_mobile_money === '1' ? "'0'" : "'1'"})">📱 Mobile Money : ${s.payment_mobile_money === '1' ? 'Activé ✅' : 'Désactivé (à venir)'}</button>
    </div>
    <button class="btn" onclick="A.saveMain()">Enregistrer</button>
    <div class="small muted" style="margin-top:8px">Le délai de réponse contrôle le temps laissé à chaque professionnel avant de passer au suivant (ex : 60 s).</div>
  </div>
  <div class="panel">
    <h2 style="margin-top:0">Urgence</h2>
    <div class="frow"><div style="flex:1"><label>Message d'information affiché dans l'application</label><textarea id="st-urginfo">${esc(s.urgence_info || '')}</textarea></div></div>
    <label class="small muted">Contacts d'urgence (un par ligne : Nom | Numéro)</label>
    <textarea id="st-urgc">${contacts.map(c => c.nom + ' | ' + c.tel).join('\n')}</textarea>
    <button class="btn" style="margin-top:8px" onclick="A.saveUrgence()">Enregistrer l'urgence</button>
  </div>`);
};

/* ---------- Actions ---------- */
const A = {
  async userDetail(id) {
    try {
      const u = await api('/admin/users/' + id);
      openModal(`<h3>${esc(u.name)}</h3>
        <p class="small">📞 ${esc(u.phone)} • 📍 ${esc(u.address || '—')}<br>
        Inscrit le ${fmtD(u.created_at)} • ${u.missions} mission(s)<br>
        Règles acceptées : ${u.rules_accepted_at ? fmtD(u.rules_accepted_at) : 'Non'}<br>
        Règles pro acceptées : ${u.pro_rules_accepted_at ? fmtD(u.pro_rules_accepted_at) : '—'}</p>
        ${u.pro ? `<p class="small"><b>Profil pro :</b> ${esc(u.pro.profession)} — ${esc(u.pro.zone)}<br>
        Disponible : ${u.pro.available ? 'Oui 🟢' : 'Non ⚪'}<br>
        Documents : ${u.pro.documents.length ? u.pro.documents.map(d => `<a href="${esc(d)}" target="_blank">📄</a>`).join(' ') : 'Aucun'}</p>` : ''}
        <button class="btn" onclick="closeModal()">Fermer</button>`);
    } catch (e) { toast(e.message, 'err'); }
  },
  async suspend(id, v) { try { await api(`/admin/users/${id}/suspend`, { method: 'POST', body: { suspended: v } }); toast(v ? 'Compte suspendu.' : 'Compte réactivé.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async verify(id, v) { try { await api(`/admin/users/${id}/verify`, { method: 'POST', body: { verified: v } }); toast('Mis à jour ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async approvePro(id) { try { await api(`/admin/pros/${id}/approve`, { method: 'POST' }); toast('Professionnel validé ✅ Il a été notifié.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  rejectPro(id) {
    openModal(`<h3>Refuser la demande</h3>
      <label class="small muted">Raison (communiquée à l'utilisateur)</label>
      <input id="rej-reason" style="width:100%;margin-bottom:12px" placeholder="Ex : Documents illisibles">
      <button class="btn warn" onclick="A._doReject(${id})">Refuser</button> <button class="btn sec" onclick="closeModal()">Annuler</button>`);
  },
  async _doReject(id) { try { await api(`/admin/pros/${id}/reject`, { method: 'POST', body: { reason: document.getElementById('rej-reason').value } }); closeModal(); toast('Demande refusée.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },

  async addCat() { try { await api('/admin/categories', { method: 'POST', body: { name: document.getElementById('c-name').value, icon: document.getElementById('c-icon').value } }); toast('Catégorie ajoutée ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async toggleCat(id, v) { try { await api('/admin/categories/' + id, { method: 'PUT', body: { active: v } }); render(); } catch (e) { toast(e.message, 'err'); } },
  async addSvc() { try { await api('/admin/services', { method: 'POST', body: { name: document.getElementById('s-name').value, category_id: document.getElementById('s-cat').value, keywords: document.getElementById('s-kw').value } }); toast('Service ajouté ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async toggleSvc(id, v) { try { await api('/admin/services/' + id, { method: 'PUT', body: { active: v } }); render(); } catch (e) { toast(e.message, 'err'); } },
  editSvc(id, name, kw) {
    openModal(`<h3>Modifier le service</h3>
      <label class="small muted">Nom</label><input id="es-name" style="width:100%;margin-bottom:10px" value="${name}">
      <label class="small muted">Mots-clés (recherche intelligente)</label><input id="es-kw" style="width:100%;margin-bottom:12px" value="${kw}">
      <button class="btn" onclick="A._saveSvc(${id})">Enregistrer</button>`);
  },
  async _saveSvc(id) { try { await api('/admin/services/' + id, { method: 'PUT', body: { name: document.getElementById('es-name').value, keywords: document.getElementById('es-kw').value } }); closeModal(); toast('Service modifié ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },

  qForm(sid, q) {
    openModal(`<h3>${q ? 'Modifier' : 'Ajouter'} une question</h3>
      <label class="small muted">Libellé de la question</label>
      <input id="qf-label" style="width:100%;margin-bottom:10px" value="${q ? esc(q.label) : ''}">
      <label class="small muted">Type</label>
      <select id="qf-type" style="width:100%;margin-bottom:10px">
        ${[['text', 'Texte libre'], ['number', 'Nombre'], ['select', 'Choix (options)'], ['bool', 'Oui / Non'], ['date', 'Date']].map(([v, l]) => `<option value="${v}" ${q && q.type === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <label class="small muted">Options (pour type « Choix », séparées par ;)</label>
      <input id="qf-opts" style="width:100%;margin-bottom:10px" value="${q ? esc(q.options.join(';')) : ''}">
      <label style="display:flex;gap:8px;align-items:center;margin-bottom:12px"><input type="checkbox" id="qf-req" ${q && q.required ? 'checked' : ''}> Réponse obligatoire</label>
      <button class="btn" onclick="A._saveQ(${sid},${q ? q.id : 'null'})">Enregistrer</button>`);
  },
  async _saveQ(sid, qid) {
    const body = {
      service_id: sid, label: document.getElementById('qf-label').value,
      type: document.getElementById('qf-type').value,
      options: document.getElementById('qf-opts').value.split(';').map(s => s.trim()).filter(Boolean),
      required: document.getElementById('qf-req').checked ? 1 : 0
    };
    try {
      if (qid) await api('/admin/questions/' + qid, { method: 'PUT', body });
      else await api('/admin/questions', { method: 'POST', body });
      closeModal(); toast('Question enregistrée ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async qToggle(id, v) { try { await api('/admin/questions/' + id, { method: 'PUT', body: { active: v } }); render(); } catch (e) { toast(e.message, 'err'); } },
  async qDel(id) { if (!confirm('Supprimer cette question ?')) return; try { await api('/admin/questions/' + id, { method: 'DELETE' }); toast('Question supprimée.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async qMove(id, otherSort, mySort, otherId) {
    try {
      await api('/admin/questions/' + id, { method: 'PUT', body: { sort: otherSort } });
      await api('/admin/questions/' + otherId, { method: 'PUT', body: { sort: mySort } });
      render();
    } catch (e) { toast(e.message, 'err'); }
  },

  async litige(id, open) { try { await api(`/admin/missions/${id}/litige`, { method: 'POST', body: { open } }); toast(open ? 'Litige ouvert.' : 'Litige résolu.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },

  async addAd() {
    const fileInput = document.getElementById('ad-file');
    let file = null;
    try {
      if (fileInput.files.length) {
        const fd = new FormData(); fd.append('files', fileInput.files[0]);
        const r = await fetch('/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Échec de l\u2019envoi du fichier.');
        file = d.files[0];
      }
      await api('/admin/ads', {
        method: 'POST', body: {
          type: document.getElementById('ad-type').value, title: document.getElementById('ad-title').value,
          content: document.getElementById('ad-content').value, file,
          placement: document.getElementById('ad-place').value, duration: parseInt(document.getElementById('ad-dur').value, 10) || 6
        }
      });
      toast('Publicité publiée ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async toggleAd(id, v) { try { await api('/admin/ads/' + id, { method: 'PUT', body: { active: v } }); render(); } catch (e) { toast(e.message, 'err'); } },
  async delAd(id) { if (!confirm('Supprimer cette publicité ?')) return; try { await api('/admin/ads/' + id, { method: 'DELETE' }); render(); } catch (e) { toast(e.message, 'err'); } },
  async broadcast() {
    try {
      const r = await api('/admin/broadcast', { method: 'POST', body: { title: document.getElementById('bc-title').value, body: document.getElementById('bc-body').value } });
      toast(`Message envoyé à ${r.sent} utilisateur(s) ✓`, 'ok');
      document.getElementById('bc-title').value = ''; document.getElementById('bc-body').value = '';
    } catch (e) { toast(e.message, 'err'); }
  },
  async saveRules(key, elId) { try { await api('/admin/settings', { method: 'PUT', body: { [key]: document.getElementById(elId).value } }); toast('Règles enregistrées ✓ (appliquées immédiatement dans l\u2019application)', 'ok'); } catch (e) { toast(e.message, 'err'); } },
  async treatReport(id) { try { await api(`/admin/signalements/${id}/traiter`, { method: 'POST' }); render(); } catch (e) { toast(e.message, 'err'); } },
  async treatUrg(id) { try { await api(`/admin/urgences/${id}/traiter`, { method: 'POST' }); render(); } catch (e) { toast(e.message, 'err'); } },
  async cleanup() { try { const r = await api('/admin/files/cleanup', { method: 'POST' }); toast(`Nettoyage terminé : ${r.deleted} fichier(s) supprimé(s).`, 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async avisStatus(id, st) { try { await api(`/admin/avis-recherche/${id}/status`, { method: 'POST', body: { status: st } }); toast('Statut mis à jour ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async jobStatus(id, st) { try { await api(`/admin/jobs/${id}/status`, { method: 'POST', body: { status: st } }); toast('Statut mis à jour ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async efStatus(id, st) { try { await api(`/admin/ecole-famille/${id}/status`, { method: 'POST', body: { status: st } }); render(); } catch (e) { toast(e.message, 'err'); } },
  async toggleSetting(k, v) { try { await api('/admin/settings', { method: 'PUT', body: { [k]: v } }); toast('Paramètre mis à jour ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async addQuiz() {
    try {
      await api('/admin/quiz', {
        method: 'POST', body: {
          question: document.getElementById('qz-q').value,
          options: document.getElementById('qz-opts').value.split(';').map(s => s.trim()).filter(Boolean),
          answer: (parseInt(document.getElementById('qz-ans').value, 10) || 1) - 1
        }
      });
      toast('Question ajoutée ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async delQuiz(id) { try { await api('/admin/quiz/' + id, { method: 'DELETE' }); render(); } catch (e) { toast(e.message, 'err'); } },
  async addKdo() { try { await api('/admin/kdo', { method: 'POST', body: { code: document.getElementById('kdo-code').value, reward: document.getElementById('kdo-reward').value } }); toast('Code ajouté ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async delKdo(id) { try { await api('/admin/kdo/' + id, { method: 'DELETE' }); render(); } catch (e) { toast(e.message, 'err'); } },
  async saveMain() {
    try {
      await api('/admin/settings', {
        method: 'PUT', body: {
          commission_rate: document.getElementById('st-comm').value,
          dispatch_wait_seconds: document.getElementById('st-wait').value,
          file_retention_days: document.getElementById('st-ret').value
        }
      });
      toast('Paramètres enregistrés ✓ (appliqués immédiatement)', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  async saveUrgence() {
    const contacts = document.getElementById('st-urgc').value.split('\n').map(l => {
      const [nom, tel] = l.split('|').map(s => (s || '').trim());
      return nom && tel ? { nom, tel } : null;
    }).filter(Boolean);
    try {
      await api('/admin/settings', { method: 'PUT', body: { urgence_info: document.getElementById('st-urginfo').value, urgence_contacts: JSON.stringify(contacts) } });
      toast('Paramètres d\u2019urgence enregistrés ✓', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
};
window.A = A;

/* ---------- Rendu ---------- */
async function render() {
  if (!TOKEN) { renderLogin(); return; }
  try { STATS = await api('/admin/stats'); } catch (e) { return; }
  const fn = views[VIEW] || views.dashboard;
  try { await fn(); } catch (e) { shell(`<h1>Erreur</h1><div class="panel">${esc(e.message)}<br><button class="btn" style="margin-top:10px" onclick="render()">Réessayer</button></div>`); }
}
window.render = render;
window.addEventListener('hashchange', () => { VIEW = location.hash.replace('#', '') || 'dashboard'; render(); });
render();
