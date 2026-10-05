/* ============================================================
   KLEAN-SERVICES CI — Tableau de bord administrateur
   ============================================================ */
'use strict';
const root = document.getElementById('root');
let TOKEN = localStorage.getItem('ks_admin_token') || null;
let STATS = {};
let ME = null; // compte connecté : { role, perms: [...] }
let VIEW = location.hash.replace('#', '') || 'dashboard';
const ROLE_LB = { pdg: '👑 PDG', admin: 'Administrateur', gestionnaire: 'Gestionnaire', agent: 'Agent', user: 'Utilisateur' };
function can(k) { return ME && (ME.role === 'pdg' || (ME.perms || []).includes(k)); }

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
    <div style="position:relative">
      <input type="password" id="l-pass" style="width:100%;padding-right:44px">
      <button type="button" onclick="var i=document.getElementById('l-pass');i.type=i.type==='password'?'text':'password';this.textContent=i.type==='password'?'👁️':'🙈'"
        style="position:absolute;right:2px;top:50%;transform:translateY(-50%);background:none;border:none;font-size:18px;padding:6px 10px;cursor:pointer">👁️</button>
    </div>
    <button class="btn" id="l-btn">Se connecter</button>
  </div></div>`;
  document.getElementById('l-btn').onclick = async e => {
    e.target.disabled = true;
    try {
      const r = await api('/auth/login', { method: 'POST', body: { phone: document.getElementById('l-phone').value, password: document.getElementById('l-pass').value } });
      if (!['pdg', 'admin', 'gestionnaire', 'agent'].includes(r.user.role)) { toast('Ce compte ne fait pas partie de l\u2019équipe d\u2019administration.', 'err'); e.target.disabled = false; return; }
      TOKEN = r.token; localStorage.setItem('ks_admin_token', TOKEN);
      ME = r.user;
      if (r.user.must_change_password) toast('⚠️ Pensez à changer votre mot de passe temporaire (menu « Mon compte » de l\u2019application).', 'warn');
      render();
    } catch (err) { toast(err.message, 'err'); e.target.disabled = false; }
  };
  document.getElementById('l-pass').addEventListener('keydown', ev => { if (ev.key === 'Enter') document.getElementById('l-btn').click(); });
}

/* ---------- Structure ---------- */
// [vue, libellé, badge compteur, permission requise] — null = visible pour toute l'équipe
const MENU = [
  ['TABLEAU DE BORD', [['dashboard', '📊 Vue d\u2019ensemble', null, null]]],
  ['UTILISATEURS', [['users', '👥 Tous les comptes', null, 'comptes'], ['pros', '✅ Validations pro', 'pros_pending', 'pros']]],
  ['SERVICES', [['catalog', '🗂️ Services & catégories', null, 'catalogue'], ['questions', '❓ Questions dynamiques', null, 'questions']]],
  ['MISSIONS', [['missions', '🧰 Demandes & missions', null, 'missions'], ['payments', '💰 Paiements & commissions', null, 'paiements']]],
  ['COMMUNICATION', [['ads', '📣 Publicités & infos', null, 'communication'], ['broadcast', '📨 Message système', null, 'communication']]],
  ['SÉCURITÉ', [['rules', '📜 Règles & conditions', null, 'securite'], ['reports', '⚠️ Signalements', 'signalements', 'securite'], ['urgences', '🚨 Urgences', 'urgences', 'securite'], ['files', '🗄️ Gestion des fichiers', null, 'securite']]],
  ['CONTENU', [['avis', '📢 Avis de recherche', null, 'contenu'], ['jobs', '💼 Je cherche un job', null, 'contenu'], ['ecole', '🏫 École & famille', null, 'contenu'], ['games', '🎮 Quiz / Flip Fizz / Kdo', null, 'contenu']]],
  ['DIRECTION', [['staff', '👑 Équipe & permissions', null, 'PDG'], ['maintenance', '🛠 Maintenance / suspension', null, 'PDG'], ['journal', '🧾 Journal des actions', null, 'journal']]],
  ['CONFIGURATION', [['settings', '⚙️ Paramètres généraux', null, 'parametres']]],
];
function menuVisible(perm) { return !perm || (perm === 'PDG' ? ME && ME.role === 'pdg' : can(perm)); }

function shell(content) {
  root.innerHTML = `
  <div class="layout">
    <div class="side" id="side">
      <div class="logo">Klean-Services CI<br><span class="small" style="color:#6d9c94;font-weight:600">Administration</span>
      ${ME ? `<br><span class="small" style="color:#9fc8c0">${esc(ME.name || '')} — ${ROLE_LB[ME.role] || ME.role}</span>` : ''}</div>
      ${MENU.map(([grp, items]) => {
        const vis = items.filter(it => menuVisible(it[3]));
        return vis.length ? `<div class="grp">${grp}</div>` + vis.map(([id, lb, cnt]) =>
          `<button class="${VIEW === id ? 'on' : ''}" onclick="go('${id}')">${lb}${cnt && STATS[cnt] ? `<span class="cnt">${STATS[cnt]}</span>` : ''}</button>`).join('') : '';
      }).join('')}
      <div class="grp"></div>
      <button onclick="location.href='/'">📱 Ouvrir l'application</button>
      <button onclick="adminLogout()">🚪 Se déconnecter</button>
    </div>
    <div class="main">
      <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center">
        <input id="gs-q" style="flex:1;max-width:620px;padding:10px 14px;border:1.5px solid #cfe0dd;border-radius:10px;font-size:14px"
          placeholder="🔎 Rechercher partout : nom, téléphone, e-mail, code KP, service, mission, paiement…" value="${esc(sessionStorage.getItem('adm_gs') || '')}">
        <button class="btn sm" onclick="A.gsGo()">Rechercher</button>
      </div>
      ${content}
    </div>
  </div>
  <button class="menu-toggle" onclick="document.getElementById('side').classList.toggle('open')">☰</button>`;
  const gq = document.getElementById('gs-q');
  if (gq) gq.addEventListener('keydown', e => { if (e.key === 'Enter') A.gsGo(); });
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
function userStatusPill(u) {
  if (u.blocked) return '<span class="pill bad">🚫 Bloqué</span>';
  if (u.suspended) return '<span class="pill bad">Suspendu</span>';
  if (u.disabled_until && u.disabled_until > new Date().toISOString().slice(0, 19).replace('T', ' ')) return `<span class="pill warn">⏸ Désactivé jusqu\u2019au ${esc(u.disabled_until.slice(0, 16))}</span>`;
  if (u.pro_status === 'approved') return '<span class="pill ok">Client • Pro</span>';
  if (u.pro_status === 'pending') return '<span class="pill warn">Pro en attente</span>';
  return '<span class="pill info">Client</span>';
}
views.users = async () => {
  const f = sessionStorage.getItem('adm_uf') || 'all';
  const tri = sessionStorage.getItem('adm_us') || 'date';
  const list = await api('/admin/users?filter=' + f + '&sort=' + tri);
  shell(`<h1>👥 Utilisateurs</h1>
  <div class="tabs">${[['all', 'Tous'], ['clients', 'Clients'], ['pros', 'Professionnels'], ['pending', 'Pro en attente'], ['suspended', 'Suspendus / bloqués'], ['verified', 'Vérifiés'], ['incomplete', 'Profils à compléter']]
    .map(([id, lb]) => `<button class="${f === id ? 'on' : ''}" onclick="sessionStorage.setItem('adm_uf','${id}');render()">${lb}</button>`).join('')}
    <span style="margin-left:auto;display:flex;align-items:center;gap:6px">
      <label class="small muted" style="margin:0">Classer :</label>
      <select onchange="sessionStorage.setItem('adm_us', this.value);render()">
        <option value="date" ${tri === 'date' ? 'selected' : ''}>📅 Date d'inscription (récents d'abord)</option>
        <option value="nom" ${tri === 'nom' ? 'selected' : ''}>🔤 Ordre alphabétique (A → Z)</option>
      </select>
      <button class="btn sm" onclick="A.userQuickCreate()">＋ Créer rapidement un compte</button>
    </span></div>
  <div class="panel"><table><tr><th>Nom</th><th>Téléphone</th><th>Code pro</th><th>Localisation</th><th>Statut</th><th>Inscrit le</th><th>Actions</th></tr>
  ${list.map(u => `<tr>
    <td><b>${esc(u.name)}</b> ${u.verified ? '✅' : ''}${u.profile_incomplete ? ' <span class="pill warn small">profil à compléter</span>' : ''}</td>
    <td>${esc(u.phone)}${u.email ? `<div class="small muted">${esc(u.email)}</div>` : ''}</td>
    <td class="small">${u.kp_code ? '<b>' + esc(u.kp_code) + '</b>' : '—'}</td>
    <td class="small">${esc(u.ville ? u.ville + (u.quartier ? ' / ' + u.quartier : '') : (u.address || '—'))}</td>
    <td>${userStatusPill(u)}</td>
    <td class="small">${fmtD(u.created_at)}</td>
    <td><button class="btn sm sec" onclick="A.userDetail(${u.id})">📋 Fiche</button></td></tr>`).join('')}
  ${!list.length ? '<tr><td colspan="7" class="muted">Aucun compte.</td></tr>' : ''}</table></div>`);
};

/* ---------- Validations professionnelles ---------- */
views.pros = async () => {
  const list = await api('/admin/pros/pending');
  let cond = null;
  try { cond = await api('/admin/settings'); } catch { } // visible seulement avec la permission « paramètres »
  shell(`<h1>✅ Validations professionnelles</h1>
  ${cond ? `<div class="panel">
    <b>⚙️ Conditions de validation</b>
    <div class="small muted" style="margin:4px 0 8px">Exiger un document justificatif pour pouvoir envoyer une demande professionnelle. Modifiable à tout moment.</div>
    <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><input type="checkbox" ${cond.pro_doc_particulier === '1' ? 'checked' : ''} onchange="A.proCond('pro_doc_particulier', this.checked)"> 👤 Document obligatoire pour les comptes <b>Particulier</b></label>
    <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" ${cond.pro_doc_entreprise === '1' ? 'checked' : ''} onchange="A.proCond('pro_doc_entreprise', this.checked)"> 🏢 Document obligatoire pour les comptes <b>Entreprise</b> (registre, pièce du responsable…)</label>
  </div>` : ''}
  ${list.length ? list.map(p => `<div class="panel">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div>
        <b style="font-size:16px">${esc(p.name)}</b> — ${esc(p.profession)}
        <span class="pill ${p.pro_type === 'entreprise' ? 'warn' : 'ok'}" style="margin-left:6px">${p.pro_type === 'entreprise' ? '🏢 Entreprise' : '👤 Particulier'}</span><br>
        ${p.pro_type === 'entreprise' ? `<span class="small"><b>Entreprise :</b> ${esc(p.company_name || '—')} • <b>RCCM :</b> ${esc(p.company_rccm || '—')} • <b>Équipe :</b> ${esc(p.company_size || '—')}</span><br>` : ''}
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

/* ---------- Grande recherche ---------- */
views.search = async () => {
  const q = sessionStorage.getItem('adm_gs') || '';
  const r = q.length >= 2 ? await api('/admin/search?q=' + encodeURIComponent(q)) : { groups: [] };
  shell(`<h1>🔎 Résultats pour « ${esc(q)} »</h1>
  ${q.length < 2 ? '<div class="panel muted">Tapez au moins 2 caractères dans la barre de recherche ci-dessus.</div>' : ''}
  ${r.groups.map(g => `<div class="panel">
    <b>${esc(g.titre)}</b>
    ${g.items.map(it => `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #eef4f3">
      <div><div>${esc(it.label)}</div><div class="small muted">${esc(it.sub || '')}</div></div>
      <button class="btn sm sec" onclick="A.gsOpen('${g.type}',${it.id})">Ouvrir ›</button>
    </div>`).join('')}
  </div>`).join('')}
  ${q.length >= 2 && !r.groups.length ? '<div class="panel muted">Aucun résultat. Essayez un nom, un téléphone, un code KP (ex : KP123456), un code mission ou un service.</div>' : ''}`);
};

/* ---------- Maintenance / suspension des activités (PDG) ---------- */
let MAINTD = null;
views.maintenance = async () => {
  MAINTD = await api('/admin/maintenance');
  const { config: m, scopes, fonctions, actif } = MAINTD;
  shell(`<h1>🛠 Maintenance / suspension des activités</h1>
  <div class="panel" style="border-left:5px solid ${actif ? '#c0392b' : '#27ae60'}">
    <b>État actuel : ${actif ? '🔴 MAINTENANCE ACTIVE' : '🟢 Plateforme en fonctionnement normal'}</b>
    ${actif ? `<div class="small" style="margin-top:6px">
      Portée : <b>${esc(scopes[m.scope])}</b>${m.scope === 'E' ? '<br>Fonctions suspendues : ' + (m.functions || []).map(f => esc(fonctions[f])).join(', ') : ''}<br>
      ${m.until ? 'Jusqu\u2019au : <b>' + esc(m.until.replace('T', ' ')) + '</b> (fin automatique)<br>' : 'Durée : indéterminée (jusqu\u2019à désactivation manuelle)<br>'}
      Justification : ${esc(m.reason || '—')}<br>
      Activée le ${esc(m.activated_at || '')} par ${esc(m.activated_by || '')}<br>
      Message affiché aux utilisateurs : « ${esc(m.message || 'Klean-Services est temporairement en maintenance. Nous revenons très vite. Merci de votre patience.')} »</div>
      <button class="btn" style="margin-top:12px" onclick="A.maintOff()">🟢 Désactiver la maintenance maintenant</button>` : ''}
  </div>
  <div class="panel">
    <b>${actif ? 'Modifier la maintenance' : 'Activer une maintenance'}</b>
    <div class="small muted" style="margin:6px 0 12px">Votre compte PDG reste toujours accessible, quelle que soit la portée choisie. Les administrateurs et gestionnaires restent soumis à vos permissions.</div>
    <label class="small muted">Portée de la suspension</label>
    ${Object.entries(scopes).map(([k, lb]) => `<label style="display:flex;gap:8px;align-items:center;padding:4px 0;font-size:13.5px">
      <input type="radio" name="mt-scope" value="${k}" ${(m.scope || 'F') === k ? 'checked' : ''} onchange="document.getElementById('mt-fns').style.display=this.value==='E'?'block':'none'">
      <b>${k}.</b> ${esc(lb)}</label>`).join('')}
    <div id="mt-fns" style="display:${(m.scope || 'F') === 'E' ? 'block' : 'none'};margin:8px 0 0 24px;border:1px solid #e3edeb;border-radius:8px;padding:8px">
      ${Object.entries(fonctions).map(([k, lb]) => `<label style="display:flex;gap:8px;align-items:center;padding:3px 0;font-size:13px">
        <input type="checkbox" class="mt-fn" value="${k}" ${(m.functions || []).includes(k) ? 'checked' : ''}> ${esc(lb)}</label>`).join('')}
    </div>
    <div class="frow" style="margin-top:12px">
      <div><label class="small muted">Fin automatique (facultatif — vide = jusqu\u2019à désactivation manuelle)</label>
      <input type="datetime-local" id="mt-until" value="${esc(m.until || '')}"></div>
    </div>
    <label class="small muted" style="margin-top:10px;display:block">Justification (obligatoire — enregistrée dans le journal)</label>
    <input id="mt-reason" style="width:100%;margin-bottom:10px" value="${esc(m.reason || '')}" placeholder="Ex : mise à jour du système de paiement">
    <label class="small muted">Message affiché aux utilisateurs (facultatif)</label>
    <input id="mt-msg" style="width:100%;margin-bottom:12px" value="${esc(m.message || '')}" placeholder="Klean-Services est temporairement en maintenance. Nous revenons très vite. Merci de votre patience.">
    <button class="btn warn" onclick="A.maintOn()">🔴 ${actif ? 'Mettre à jour la maintenance' : 'Activer la maintenance'}</button>
  </div>`);
};

/* ---------- Équipe & permissions (réservé au PDG) ---------- */
let STAFFD = null; // dernières données /admin/staff
views.staff = async () => {
  STAFFD = await api('/admin/staff');
  const { staff, perm_keys, role_labels } = STAFFD;
  shell(`<h1>👑 Équipe & permissions</h1>
  <div class="panel small muted">Hiérarchie : <b>PDG → Administrateurs → Gestionnaires → Agents → Utilisateurs</b>.
  Vous seul (PDG) pouvez créer des comptes d\u2019équipe, modifier les rôles et activer/désactiver chaque permission.
  Un membre de l\u2019équipe ne voit dans son tableau de bord que les sections autorisées.</div>
  <div class="panel">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <b>Membres de l\u2019équipe (${staff.length})</b>
      <button class="btn sm" onclick="A.staffCreate()">＋ Ajouter un membre</button>
    </div>
    <table style="margin-top:10px"><tr><th>Nom</th><th>Identifiant</th><th>Rôle</th><th>Permissions</th><th>État</th><th>Actions</th></tr>
    ${staff.map(s => `<tr>
      <td><b>${esc(s.name)}</b></td><td class="small">${esc(s.phone)}</td>
      <td>${s.role === 'pdg' ? '<b>👑 PDG</b>' : esc(role_labels[s.role] || s.role)}</td>
      <td class="small">${s.role === 'pdg' ? 'Toutes' : s.perms_effectives.length + ' / ' + Object.keys(perm_keys).length}</td>
      <td>${s.blocked ? '<span class="pill bad">Bloqué</span>' : s.suspended ? '<span class="pill bad">Suspendu</span>' : '<span class="pill ok">Actif</span>'}</td>
      <td style="white-space:nowrap">${s.role === 'pdg' ? '<span class="small muted">—</span>' : `
        <button class="btn sm sec" onclick="A.staffEdit(${s.id})">⚙️ Rôle & permissions</button>
        <button class="btn sm ${s.suspended ? '' : 'warn'}" onclick="A.staffToggle(${s.id},'suspended',${s.suspended ? 0 : 1})">${s.suspended ? 'Réactiver' : 'Suspendre'}</button>
        <button class="btn sm sec" onclick="A.staffReset(${s.id})">🔑 Réinitialiser</button>
        <button class="btn sm warn" onclick="A.staffDel(${s.id})">🗑️</button>`}</td></tr>`).join('')}</table>
  </div>`);
};

/* ---------- Journal des actions ---------- */
views.journal = async () => {
  const q = sessionStorage.getItem('adm_j_q') || '';
  const rows = await api('/admin/journal?q=' + encodeURIComponent(q));
  shell(`<h1>🧾 Journal des actions</h1>
  <div class="panel small muted">Toutes les actions sensibles de l\u2019équipe sont enregistrées automatiquement : qui, quoi, quand, sur quel compte ou élément, et pour quel motif.</div>
  <div class="panel">
    <div class="frow" style="margin-bottom:10px">
      <div style="flex:1"><input id="j-q" style="width:100%" placeholder="🔎 Rechercher : nom d\u2019admin, action, compte, motif…" value="${esc(q)}"></div>
      <button class="btn sm" onclick="sessionStorage.setItem('adm_j_q',document.getElementById('j-q').value);render()">Rechercher</button>
      ${q ? `<button class="btn sm sec" onclick="sessionStorage.setItem('adm_j_q','');render()">✕</button>` : ''}
    </div>
    <table><tr><th>Date</th><th>Membre</th><th>Action</th><th>Détails</th><th>Motif</th></tr>
    ${rows.map(l => `<tr>
      <td class="small" style="white-space:nowrap">${fmtD(l.created_at)}</td>
      <td class="small"><b>${esc(l.admin_name)}</b><br>${esc(ROLE_LB[l.admin_role] || l.admin_role)}</td>
      <td><b>${esc(l.action)}</b>${l.target_id ? `<div class="small muted">${esc(l.target_type || '')} #${l.target_id}${l.target_name ? ' — ' + esc(l.target_name) : ''}</div>` : ''}</td>
      <td class="small muted" style="max-width:340px;word-break:break-word">${esc(l.details || '')}</td>
      <td class="small">${esc(l.reason || '—')}</td></tr>`).join('')}
    ${!rows.length ? '<tr><td colspan="5" class="muted">Aucune action enregistrée' + (q ? ' pour cette recherche' : '') + '.</td></tr>' : ''}</table>
  </div>`);
};

/* ---------- Catalogue services ---------- */
let CATD = null; // données du catalogue (partagées avec les actions A.*)
views.catalog = async () => {
  const tab = sessionStorage.getItem('adm_cat_tab') || 'cat';
  if (tab === 'villes') return views._villes();
  if (tab === 'pop') return views._populaires();
  const d = CATD = await api('/admin/catalog');
  const q = (sessionStorage.getItem('adm_cat_q') || '').toLowerCase();
  let sel = parseInt(sessionStorage.getItem('adm_cat_sel') || 0, 10);
  if (!d.categories.some(c => c.id === sel)) sel = d.categories[0]?.id || 0;

  const nTaches = {}; d.taches.forEach(t => nTaches[t.service_id] = (nTaches[t.service_id] || 0) + 1);
  const svcRow = (s, path) => `<tr>
    <td><b>${esc(s.name)}</b>${path ? `<div class="small muted">${esc(path)}</div>` : ''}
      <div class="small" style="color:#111;font-weight:700">${s.price_show && s.price_from ? esc(s.price_prefix || 'Dès') + ' ' + Number(s.price_from).toLocaleString('fr-FR') + ' FCFA' : '<span class="muted" style="font-weight:400">prix masqué</span>'}</div>
      <div class="small muted">${s.popular ? '⭐ populaire ' : ''}${s.seasonal ? '📅 saisonnier ' : ''}${s.cities.length ? '📍 ' + s.cities.map(esc).join(', ') : ''}</div></td>
    <td class="small muted" style="max-width:220px">${esc(s.keywords)}</td>
    <td><button class="btn sm sec" onclick="A.taches(${s.id})">📝 Tâches (${nTaches[s.id] || 0})</button></td>
    <td>${s.active ? '<span class="pill ok">Actif</span>' : '<span class="pill off">Inactif</span>'}</td>
    <td style="white-space:nowrap"><button class="btn sm sec" onclick="A.svcForm(${s.id})">Modifier</button>
      <button class="btn sm ${s.active ? 'warn' : ''}" onclick="A.toggleSvc(${s.id},${s.active ? 0 : 1})">${s.active ? 'Désactiver' : 'Activer'}</button>
      <button class="btn sm warn" onclick="A.svcDel(${s.id})">🗑️</button></td></tr>`;

  // Recherche : résultats à plat avec leur chemin complet
  let body;
  if (q) {
    const hit = x => x.toLowerCase().includes(q);
    const results = d.services.filter(s => {
      const cat = d.categories.find(c => c.id === s.category_id) || {};
      return hit(s.name) || hit(s.keywords || '') || hit(cat.name || '') ||
        d.taches.some(t => t.service_id === s.id && hit(t.name));
    });
    body = `<div class="panel"><h2 style="margin-top:0">🔎 ${results.length} service(s) trouvé(s)</h2>
      <table><tr><th>Service</th><th>Mots-clés</th><th>Tâches</th><th>État</th><th>Actions</th></tr>
      ${results.map(s => {
        const cat = d.categories.find(c => c.id === s.category_id) || {};
        return svcRow(s, `${cat.icon || ''} ${cat.name || ''}`);
      }).join('')}</table></div>`;
  } else {
    const c = d.categories.find(x => x.id === sel);
    body = !c ? '' : `<div class="panel">
      <h2 style="margin-top:0">${esc(c.icon || '')} ${esc(c.name)} ${c.active ? '' : '<span class="pill off">Inactive</span>'}</h2>
      <div class="frow">
        <button class="btn sm sec" onclick="A.metForm(${c.id})">✏️ Renommer / icône</button>
        <button class="btn sm ${c.active ? 'warn' : ''}" onclick="A.toggleCat(${c.id},${c.active ? 0 : 1})">${c.active ? 'Désactiver la catégorie' : 'Activer la catégorie'}</button>
        <button class="btn sm warn" onclick="A.metDel(${c.id})">🗑️ Supprimer</button>
        <span style="flex:1"></span>
        <button class="btn" onclick="A.svcForm(0,${c.id})">＋ Nouveau service</button>
      </div>
      <table><tr><th>Service</th><th>Mots-clés</th><th>Tâches</th><th>État</th><th>Actions</th></tr>
      ${d.services.filter(s => s.category_id === c.id).map(s => svcRow(s, '')).join('') || '<tr><td colspan="5" class="muted small">Aucun service — ajoutez-en un.</td></tr>'}
      </table>
    </div>`;
  }

  shell(`<h1>🗂️ Services & catégories</h1>
  <div class="tabs">
    <button class="on">🗂️ Catalogue</button>
    <button onclick="sessionStorage.setItem('adm_cat_tab','pop');render()">⭐ Services populaires</button>
    <button onclick="sessionStorage.setItem('adm_cat_tab','villes');render()">🏙️ Villes (${'villes' in STATS ? STATS.villes : '…'})</button>
  </div>
  <div class="frow">
    <div style="flex:1;min-width:220px"><label>🔎 Rechercher dans le catalogue (catégorie, service, tâche, mot-clé)</label>
      <input id="cat-q" style="width:100%" value="${esc(sessionStorage.getItem('adm_cat_q') || '')}" placeholder="Ex : fuite, tresses, climatiseur…"
        oninput="sessionStorage.setItem('adm_cat_q',this.value)" onkeydown="if(event.key==='Enter')render()">
    </div>
    <button class="btn sec" onclick="render()">Rechercher</button>
    ${q ? `<button class="btn sec" onclick="sessionStorage.setItem('adm_cat_q','');render()">✕ Effacer</button>` : ''}
    <span style="flex:1"></span>
    <div><label>＋ Nouvelle catégorie</label><input id="c-name" placeholder="Nom de la catégorie"></div>
    <div><label>Icône</label><input id="c-icon" style="width:64px" placeholder="🔹"></div>
    <button class="btn" onclick="A.addCat()">Créer</button>
  </div>
  ${q ? '' : `<div class="panel" style="padding:10px"><div style="display:flex;gap:6px;flex-wrap:wrap">
    ${d.categories.map((c, i) => `<span style="display:inline-flex;align-items:center;gap:2px">
      <button class="btn sm ${c.id === sel ? '' : 'sec'}" style="${c.active ? '' : 'opacity:.5'}" onclick="sessionStorage.setItem('adm_cat_sel',${c.id});render()">${esc(c.icon || '')} ${esc(c.name)}</button>
      ${c.id === sel ? `<button class="btn sm sec" title="Monter" ${i === 0 ? 'disabled' : ''} onclick="A.metMove(${c.id},${i})">↑</button><button class="btn sm sec" title="Descendre" ${i === d.categories.length - 1 ? 'disabled' : ''} onclick="A.metMove(${c.id},${i},1)">↓</button>` : ''}
    </span>`).join('')}
  </div></div>`}
  ${body}`);
  const qi = document.getElementById('cat-q');
  if (q && qi) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
};

/* ---------- Services populaires (sélection et ordre de l'accueil) ---------- */
views._populaires = async () => {
  const d = CATD = await api('/admin/catalog');
  const pops = d.services.filter(s => s.popular)
    .sort((a, b) => (a.popular_sort ?? 999) - (b.popular_sort ?? 999) || a.sort - b.sort || a.id - b.id);
  const catOf = s => d.categories.find(c => c.id === s.category_id) || {};
  const options = d.categories.map(c => {
    const svcs = d.services.filter(s => s.category_id === c.id && !s.popular && s.active);
    return svcs.length ? `<optgroup label="${esc((c.icon || '') + ' ' + c.name)}">${svcs.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</optgroup>` : '';
  }).join('');
  shell(`<h1>🗂️ Services & catégories</h1>
  <div class="tabs">
    <button onclick="sessionStorage.setItem('adm_cat_tab','cat');render()">🗂️ Catalogue</button>
    <button class="on">⭐ Services populaires</button>
    <button onclick="sessionStorage.setItem('adm_cat_tab','villes');render()">🏙️ Villes (${'villes' in STATS ? STATS.villes : '…'})</button>
  </div>
  <div class="panel">
    <p class="small muted">Les services populaires apparaissent en haut de l'accueil de l'application, dans l'ordre ci-dessous.
    Ce sont les mêmes services que dans le catalogue — une sélection, jamais des doublons. Tout changement est visible immédiatement sur l'accueil.</p>
    <div class="frow">
      <div style="min-width:280px"><label>＋ Ajouter un service aux populaires</label>
        <select id="pop-add" style="width:100%">${options || '<option value="">(tous les services actifs sont déjà populaires)</option>'}</select></div>
      <button class="btn" onclick="A.popAdd()">Ajouter</button>
    </div>
    <table><tr><th style="width:52px">Ordre</th><th>Service</th><th>Catégorie</th><th>État</th><th>Actions</th></tr>
    ${pops.map((s, i) => { const c = catOf(s); return `<tr>
      <td><b>${i + 1}</b></td>
      <td><b>${esc(s.name)}</b><div class="small" style="color:#111;font-weight:700">${s.price_show && s.price_from ? esc(s.price_prefix || 'Dès') + ' ' + Number(s.price_from).toLocaleString('fr-FR') + ' FCFA' : ''}</div></td>
      <td>${esc((c.icon || '') + ' ' + (c.name || ''))}</td>
      <td>${s.active ? '<span class="pill ok">Actif</span>' : '<span class="pill off">Inactif</span>'}</td>
      <td style="white-space:nowrap">
        <button class="btn sm sec" title="Monter" ${i === 0 ? 'disabled' : ''} onclick="A.popMove(${s.id},-1)">↑</button>
        <button class="btn sm sec" title="Descendre" ${i === pops.length - 1 ? 'disabled' : ''} onclick="A.popMove(${s.id},1)">↓</button>
        <button class="btn sm warn" onclick="A.popRemove(${s.id})">✕ Retirer</button></td></tr>`; }).join('') || '<tr><td colspan="5" class="muted small">Aucun service populaire — ajoutez-en un ci-dessus.</td></tr>'}
    </table>
  </div>`);
};

/* ---------- Villes ---------- */
views._villes = async () => {
  const list = await api('/admin/villes');
  const q = (sessionStorage.getItem('adm_v_q') || '').toLowerCase();
  const show = q ? list.filter(v => v.name.toLowerCase().includes(q)) : list;
  shell(`<h1>🗂️ Services & catégories</h1>
  <div class="tabs">
    <button onclick="sessionStorage.setItem('adm_cat_tab','cat');render()">🗂️ Catalogue</button>
    <button onclick="sessionStorage.setItem('adm_cat_tab','pop');render()">⭐ Services populaires</button>
    <button class="on">🏙️ Villes (${list.length})</button>
  </div>
  <div class="frow">
    <div><label>🔎 Rechercher une ville</label><input value="${esc(sessionStorage.getItem('adm_v_q') || '')}" oninput="sessionStorage.setItem('adm_v_q',this.value)" onkeydown="if(event.key==='Enter')render()"></div>
    <button class="btn sec" onclick="render()">Rechercher</button>
    <span style="flex:1"></span>
    <div><label>＋ Ajouter une ville / localité</label><input id="v-name" placeholder="Nom de la ville"></div>
    <button class="btn" onclick="A.villeAdd()">Ajouter</button>
  </div>
  <div class="panel"><table><tr><th>Ville</th><th>État</th><th>Actions</th></tr>
  ${show.map(v => `<tr><td><b>${esc(v.name)}</b></td>
    <td>${v.active ? '<span class="pill ok">Active</span>' : '<span class="pill off">Inactive</span>'}</td>
    <td><button class="btn sm sec" onclick="A.villeToggle(${v.id},${v.active ? 0 : 1})">${v.active ? 'Désactiver' : 'Activer'}</button>
    <button class="btn sm warn" onclick="A.villeDel(${v.id})">🗑️</button></td></tr>`).join('')}
  ${!show.length ? '<tr><td colspan="3" class="muted">Aucune ville trouvée.</td></tr>' : ''}</table></div>`);
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
    <td class="small">${esc(m.code)}</td><td><b>${esc(m.service_name)}</b>${m.tache ? `<div class="small muted">🛠️ ${esc(m.tache)}</div>` : ''}${m.urgence ? ' 🔥' : ''}</td>
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
  <div class="panel"><table><tr><th>Type</th><th>Titre</th><th>Contenu</th><th>Emplacement</th><th>👁️ Vues</th><th>État</th><th>Actions</th></tr>
  ${list.map(a => `<tr><td>${a.type}</td><td><b>${esc(a.title || '')}</b></td>
    <td class="small">${esc((a.content || '').slice(0, 60))} ${a.file ? `<a href="${esc(a.file)}" target="_blank">📎</a>` : ''}</td>
    <td>${a.placement}</td><td><b>${Number(a.views || 0).toLocaleString('fr-FR')}</b></td><td>${a.active ? '<span class="pill ok">Active</span>' : '<span class="pill off">Inactive</span>'}</td>
    <td><button class="btn sm sec" onclick="A.toggleAd(${a.id},${a.active ? 0 : 1})">${a.active ? 'Désactiver' : 'Activer'}</button>
    <button class="btn sm warn" onclick="A.delAd(${a.id})">🗑️</button></td></tr>`).join('')}
  ${!list.length ? '<tr><td colspan="7" class="muted">Aucune publicité.</td></tr>' : ''}</table></div>`);
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
  const sessions = await api('/admin/quiz-sessions');
  let gvues = { quiz: 0, flipfizz: 0, kdo: 0 };
  try { gvues = await api('/admin/game-plays/vues'); } catch { }
  const enCours = sessions.find(x => x.status === 'en_cours');
  const stLbl = { brouillon: '<span class="pill">Brouillon</span>', en_cours: '<span class="pill warn">🔴 EN COURS</span>', terminee: '<span class="pill ok">Terminée</span>' };
  shell(`<h1>🎮 Quiz / Flip Fizz / Kdo</h1>
  <div class="panel">
    <h2 style="margin-top:0">Activation (visibles sur l'accueil uniquement si activés)</h2>
    <div class="frow">
      ${[['quiz_enabled', '🧠 Quiz'], ['flipfizz_enabled', '🎲 Flip Fizz'], ['kdo_enabled', '🎁 Kdo']].map(([k, lb]) =>
        `<button class="btn ${s[k] === '1' ? '' : 'sec'}" onclick="A.toggleSetting('${k}',${s[k] === '1' ? "'0'" : "'1'"})">${lb} : ${s[k] === '1' ? 'Activé ✅' : 'Désactivé'}</button>`).join('')}
    </div>
    <div class="small muted" style="margin-top:8px">👁️ Vues sur l'accueil — 🧠 Quiz : <b>${Number(gvues.quiz || 0).toLocaleString('fr-FR')}</b> • 🎲 Flip Fizz : <b>${Number(gvues.flipfizz || 0).toLocaleString('fr-FR')}</b> • 🎁 Kdo : <b>${Number(gvues.kdo || 0).toLocaleString('fr-FR')}</b></div>
    <div class="frow" style="margin-top:10px;align-items:center">
      <label style="margin:0"><b>👥 Qui peut jouer au quiz :</b></label>
      <select onchange="A.toggleSetting('quiz_audience', this.value)">
        ${[['tous', 'Tout le monde (tous les comptes)'], ['clients', 'Clients uniquement'], ['clients_pros', 'Clients et professionnels'], ['clients_servis', 'Clients ayant déjà bénéficié d\u2019un service']].map(([v, lb]) =>
          `<option value="${v}" ${(s.quiz_audience || 'tous') === v ? 'selected' : ''}>${lb}</option>`).join('')}
      </select>
      <span class="small muted">La désactivation totale se fait avec le bouton 🧠 Quiz ci-dessus.</span>
    </div></div>

  <div class="panel"><h2 style="margin-top:0">🏆 Quiz concours (sessions animées)</h2>
    <div class="small muted" style="margin-bottom:10px">Créez une session, lancez-la, puis arrêtez-la pour désigner les gagnants. Les questions sont tirées au hasard parmi les questions actives ci-dessous au moment du lancement.</div>
    <div class="frow" style="align-items:flex-end;flex-wrap:wrap">
      <div><label>Titre</label><input id="qs-title" placeholder="Quiz du samedi"></div>
      <div><label>Nb questions</label><input type="number" id="qs-nbq" value="5" min="1" max="50" style="width:80px"></div>
      <div><label>Temps / question</label><select id="qs-time">
        ${[10, 15, 20, 30, 60].map(t => `<option value="${t}" ${t === 20 ? 'selected' : ''}>${t} s</option>`).join('')}
        <option value="autre">Personnalisé…</option></select></div>
      <div><label>Intervalle entre 2 quiz</label><select id="qs-inter">
        ${[10, 15, 30, 60, 120].map(t => `<option value="${t}" ${t === 30 ? 'selected' : ''}>${t} s</option>`).join('')}
        <option value="autre">Personnalisé…</option></select></div>
      <div><label>Nb gagnants</label><input type="number" id="qs-nbw" value="1" min="1" max="100" style="width:80px"></div>
      <div><label>Désignation</label><select id="qs-mode">
        <option value="auto">Automatique (meilleurs scores)</option>
        <option value="admin">Par l'administration (parmi les finalistes)</option></select></div>
      <div><label style="display:flex;align-items:center;gap:6px;margin-top:18px" title="Seuls ceux qui trouvent la bonne réponse continuent ; les autres passent en mode spectateur"><input type="checkbox" id="qs-elim" checked> Progression : seuls les bons répondants continuent</label></div>
      <button class="btn" onclick="A.quizSessionAdd()">＋ Créer</button>
    </div>
    <table style="margin-top:10px"><tr><th>Titre</th><th>Statut</th><th>Réglages</th><th>Participants</th><th>Actions</th></tr>
    ${sessions.map(x => `<tr><td><b>${esc(x.title)}</b><br><span class="small muted">${fmtD(x.created_at)}</span></td>
      <td>${stLbl[x.status] || esc(x.status)}</td>
      <td class="small">${x.nb_questions} questions • ${x.time_per_q}s/question • pause ${x.interval_s == null ? 30 : x.interval_s}s<br>${x.elimination ? '👁️ Progression (spectateurs) • ' : ''}${x.nb_winners} gagnant(s) • désignation ${x.winner_mode === 'auto' ? 'auto' : 'admin'}</td>
      <td>${x.participants}${x.gagnants ? ` <span class="pill ok">🏆 ${x.gagnants}</span>` : ''}</td>
      <td>
        ${x.status === 'brouillon' ? `<button class="btn sm" onclick="A.quizLancer(${x.id})" ${enCours ? 'disabled title="Un quiz est déjà en cours"' : ''}>🚀 Lancer</button>
          <button class="btn sm warn" onclick="A.quizSessionDel(${x.id})">🗑️</button>` : ''}
        ${x.status === 'en_cours' ? `<button class="btn sm warn" onclick="A.quizArreter(${x.id})">⏹️ Arrêter</button>` : ''}
        ${x.status === 'terminee' ? `<button class="btn sm" onclick="A.quizRejouer(${x.id})">🔄 Rejouer</button>` : ''}
        ${x.status !== 'brouillon' ? `<button class="btn sm sec" onclick="A.quizSessionDetail(${x.id})">📋 Détails</button>` : ''}
      </td></tr>`).join('')}
    ${!sessions.length ? '<tr><td colspan="5" class="muted">Aucune session. Créez votre premier quiz concours ci-dessus.</td></tr>' : ''}</table></div>

  <div class="panel"><h2 style="margin-top:0">Questions du quiz (QCM — 4 réponses A, B, C, D)</h2>
    <div class="frow" style="flex-wrap:wrap;align-items:flex-end">
      <div style="flex:1;min-width:220px"><label>Question</label><input id="qz-q" style="width:100%"></div>
      ${['A', 'B', 'C', 'D'].map((L, i) => `<div><label>Réponse ${L}</label><input id="qz-opt${i}" style="width:130px"></div>`).join('')}
      <div><label>Bonne réponse</label><select id="qz-ans">${['A', 'B', 'C', 'D'].map((L, i) => `<option value="${i}">${L}</option>`).join('')}</select></div>
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
  ${ME && ME.role === 'pdg' ? `<div class="panel">
    <h2 style="margin-top:0">🔠 Taille du texte du tableau de bord <span class="pill info small">réservé PDG</span></h2>
    <div class="small muted" style="margin-bottom:8px">Taille par défaut appliquée à tout le tableau de bord pour toute l'équipe (14 à 26 px).</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      ${[14, 16, 18, 20, 22, 24, 26].map(f => `<button class="btn sm ${parseInt(s.admin_font_size || 16, 10) === f ? '' : 'sec'}" onclick="A.toggleSetting('admin_font_size','${f}')">${f}px${f === 16 ? ' (normal)' : ''}</button>`).join('')}
    </div>
  </div>` : ''}
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
      const tempDis = u.disabled_until && u.disabled_until > new Date().toISOString().slice(0, 19).replace('T', ' ');
      openModal(`<h3>${esc(u.name)} ${u.verified ? '✅' : ''}</h3>
        <div style="margin-bottom:8px">${userStatusPill(u)} ${u.must_change_password ? '<span class="pill warn">doit changer son mot de passe</span>' : ''} ${u.profile_incomplete ? '<span class="pill warn">profil à compléter</span>' : ''}</div>
        <p class="small">📞 ${esc(u.phone)} ${u.email ? '• ✉️ ' + esc(u.email) : ''}<br>
        ${u.kp_code ? `🪪 Code professionnel : <b>${esc(u.kp_code)}</b><br>` : ''}
        📍 ${esc(u.ville ? u.ville + (u.quartier ? ' / ' + u.quartier : '') : '')} ${esc(u.address || '')}<br>
        Inscrit le ${fmtD(u.created_at)} • ${u.missions} mission(s)<br>
        Règles acceptées : ${u.rules_accepted_at ? fmtD(u.rules_accepted_at) : 'Non'} • Règles pro : ${u.pro_rules_accepted_at ? fmtD(u.pro_rules_accepted_at) : '—'}</p>
        ${u.pro ? `<p class="small"><b>Profil pro :</b> ${u.pro.pro_type === 'entreprise' ? '🏢 Entreprise' : '👤 Particulier'} • ${esc(u.pro.profession)} — ${esc(u.pro.zone)} • Disponible : ${u.pro.available ? 'Oui 🟢' : 'Non ⚪'}<br>
        ${u.pro.pro_type === 'entreprise' ? `Entreprise : <b>${esc(u.pro.company_name || '—')}</b> • RCCM : ${esc(u.pro.company_rccm || '—')} • Équipe : ${esc(u.pro.company_size || '—')}<br>` : ''}
        Documents : ${u.pro.documents.length ? u.pro.documents.map(d => `<a href="${esc(d)}" target="_blank">📄</a>`).join(' ') : 'Aucun'}</p>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin:10px 0">
          <button class="btn sm sec" onclick="A.userEdit(${u.id})">✏️ Modifier</button>
          <button class="btn sm ${u.suspended ? '' : 'warn'}" onclick="A.suspend(${u.id},${u.suspended ? 0 : 1})">${u.suspended ? '▶️ Réactiver' : '⏸ Suspendre'}</button>
          <button class="btn sm ${u.blocked ? '' : 'warn'}" onclick="A.userBlock(${u.id},${u.blocked ? 0 : 1})">${u.blocked ? '🔓 Débloquer' : '🚫 Bloquer'}</button>
          ${tempDis ? `<button class="btn sm" onclick="A.userDisableTemp(${u.id},true)">▶️ Fin de désactivation</button>` : `<button class="btn sm sec" onclick="A.userDisableTemp(${u.id})">⏱ Désactiver temporairement</button>`}
          <button class="btn sm sec" onclick="A.verify(${u.id},${u.verified ? 0 : 1})">${u.verified ? 'Retirer ✓' : '✅ Vérifier'}</button>
          <button class="btn sm sec" onclick="A.userResetAccess(${u.id})">🔑 Réinitialiser l\u2019accès</button>
          <button class="btn sm sec" onclick="A.userForcePwd(${u.id})">🔒 Forcer un nouveau mot de passe</button>
          <button class="btn sm warn" onclick="A.userDelete(${u.id})">🗑️ Supprimer</button>
        </div>
        <div class="small muted" style="margin:4px 0 6px"><b>Historique des actions de l\u2019administration sur ce compte :</b></div>
        <div style="max-height:180px;overflow:auto;border:1px solid #e3edeb;border-radius:8px;padding:8px">
        ${u.history.length ? u.history.map(h => `<div class="small" style="padding:3px 0;border-bottom:1px solid #f0f5f4">
          <b>${esc(h.action)}</b> — ${esc(h.admin_name)} (${ROLE_LB[h.admin_role] || h.admin_role}) • ${fmtD(h.created_at)}${h.reason ? `<br>Motif : ${esc(h.reason)}` : ''}</div>`).join('')
        : '<span class="small muted">Aucune action enregistrée.</span>'}</div>
        <button class="btn sec" style="margin-top:12px" onclick="closeModal()">Fermer</button>`);
    } catch (e) { toast(e.message, 'err'); }
  },
  userQuickCreate() {
    openModal(`<h3>＋ Créer rapidement un compte</h3>
      <p class="small muted">Informations minimales. L\u2019utilisateur se connectera avec le mot de passe temporaire, devra en choisir un nouveau et compléter lui-même son profil. Aucune fausse information.</p>
      <label class="small muted">Nom complet</label><input id="qc-name" style="width:100%;margin-bottom:10px" placeholder="Ex : John Sery Michael">
      <label class="small muted">Téléphone</label><input id="qc-phone" style="width:100%;margin-bottom:10px" placeholder="Ex : 0700000000">
      <label class="small muted">E-mail (si disponible)</label><input id="qc-email" style="width:100%;margin-bottom:10px" placeholder="facultatif">
      <label class="small muted">Type de compte initial</label>
      <select id="qc-type" style="width:100%;margin-bottom:12px"><option value="client">Client</option><option value="pro">Futur professionnel (devra passer la validation normale)</option></select>
      <div><button class="btn" onclick="A._userQuickSave()">Créer le compte</button> <button class="btn sec" onclick="closeModal()">Annuler</button></div>`);
  },
  async _userQuickSave() {
    try {
      const r = await api('/admin/users', { method: 'POST', body: { name: document.getElementById('qc-name').value, phone: document.getElementById('qc-phone').value, email: document.getElementById('qc-email').value, type: document.getElementById('qc-type').value } });
      openModal(`<h3>✅ Compte créé</h3>
        <p>Communiquez ce mot de passe temporaire à l\u2019utilisateur (il devra en choisir un nouveau à sa première connexion) :</p>
        <div style="font-size:24px;font-weight:800;text-align:center;background:#eef7f5;border-radius:10px;padding:14px;letter-spacing:2px">${esc(r.temp_password)}</div>
        <p class="small muted">Ce mot de passe ne sera plus jamais affiché.</p>
        <button class="btn" onclick="closeModal();render()">Terminé</button>`);
    } catch (e) { toast(e.message, 'err'); }
  },
  async userEdit(id) {
    const u = await api('/admin/users/' + id);
    openModal(`<h3>✏️ Modifier le compte</h3>
      <label class="small muted">Nom</label><input id="ue-name" style="width:100%;margin-bottom:8px" value="${esc(u.name)}">
      <label class="small muted">Téléphone</label><input id="ue-phone" style="width:100%;margin-bottom:8px" value="${esc(u.phone)}">
      <label class="small muted">E-mail</label><input id="ue-email" style="width:100%;margin-bottom:8px" value="${esc(u.email || '')}">
      <div class="frow">
        <div><label class="small muted">Ville</label><input id="ue-ville" value="${esc(u.ville || '')}"></div>
        <div><label class="small muted">Quartier</label><input id="ue-quartier" value="${esc(u.quartier || '')}"></div>
      </div>
      <label class="small muted">Adresse</label><input id="ue-addr" style="width:100%;margin-bottom:12px" value="${esc(u.address || '')}">
      <div><button class="btn" onclick="A._userEditSave(${id})">Enregistrer</button> <button class="btn sec" onclick="A.userDetail(${id})">Annuler</button></div>`);
  },
  async _userEditSave(id) {
    try {
      await api('/admin/users/' + id, { method: 'PUT', body: {
        name: document.getElementById('ue-name').value, phone: document.getElementById('ue-phone').value,
        email: document.getElementById('ue-email').value, ville: document.getElementById('ue-ville').value,
        quartier: document.getElementById('ue-quartier').value, address: document.getElementById('ue-addr').value } });
      toast('Compte modifié ✓', 'ok'); A.userDetail(id); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async userBlock(id, v) {
    const reason = v ? prompt('Motif du blocage (enregistré dans le journal) :') : null;
    if (v && reason === null) return;
    try { await api(`/admin/users/${id}/block`, { method: 'POST', body: { blocked: v, reason } }); toast(v ? 'Compte bloqué.' : 'Compte débloqué.', 'ok'); A.userDetail(id); render(); } catch (e) { toast(e.message, 'err'); }
  },
  userDisableTemp(id, clear) {
    if (clear) return api(`/admin/users/${id}/disable-temp`, { method: 'POST', body: { until: null } }).then(() => { toast('Compte réactivé ✓', 'ok'); A.userDetail(id); render(); }).catch(e => toast(e.message, 'err'));
    openModal(`<h3>⏱ Désactiver temporairement</h3>
      <label class="small muted">Jusqu\u2019au</label><input type="datetime-local" id="dt-until" style="width:100%;margin-bottom:8px">
      <label class="small muted">Motif (journal)</label><input id="dt-reason" style="width:100%;margin-bottom:12px">
      <div><button class="btn warn" onclick="A._userDisableSave(${id})">Désactiver</button> <button class="btn sec" onclick="A.userDetail(${id})">Annuler</button></div>`);
  },
  async _userDisableSave(id) {
    const until = document.getElementById('dt-until').value;
    if (!until) return toast('Choisissez une date de fin.', 'err');
    try { await api(`/admin/users/${id}/disable-temp`, { method: 'POST', body: { until, reason: document.getElementById('dt-reason').value } }); toast('Compte désactivé temporairement.', 'ok'); A.userDetail(id); render(); } catch (e) { toast(e.message, 'err'); }
  },
  async userResetAccess(id) {
    if (!confirm('Réinitialiser l\u2019accès de ce compte ?\nUn mot de passe temporaire sera généré (l\u2019ancien mot de passe n\u2019est jamais visible).')) return;
    try {
      const r = await api(`/admin/users/${id}/reset-access`, { method: 'POST', body: {} });
      openModal(`<h3>🔑 Accès réinitialisé</h3>
        <p>Communiquez ce mot de passe temporaire à l\u2019utilisateur :</p>
        <div style="font-size:24px;font-weight:800;text-align:center;background:#eef7f5;border-radius:10px;padding:14px;letter-spacing:2px">${esc(r.temp_password)}</div>
        <p class="small muted">Il devra choisir un nouveau mot de passe à sa prochaine connexion. Ce mot de passe ne sera plus jamais affiché.</p>
        <button class="btn" onclick="closeModal()">Terminé</button>`);
    } catch (e) { toast(e.message, 'err'); }
  },
  async userForcePwd(id) {
    try { await api(`/admin/users/${id}/force-password`, { method: 'POST', body: {} }); toast('L\u2019utilisateur devra choisir un nouveau mot de passe à sa prochaine connexion.', 'ok'); A.userDetail(id); } catch (e) { toast(e.message, 'err'); }
  },
  async userDelete(id) {
    const reason = prompt('SUPPRESSION DÉFINITIVE — motif (enregistré dans le journal) :');
    if (reason === null) return;
    if (!confirm('Confirmer la suppression définitive de ce compte ? Cette action est irréversible.')) return;
    try { await api('/admin/users/' + id, { method: 'DELETE', body: { reason } }); closeModal(); toast('Compte supprimé.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); }
  },
  async suspend(id, v) {
    const reason = v ? prompt('Motif de la suspension (enregistré dans le journal) :') : null;
    if (v && reason === null) return;
    try { await api(`/admin/users/${id}/suspend`, { method: 'POST', body: { suspended: v, reason } }); toast(v ? 'Compte suspendu.' : 'Compte réactivé.', 'ok'); A.userDetail(id); render(); } catch (e) { toast(e.message, 'err'); }
  },
  async verify(id, v) { try { await api(`/admin/users/${id}/verify`, { method: 'POST', body: { verified: v } }); toast('Mis à jour ✓', 'ok'); A.userDetail(id); render(); } catch (e) { toast(e.message, 'err'); } },
  async proCond(key, on) {
    try { await api('/admin/settings', { method: 'PUT', body: { [key]: on ? '1' : '0' } }); toast('Condition mise à jour ✓', 'ok'); }
    catch (e) { toast(e.message, 'err'); render(); }
  },
  async approvePro(id) { try { await api(`/admin/pros/${id}/approve`, { method: 'POST' }); toast('Professionnel validé ✅ Il a été notifié.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  rejectPro(id) {
    openModal(`<h3>Refuser la demande</h3>
      <label class="small muted">Raison (communiquée à l'utilisateur)</label>
      <input id="rej-reason" style="width:100%;margin-bottom:12px" placeholder="Ex : Documents illisibles">
      <button class="btn warn" onclick="A._doReject(${id})">Refuser</button> <button class="btn sec" onclick="closeModal()">Annuler</button>`);
  },
  async _doReject(id) { try { await api(`/admin/pros/${id}/reject`, { method: 'POST', body: { reason: document.getElementById('rej-reason').value } }); closeModal(); toast('Demande refusée.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },

  async addCat() {
    const name = document.getElementById('c-name').value.trim();
    if (!name) return toast('Indiquez le nom de la catégorie.', 'err');
    try {
      const r = await api('/admin/categories', { method: 'POST', body: { name, icon: document.getElementById('c-icon').value } });
      sessionStorage.setItem('adm_cat_sel', r.id); sessionStorage.setItem('adm_cat_q', '');
      toast('Catégorie créée ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async toggleCat(id, v) { try { await api('/admin/categories/' + id, { method: 'PUT', body: { active: v } }); toast(v ? 'Catégorie activée ✓' : 'Catégorie désactivée (invisible dans l\u2019application).', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  metForm(id) {
    const c = CATD.categories.find(x => x.id === id);
    openModal(`<h3>Modifier le métier</h3>
      <label class="small muted">Nom</label><input id="em-name" style="width:100%;margin-bottom:10px" value="${esc(c.name)}">
      <label class="small muted">Icône (émoji)</label><input id="em-icon" style="width:90px;margin-bottom:12px" value="${esc(c.icon || '')}">
      <div><button class="btn" onclick="A._metSave(${id})">Enregistrer</button> <button class="btn sec" onclick="closeModal()">Annuler</button></div>`);
  },
  async _metSave(id) { try { await api('/admin/categories/' + id, { method: 'PUT', body: { name: document.getElementById('em-name').value, icon: document.getElementById('em-icon').value } }); closeModal(); toast('Catégorie modifiée ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async metDel(id) {
    if (!confirm('Supprimer cette catégorie, ses services et leurs tâches ?\n(Refusé automatiquement si des missions l\u2019utilisent — préférez « Désactiver ».)')) return;
    try { await api('/admin/categories/' + id, { method: 'DELETE' }); toast('Catégorie supprimée.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); }
  },
  async metMove(id, i, down) {
    const list = CATD.categories; const j = down ? i + 1 : i - 1;
    if (j < 0 || j >= list.length) return;
    try {
      await api('/admin/categories/' + id, { method: 'PUT', body: { sort: j } });
      await api('/admin/categories/' + list[j].id, { method: 'PUT', body: { sort: i } });
      // réécrit tous les rangs proprement
      const order = list.map(c => c.id); order.splice(i, 1); order.splice(j, 0, id);
      for (let k = 0; k < order.length; k++) await api('/admin/categories/' + order[k], { method: 'PUT', body: { sort: k } });
      render();
    } catch (e) { toast(e.message, 'err'); }
  },

  // Ordre et sélection des services populaires (accueil)
  _popIds() {
    return CATD.services.filter(s => s.popular)
      .sort((a, b) => (a.popular_sort ?? 999) - (b.popular_sort ?? 999) || a.sort - b.sort || a.id - b.id)
      .map(s => s.id);
  },
  async _popSave(ids) { try { await api('/admin/services-populaires/ordre', { method: 'PUT', body: { ids } }); toast('Services populaires mis à jour ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  popMove(id, dir) { const ids = A._popIds(); const i = ids.indexOf(id), j = i + dir; if (i < 0 || j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; A._popSave(ids); },
  popRemove(id) { A._popSave(A._popIds().filter(x => x !== id)); },
  popAdd() { const v = parseInt((document.getElementById('pop-add') || {}).value, 10); if (!v) return toast('Choisissez un service.', 'err'); const ids = A._popIds(); if (!ids.includes(v)) ids.push(v); A._popSave(ids); },

  // Formulaire service complet (création si id=0, sinon modification)
  svcForm(id, catId) {
    const s = id ? CATD.services.find(x => x.id === id) : { name: '', keywords: '', category_id: catId, popular: 0, seasonal: 0, cities: [] };
    openModal(`<h3>${id ? 'Modifier le service' : 'Nouveau service'}</h3>
      <label class="small muted">Nom du service</label><input id="es-name" style="width:100%;margin-bottom:10px" value="${esc(s.name)}">
      <label class="small muted">Mots-clés pour la recherche intelligente (séparés par des virgules)</label>
      <input id="es-kw" style="width:100%;margin-bottom:10px" value="${esc(s.keywords)}" placeholder="plombier,fuite,robinet…">
      <div class="frow">
        <div style="flex:1"><label>Catégorie</label><select id="es-cat" style="width:100%">${CATD.categories.map(c => `<option value="${c.id}" ${c.id === s.category_id ? 'selected' : ''}>${esc(c.icon || '')} ${esc(c.name)}</option>`).join('')}</select></div>
      </div>
      <div class="frow" style="align-items:flex-end">
        <div><label>💰 Prix de départ indicatif (FCFA)</label><input type="number" id="es-prix" min="0" step="500" style="width:130px" value="${s.price_from ?? ''}" placeholder="Ex : 10000"></div>
        <div><label>Texte affiché</label><select id="es-prix-pre">
          <option value="Dès" ${(s.price_prefix || 'Dès') === 'Dès' ? 'selected' : ''}>Dès</option>
          <option value="À partir de" ${s.price_prefix === 'À partir de' ? 'selected' : ''}>À partir de</option>
        </select></div>
        <label style="display:flex;align-items:center;gap:6px;font-size:13.5px;margin:0 0 8px"><input type="checkbox" id="es-prix-show" ${s.price_show === 0 ? '' : 'checked'}> Afficher le prix aux clients</label>
      </div>
      <div class="small muted" style="margin-bottom:10px">Prix de départ indicatif, jamais définitif : le montant final de la prestation dépend de la demande du client et de la proposition du professionnel.</div>
      <div class="frow">
        <label style="display:flex;align-items:center;gap:6px;font-size:13.5px;margin:0"><input type="checkbox" id="es-pop" ${s.popular ? 'checked' : ''}> ⭐ Populaire (affiché sur l'accueil)</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13.5px;margin:0"><input type="checkbox" id="es-sea" ${s.seasonal ? 'checked' : ''}> 📅 Saisonnier</label>
      </div>
      <label class="small muted">Villes où ce service est proposé (séparées par des virgules — <b>laisser vide = toutes les villes</b>)</label>
      <input id="es-cities" style="width:100%;margin-bottom:12px" value="${esc((s.cities || []).join(', '))}" placeholder="Ex : Bouaké, Abidjan">
      <div><button class="btn" onclick="A._svcSave(${id || 0})">Enregistrer</button> <button class="btn sec" onclick="closeModal()">Annuler</button></div>`);
  },
  async _svcSave(id) {
    const body = {
      name: document.getElementById('es-name').value.trim(),
      keywords: document.getElementById('es-kw').value,
      category_id: parseInt(document.getElementById('es-cat').value, 10),
      popular: document.getElementById('es-pop').checked ? 1 : 0,
      seasonal: document.getElementById('es-sea').checked ? 1 : 0,
      price_from: parseInt(document.getElementById('es-prix').value, 10) || 0,
      price_prefix: document.getElementById('es-prix-pre').value,
      price_show: document.getElementById('es-prix-show').checked ? 1 : 0,
      cities: document.getElementById('es-cities').value.split(',').map(x => x.trim()).filter(Boolean)
    };
    if (!body.name) return toast('Indiquez le nom du service.', 'err');
    try {
      if (id) await api('/admin/services/' + id, { method: 'PUT', body });
      else await api('/admin/services', { method: 'POST', body });
      closeModal(); toast(id ? 'Service modifié ✓' : 'Service créé ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async toggleSvc(id, v) { try { await api('/admin/services/' + id, { method: 'PUT', body: { active: v } }); render(); } catch (e) { toast(e.message, 'err'); } },
  async svcDel(id) {
    if (!confirm('Supprimer ce service et ses tâches ? (Refusé si des missions l\u2019utilisent.)')) return;
    try { await api('/admin/services/' + id, { method: 'DELETE' }); toast('Service supprimé.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); }
  },

  // Fenêtre de gestion des tâches d'un service
  async taches(serviceId) {
    try {
      CATD = await api('/admin/catalog');
      const s = CATD.services.find(x => x.id === serviceId);
      const list = CATD.taches.filter(t => t.service_id === serviceId).sort((a, b) => a.sort - b.sort || a.id - b.id);
      openModal(`<h3>📝 Tâches — ${esc(s.name)}</h3>
        <p class="small muted">Ces tâches sont proposées au client quand il choisit ce service. La tâche choisie est transmise au professionnel.</p>
        <table><tr><th>Tâche</th><th>État</th><th>Actions</th></tr>
        ${list.map(t => `<tr><td>${esc(t.name)}</td>
          <td>${t.active ? '<span class="pill ok">Active</span>' : '<span class="pill off">Inactive</span>'}</td>
          <td style="white-space:nowrap"><button class="btn sm sec" onclick="A.tacheEdit(${t.id})">✏️</button>
          <button class="btn sm sec" onclick="A.tacheToggle(${t.id},${t.active ? 0 : 1},${serviceId})">${t.active ? 'Désactiver' : 'Activer'}</button>
          <button class="btn sm warn" onclick="A.tacheDel(${t.id},${serviceId})">🗑️</button></td></tr>`).join('')}
        ${!list.length ? '<tr><td colspan="3" class="muted small">Aucune tâche.</td></tr>' : ''}</table>
        <div class="frow" style="margin-top:12px">
          <div style="flex:1"><input id="t-new" style="width:100%" placeholder="Nouvelle tâche (ex : Remplacement d\u2019un robinet)"></div>
          <button class="btn" onclick="A.tacheAdd(${serviceId})">＋ Ajouter</button>
        </div>
        <button class="btn sec" style="margin-top:10px" onclick="closeModal();render()">Fermer</button>`);
    } catch (e) { toast(e.message, 'err'); }
  },
  async tacheAdd(serviceId) {
    const name = document.getElementById('t-new').value.trim();
    if (!name) return toast('Écrivez le nom de la tâche.', 'err');
    try { await api('/admin/taches', { method: 'POST', body: { service_id: serviceId, name } }); toast('Tâche ajoutée ✓', 'ok'); A.taches(serviceId); } catch (e) { toast(e.message, 'err'); }
  },
  tacheEdit(id) {
    const t = CATD.taches.find(x => x.id === id);
    const nv = prompt('Nom de la tâche :', t.name);
    if (nv === null || !nv.trim()) return;
    api('/admin/taches/' + id, { method: 'PUT', body: { name: nv.trim() } }).then(() => { toast('Tâche modifiée ✓', 'ok'); A.taches(t.service_id); }).catch(e => toast(e.message, 'err'));
  },
  async tacheToggle(id, v, sid) { try { await api('/admin/taches/' + id, { method: 'PUT', body: { active: v } }); A.taches(sid); } catch (e) { toast(e.message, 'err'); } },
  async tacheDel(id, sid) { if (!confirm('Supprimer cette tâche ?')) return; try { await api('/admin/taches/' + id, { method: 'DELETE' }); A.taches(sid); } catch (e) { toast(e.message, 'err'); } },

  // Grande recherche
  gsGo() {
    const v = document.getElementById('gs-q').value.trim();
    sessionStorage.setItem('adm_gs', v);
    if (VIEW === 'search') render(); else go('search');
  },
  gsOpen(type, id) {
    if (type === 'user') return A.userDetail(id);
    if (type === 'staff') return go('staff');
    if (type === 'metier') { sessionStorage.setItem('adm_cat_tab', 'cat'); sessionStorage.setItem('adm_cat_sel', id); sessionStorage.setItem('adm_cat_q', ''); return go('catalog'); }
    if (type === 'service') {
      api('/admin/catalog').then(d => {
        const s = d.services.find(x => x.id === id);
        if (s) { sessionStorage.setItem('adm_cat_tab', 'cat'); sessionStorage.setItem('adm_cat_q', s.name); }
        go('catalog');
      }).catch(e => toast(e.message, 'err'));
      return;
    }
    if (type === 'tache') return A.taches(id); // id = service_id : ouvre la fenêtre des tâches du service
    if (type === 'mission' || type === 'paiement') return A.missionOpen(id);
    if (type === 'journal') { sessionStorage.setItem('adm_j_q', sessionStorage.getItem('adm_gs') || ''); return go('journal'); }
  },
  async missionOpen(id) {
    try {
      const m = await api('/missions/' + id); // accès admin via la permission « missions »
      openModal(`<h3>${esc(m.icon || '📋')} ${esc(m.service)} — ${esc(m.code)}</h3>
        <div style="margin-bottom:8px"><span class="pill info">${esc(m.status)}</span> ${m.urgence ? '<span class="pill bad">🔥 Urgent</span>' : ''}</div>
        <p class="small">
        ${m.tache ? `🛠️ Tâche : <b>${esc(m.tache)}</b><br>` : ''}
        👤 Client : <b>${esc(m.client ? m.client.name : '—')}</b>${m.client && m.client.phone ? ' (' + esc(m.client.phone) + ')' : ''}<br>
        🧑‍🔧 Professionnel : <b>${m.pro ? esc(m.pro.name) : '—'}</b>${m.pro && m.pro.phone ? ' (' + esc(m.pro.phone) + ')' : ''}<br>
        📍 ${esc(m.address || '—')}<br>
        📅 Créée le ${fmtD(m.created_at)}${m.date_souhaitee ? ' • Souhaitée : ' + fmtD(m.date_souhaitee) : ''}<br>
        ${m.amount ? '💰 Montant : <b>' + m.amount.toLocaleString('fr-FR') + ' F</b><br>' : ''}
        ${m.description ? 'Message : ' + esc(m.description) + '<br>' : ''}</p>
        ${m.detail && m.detail.length ? '<p class="small">' + m.detail.map(d => `<b>${esc(d.label)} :</b> ${esc(d.value)}`).join('<br>') + '</p>' : ''}
        <div class="small muted">Suivi : ${m.events.map(e => esc(e.status)).join(' → ')}</div>
        <button class="btn sec" style="margin-top:12px" onclick="closeModal()">Fermer</button>`);
    } catch (e) { toast(e.message, 'err'); }
  },

  // Maintenance (PDG)
  async maintOn() {
    const scope = (document.querySelector('input[name="mt-scope"]:checked') || {}).value;
    const functions = [...document.querySelectorAll('.mt-fn:checked')].map(c => c.value);
    const body = {
      active: 1, scope, functions,
      until: document.getElementById('mt-until').value || null,
      reason: document.getElementById('mt-reason').value,
      message: document.getElementById('mt-msg').value,
    };
    if (!confirm('Activer / mettre à jour la maintenance avec la portée « ' + scope + ' » ?\nLes utilisateurs concernés verront le message de maintenance.')) return;
    try { await api('/admin/maintenance', { method: 'POST', body }); toast('🔴 Maintenance activée.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); }
  },
  async maintOff() {
    if (!confirm('Désactiver la maintenance et rétablir toutes les activités ?')) return;
    try { await api('/admin/maintenance', { method: 'POST', body: { active: 0 } }); toast('🟢 Maintenance désactivée. Tout fonctionne normalement.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); }
  },

  // Équipe & permissions (PDG)
  staffCreate() {
    openModal(`<h3>＋ Ajouter un membre de l\u2019équipe</h3>
      <label class="small muted">Nom complet</label><input id="st-name" style="width:100%;margin-bottom:8px" placeholder="Ex : John Sery Michael">
      <label class="small muted">Identifiant de connexion (téléphone)</label><input id="st-phone" style="width:100%;margin-bottom:8px">
      <label class="small muted">E-mail (facultatif)</label><input id="st-email" style="width:100%;margin-bottom:8px">
      <label class="small muted">Rôle</label>
      <select id="st-role" style="width:100%;margin-bottom:12px">
        <option value="gestionnaire">Gestionnaire / responsable</option>
        <option value="admin">Administrateur</option>
        <option value="agent">Agent</option>
      </select>
      <p class="small muted">Les permissions par défaut du rôle s\u2019appliquent — vous pourrez les ajuster ensuite, compte par compte.</p>
      <div><button class="btn" onclick="A._staffSave()">Créer</button> <button class="btn sec" onclick="closeModal()">Annuler</button></div>`);
  },
  async _staffSave() {
    try {
      const r = await api('/admin/staff', { method: 'POST', body: { name: document.getElementById('st-name').value, phone: document.getElementById('st-phone').value, email: document.getElementById('st-email').value, role: document.getElementById('st-role').value } });
      openModal(`<h3>✅ Membre ajouté</h3>
        <p>Communiquez-lui ce mot de passe temporaire (il devra en choisir un nouveau) :</p>
        <div style="font-size:24px;font-weight:800;text-align:center;background:#eef7f5;border-radius:10px;padding:14px;letter-spacing:2px">${esc(r.temp_password)}</div>
        <p class="small muted">Connexion sur la page /admin avec son identifiant. Ce mot de passe ne sera plus jamais affiché.</p>
        <button class="btn" onclick="closeModal();render()">Terminé</button>`);
    } catch (e) { toast(e.message, 'err'); }
  },
  staffEdit(id) {
    const s = STAFFD.staff.find(x => x.id === id);
    const pk = STAFFD.perm_keys;
    openModal(`<h3>⚙️ ${esc(s.name)}</h3>
      <label class="small muted">Rôle</label>
      <select id="se-role" style="width:100%;margin-bottom:10px">
        ${[['admin', 'Administrateur'], ['gestionnaire', 'Gestionnaire / responsable'], ['agent', 'Agent'], ['user', 'Rétrograder en simple utilisateur']]
          .map(([v, lb]) => `<option value="${v}" ${s.role === v ? 'selected' : ''}>${lb}</option>`).join('')}
      </select>
      <label class="small muted">Permissions de ce compte</label>
      <div style="max-height:260px;overflow:auto;border:1px solid #e3edeb;border-radius:8px;padding:8px;margin-bottom:12px">
        ${Object.entries(pk).map(([k, lb]) => `<label style="display:flex;gap:8px;align-items:center;padding:4px 0;font-size:13.5px">
          <input type="checkbox" class="se-perm" value="${k}" ${s.perms_effectives.includes(k) ? 'checked' : ''}> ${esc(lb)}</label>`).join('')}
      </div>
      <p class="small muted">⚠️ Les fonctions réservées au PDG (gestion de l\u2019équipe, permissions) ne sont jamais accessibles aux autres rôles, quelles que soient les cases cochées.</p>
      <div><button class="btn" onclick="A._staffEditSave(${id})">Enregistrer</button> <button class="btn sec" onclick="closeModal()">Annuler</button></div>`);
  },
  async _staffEditSave(id) {
    const role = document.getElementById('se-role').value;
    const perms = {};
    document.querySelectorAll('.se-perm').forEach(c => { perms[c.value] = c.checked ? 1 : 0; });
    try {
      await api('/admin/staff/' + id, { method: 'PUT', body: { role } });
      if (role !== 'user') await api('/admin/staff/' + id, { method: 'PUT', body: { perms } });
      closeModal(); toast('Rôle et permissions mis à jour ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async staffToggle(id, field, v) {
    const reason = v ? prompt('Motif (journal) :') : null;
    if (v && reason === null) return;
    try { await api('/admin/staff/' + id, { method: 'PUT', body: { [field]: v, reason } }); toast('Mis à jour ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); }
  },
  async staffReset(id) {
    if (!confirm('Réinitialiser l\u2019accès de ce membre ? Un mot de passe temporaire sera généré.')) return;
    try {
      const r = await api('/admin/staff/' + id + '/reset-access', { method: 'POST', body: {} });
      openModal(`<h3>🔑 Accès réinitialisé</h3>
        <div style="font-size:24px;font-weight:800;text-align:center;background:#eef7f5;border-radius:10px;padding:14px;letter-spacing:2px">${esc(r.temp_password)}</div>
        <p class="small muted">Il devra choisir un nouveau mot de passe à sa prochaine connexion.</p>
        <button class="btn" onclick="closeModal()">Terminé</button>`);
    } catch (e) { toast(e.message, 'err'); }
  },
  async staffDel(id) {
    const reason = prompt('Retirer ce membre de l\u2019équipe — motif (journal) :');
    if (reason === null) return;
    try {
      const r = await api('/admin/staff/' + id, { method: 'DELETE', body: { reason } });
      toast(r.downgraded ? 'Ce compte avait des missions : il a été rétrogradé en simple utilisateur.' : 'Membre supprimé.', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },

  // Villes
  async villeAdd() {
    const name = document.getElementById('v-name').value.trim();
    if (!name) return toast('Indiquez le nom de la ville.', 'err');
    try { await api('/admin/villes', { method: 'POST', body: { name } }); toast('Ville ajoutée ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); }
  },
  async villeToggle(id, v) { try { await api('/admin/villes/' + id, { method: 'PUT', body: { active: v } }); render(); } catch (e) { toast(e.message, 'err'); } },
  async villeDel(id) { if (!confirm('Supprimer cette ville de la liste ?')) return; try { await api('/admin/villes/' + id, { method: 'DELETE' }); toast('Ville supprimée.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },

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
      const options = [0, 1, 2, 3].map(i => document.getElementById('qz-opt' + i).value.trim());
      if (options.some(o => !o)) { toast('Remplissez les 4 réponses A, B, C et D.', 'err'); return; }
      await api('/admin/quiz', {
        method: 'POST', body: {
          question: document.getElementById('qz-q').value,
          options, answer: parseInt(document.getElementById('qz-ans').value, 10) || 0
        }
      });
      toast('Question ajoutée ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async quizSessionAdd() {
    try {
      let time = document.getElementById('qs-time').value;
      if (time === 'autre') {
        time = prompt('Temps par question (en secondes, entre 5 et 600) :', '45');
        if (time === null) return;
      }
      let inter = document.getElementById('qs-inter').value;
      if (inter === 'autre') {
        inter = prompt('Intervalle entre deux quiz (en secondes, entre 3 et 600) :', '30');
        if (inter === null) return;
      }
      await api('/admin/quiz-sessions', {
        method: 'POST', body: {
          title: document.getElementById('qs-title').value,
          nb_questions: document.getElementById('qs-nbq').value,
          time_per_q: time,
          interval_s: inter,
          nb_winners: document.getElementById('qs-nbw').value,
          winner_mode: document.getElementById('qs-mode').value,
          elimination: document.getElementById('qs-elim').checked
        }
      });
      toast('Session créée ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async quizLancer(id) {
    if (!confirm('Lancer ce quiz maintenant ? Les questions seront figées et les joueurs pourront participer.')) return;
    try { await api(`/admin/quiz-sessions/${id}/lancer`, { method: 'POST' }); toast('Quiz lancé 🚀', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  },
  async quizArreter(id) {
    if (!confirm('Arrêter ce quiz ? Les participants encore en lice deviendront finalistes et les gagnants seront désignés (mode automatique) ou à désigner par vous.')) return;
    try { await api(`/admin/quiz-sessions/${id}/arreter`, { method: 'POST' }); toast('Quiz arrêté ⏹️', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  },
  async quizRejouer(id) {
    if (!confirm('Rejouer cette série ? Les réponses et les statuts des participants seront réinitialisés, et la série redémarrera immédiatement pour tout le monde. (Les messages des anciens gagnants sont conservés dans les détails.)')) return;
    try { await api(`/admin/quiz-sessions/${id}/rejouer`, { method: 'POST' }); toast('Série relancée 🔄 — la question 1 s\u2019affiche sur les accueils.', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  },
  async quizSessionDel(id) {
    if (!confirm('Supprimer ce brouillon ?')) return;
    try { await api('/admin/quiz-sessions/' + id, { method: 'DELETE' }); render(); } catch (e) { toast(e.message, 'err'); }
  },
  async quizSessionDetail(id) {
    try {
      const d = await api('/admin/quiz-sessions/' + id);
      const pst = { en_lice: '<span class="pill">En lice</span>', elimine: '<span class="pill warn">❌ Éliminé</span>', finaliste: '<span class="pill">Finaliste</span>', gagnant: '<span class="pill ok">🏆 Gagnant</span>' };
      const peutDesigner = d.status === 'terminee';
      openModal(`<h3>📋 ${esc(d.title)} — ${d.status === 'en_cours' ? '🔴 en cours' : d.status === 'terminee' ? 'terminée' : 'brouillon'}</h3>
      <div class="small muted">${d.nb_questions} questions • ${d.time_per_q}s/question • ${d.elimination ? 'élimination auto • ' : ''}${d.nb_winners} gagnant(s) • désignation ${d.winner_mode === 'auto' ? 'automatique' : 'par l\u2019administration'}</div>
      <h4>Participants (${d.participants.length})</h4>
      <div style="max-height:220px;overflow-y:auto">
      <table><tr>${peutDesigner && d.winner_mode === 'admin' ? '<th></th>' : ''}<th>Nom</th><th>Statut</th><th>Score</th><th>Photo</th><th></th></tr>
      ${d.participants.map(p => `<tr>
        ${peutDesigner && d.winner_mode === 'admin' ? `<td>${['finaliste', 'gagnant'].includes(p.status) ? `<input type="checkbox" class="qz-win" value="${p.user_id}" ${p.status === 'gagnant' ? 'checked' : ''}>` : ''}</td>` : ''}
        <td>${esc(p.name)}<br><span class="small muted">${esc(p.phone)} • ${esc(p.ville || '')}</span></td>
        <td>${pst[p.status] || esc(p.status)}</td>
        <td>${p.score} <span class="small muted">(${Math.round(p.total_ms / 1000)}s)</span></td>
        <td class="small">${p.photo_consent === 'accepte' ? '✅ Accepté' : p.photo_consent === 'refuse' ? '❌ Refusé' : p.photo_asked ? '⏳ Demandé' : '—'}</td>
        <td>${p.status === 'gagnant' ? `<button class="btn sm sec" onclick="A.quizMsg(${d.id},${p.user_id},'${esc(p.name).replace(/'/g, '')}')">💬</button>
          ${!p.photo_consent && !p.photo_asked ? `<button class="btn sm sec" onclick="A.quizPhotoAsk(${d.id},${p.user_id})">📸</button>` : ''}` : ''}</td></tr>`).join('')}
      ${!d.participants.length ? '<tr><td colspan="6" class="muted">Aucun participant.</td></tr>' : ''}</table></div>
      ${peutDesigner && d.winner_mode === 'admin' ? `<button class="btn mt" onclick="A.quizDesigner(${d.id})">🏆 Désigner les gagnant(s) coché(s) (max ${d.nb_winners})</button>` : ''}
      <h4>Questions et taux de réussite</h4>
      <div style="max-height:160px;overflow-y:auto"><table><tr><th>Question</th><th>Bonne réponse</th><th>Réussite</th></tr>
      ${d.questions.map(q => `<tr><td class="small">${esc(q.question)}</td><td class="small"><b>${'ABCD'[q.answer] || ''}</b> — ${esc(q.options[q.answer] || '')}</td>
        <td class="small">${q.reponses ? q.bonnes + '/' + q.reponses : '—'}</td></tr>`).join('')}</table></div>
      ${d.messages.length ? `<h4>💬 Messages des gagnants</h4>
      <div style="max-height:160px;overflow-y:auto">${d.messages.map(m => `<div class="small" style="margin-bottom:4px">
        <b>${m.from_admin ? 'Administration → ' + esc(m.name) : esc(m.name)}</b> <span class="muted">${fmtD(m.created_at)}</span><br>${esc(m.body)}</div>`).join('')}</div>` : ''}
      <button class="btn sec mt" onclick="closeModal()">Fermer</button>`);
    } catch (e) { toast(e.message, 'err'); }
  },
  async quizDesigner(id) {
    const ids = [...document.querySelectorAll('.qz-win:checked')].map(c => parseInt(c.value, 10));
    if (!ids.length) { toast('Cochez au moins un finaliste.', 'err'); return; }
    try {
      await api(`/admin/quiz-sessions/${id}/gagnants`, { method: 'POST', body: { user_ids: ids } });
      toast('Gagnant(s) désigné(s) 🏆 — ils ont été notifiés.', 'ok'); closeModal(); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async quizMsg(id, uid, name) {
    const body = prompt(`Message pour ${name} :`);
    if (!body || !body.trim()) return;
    try { await api(`/admin/quiz-sessions/${id}/message`, { method: 'POST', body: { user_id: uid, body: body.trim() } }); toast('Message envoyé ✓', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  },
  async quizPhotoAsk(id, uid) {
    if (!confirm('Envoyer la demande de photo à ce gagnant ? Il pourra accepter ou refuser (un refus est définitif).')) return;
    try { await api(`/admin/quiz-sessions/${id}/demander-photo`, { method: 'POST', body: { user_id: uid } }); toast('Demande envoyée 📸', 'ok'); A.quizSessionDetail(id); }
    catch (e) { toast(e.message, 'err'); }
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
  try {
    if (!ME) ME = await api('/me');
    STATS = await api('/admin/stats');
    const f = parseInt(STATS.admin_font_size || 16, 10); // taille du tableau de bord définie par le PDG
    document.body.style.zoom = f === 16 ? '' : String(f / 16);
  } catch (e) { return; }
  const fn = views[VIEW] || views.dashboard;
  try { await fn(); } catch (e) { shell(`<h1>Erreur</h1><div class="panel">${esc(e.message)}<br><button class="btn" style="margin-top:10px" onclick="render()">Réessayer</button></div>`); }
}
window.render = render;
window.addEventListener('hashchange', () => { VIEW = location.hash.replace('#', '') || 'dashboard'; render(); });
render();
