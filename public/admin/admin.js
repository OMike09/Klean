/* ============================================================
   KLEAN-SERVICES CI — Tableau de bord administrateur
   ============================================================ */
'use strict';
const root = document.getElementById('root');
let TOKEN = localStorage.getItem('ks_admin_token') || null;
let STATS = {};
let ME = null; // compte connecté : { role, perms: [...] }
let VIEW = location.hash.replace('#', '') || 'dashboard';
let ADMIN_STACK = [VIEW], ADMIN_CURSOR = 0, ADMIN_CURRENT = VIEW;
let ADMIN_ALLOW_ONCE = false, ADMIN_PENDING_MOVE = 0, ADMIN_RESTORING = false, ADMIN_CONFIRM_MOVE = null;
let ADMIN_DIRTY = { enabled:false, dirty:false, modalDirty:false };
let ADMIN_WRITES = 0;
const ROLE_LB = { pdg: '👑 PDG', admin: 'Administrateur', gestionnaire: 'Gestionnaire', agent: 'Agent', user: 'Utilisateur' };
function can(k) { return ME && (ME.role === 'pdg' || (ME.perms || []).includes(k)); }

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function mediaUrl(src) { const s = String(src || ''); return s.startsWith('/uploads/') && TOKEN ? s + (s.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN) : s; }
function fmtD(s) { if (!s) return ''; const d = new Date(s.replace(' ', 'T') + 'Z'); return d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function fcfa(n) { return (n ?? 0).toLocaleString('fr-FR') + ' F'; }
function zonesLabel(raw) { try { const z = Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); return z && z.length ? z.join(', ') : '🌍 Toute la Côte d’Ivoire'; } catch { return '🌍 Toute la Côte d’Ivoire'; } }
function toast(m, cls) { const z = document.getElementById('toast'); const t = document.createElement('div'); t.className = 'toast ' + (cls || ''); t.textContent = m; z.appendChild(t); setTimeout(() => t.remove(), 4500); }

async function api(path, opts = {}) {
  const headers = {};
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  const writing=['POST','PUT','PATCH','DELETE'].includes(String(opts.method||'GET').toUpperCase()); if(writing)ADMIN_WRITES++;
  try {
    let res;
    try { res = await fetch('/api' + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined }); }
    catch { throw new Error('Connexion impossible. Vérifiez votre connexion.'); }
    let data = {}; try { data = await res.json(); } catch { }
    if (!res.ok) { if (res.status === 401) { TOKEN = null; localStorage.removeItem('ks_admin_token'); renderLogin(); } throw new Error(data.error || 'Erreur serveur.'); }
    return data;
  } finally { if(writing) ADMIN_WRITES=Math.max(0,ADMIN_WRITES-1); }
}

// Téléversement utilisé par la fiche d'une grande catégorie. L'association reste ensuite
// validée par l'API PDG : téléverser un fichier ne suffit jamais à le publier.
async function uploadImageForCategory(file) {
  if (!file) throw new Error('Choisissez une image.');
  if (!/^image\//i.test(file.type || '')) throw new Error('Le fichier doit être une image.');
  if (file.size > 15 * 1024 * 1024) throw new Error('L’image dépasse la limite de 15 Mo.');
  const form = new FormData(); form.append('files', file);
  const headers = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};
  ADMIN_WRITES++;
  try {
    let res; try { res = await fetch('/api/upload', { method:'POST', headers, body:form }); }
    catch { throw new Error('Connexion impossible. Vérifiez votre connexion.'); }
    let data={}; try { data=await res.json(); } catch { }
    if (!res.ok) throw new Error(data.error || 'Téléversement impossible.');
    if (!Array.isArray(data.files) || !data.files[0]) throw new Error('Aucune image valide n’a été reçue.');
    return data.files[0];
  } finally { ADMIN_WRITES=Math.max(0,ADMIN_WRITES-1); }
}
function adminResetDirty(){ ADMIN_DIRTY={enabled:false,dirty:false,modalDirty:false}; }
function adminArmDraft(root, reset){ if(reset)adminResetDirty(); const zone=root||root; if(!zone)return; const controls=zone.querySelectorAll('input,textarea,select'); if(!controls.length)return; ADMIN_DIRTY.enabled=true; controls.forEach(el=>{ if(el.disabled||el.type==='hidden'||el.type==='button'||el.type==='submit'||el.id==='gs-q'||el.dataset.adminDraftBound)return; el.dataset.adminDraftBound='1'; const changed=()=>{ADMIN_DIRTY.dirty=true;if(el.closest('#modal'))ADMIN_DIRTY.modalDirty=true;};el.addEventListener('input',changed,{passive:true});el.addEventListener('change',changed,{passive:true}); }); }
function adminForceCloseModal(){ if(window._supportPoll){clearInterval(window._supportPoll);window._supportPoll=null;}const m=document.getElementById('modal');if(m)m.remove();ADMIN_DIRTY.modalDirty=false; }
function adminLeaveConfirm(action){ if(document.getElementById('admin-leave-confirm'))return; const bg=document.createElement('div');bg.className='modal-bg';bg.id='admin-leave-confirm';bg.style.zIndex='2000';bg.innerHTML=`<div class="modal"><h3>Modifications non enregistrées</h3><p class="small">Vous avez des modifications non enregistrées. Voulez-vous quitter cette page ?</p><div class="btn-row"><button class="btn sec" id="admin-leave-stay">Continuer la modification</button><button class="btn warn" id="admin-leave-drop">Quitter sans enregistrer</button></div></div>`;document.body.appendChild(bg);document.getElementById('admin-leave-stay').onclick=()=>bg.remove();document.getElementById('admin-leave-drop').onclick=()=>{bg.remove();adminResetDirty();action();}; }
function adminWithLeave(action){ if(ADMIN_WRITES){toast('Enregistrement en cours : veuillez patienter avant de revenir.','err');return;} if(ADMIN_DIRTY.enabled&&ADMIN_DIRTY.dirty){adminLeaveConfirm(action);return;}action(); }
function adminCloseAttempt(){if(ADMIN_DIRTY.modalDirty)adminLeaveConfirm(()=>adminForceCloseModal());else adminForceCloseModal();}
function openModal(html) { adminForceCloseModal(); const bg = document.createElement('div'); bg.className = 'modal-bg'; bg.id = 'modal'; bg.innerHTML = `<div class="modal">${html}</div>`; bg.onclick = e => { if (e.target === bg) adminCloseAttempt(); }; document.body.appendChild(bg); adminArmDraft(bg,false); }
function closeModal() { adminForceCloseModal(); }

/* ---------- Connexion ---------- */
function renderLogin() {
  root.innerHTML = `<div class="login-wrap"><div class="login-box">
    <h2 style="margin:0 0 4px">🖥️ Administration</h2>
    <div class="muted small" style="margin-bottom:18px">Klean Services</div>
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
  ['TABLEAU DE BORD', [['dashboard', '📊 Vue d\u2019ensemble', null, null], ['frequentation', '📈 Statistiques de fréquentation', null, 'frequentation']]],
  ['UTILISATEURS', [['users', '👥 Tous les comptes', null, 'comptes'], ['pros', '✅ Validations pro', 'pros_pending', 'pros']]],
  ['SERVICES', [['catalog', '🗂️ Services & catégories', null, 'catalogue'], ['questions', '❓ Questions dynamiques', null, 'questions']]],
  ['MISSIONS', [['missions', '🧰 Demandes & missions', null, 'missions'], ['payments', '💰 Paiements & commissions', null, 'paiements'], ['finances', '📈 Finances & revenus', null, 'paiements']]],
  ['COMMUNICATION', [['ads', '📣 Publicités & infos', null, 'communication'], ['bandeau', '📺 Gestion bande défilante', null, 'PDG'], ['support', '📩 Messages Klean Services', null, 'communication'], ['broadcast', '📨 Messages généraux', null, 'communication']]],
  ['SÉCURITÉ', [['rules', '📜 Règles & conditions', null, 'securite'], ['reports', '⚠️ Signalements', 'signalements', 'securite'], ['urgences', '🚨 Urgences', 'urgences', 'securite'], ['files', '🗄️ Gestion des fichiers', null, 'securite']]],
  ['CONTENU', [['avis', '📢 Avis de recherche', null, 'contenu'], ['jobs', '💼 Trouver ou proposer un job', null, 'contenu'], ['braderie', '🏷️ Articles seconde main', null, 'PDG'], ['cabine', '📲 Gestion de Klean Cabine', null, 'PDG'], ['ecole', '🏫 École & famille', null, 'contenu'], ['voice-search', '🎤 Recherche vocale', null, 'PDG'], ['games', '🎮 Quiz / Flip Fizz / Kdo', null, 'contenu']]],
  ['DIRECTION', [['staff', '👑 Équipe & permissions', null, 'PDG'], ['prooptions', '🧩 Options comptes pro', null, 'PDG'], ['maintenance', '🛠 Maintenance / suspension', null, 'PDG'], ['journal', '🧾 Journal des actions', null, 'journal']]],
  ['CONFIGURATION', [['estimates', '🧠 Tarifs & estimations intelligentes', null, 'PDG'], ['commerce', '💰 Paramètres commerciaux', null, 'parametres'], ['settings', '⚙️ Paramètres généraux', null, 'parametres']]],
];
function menuVisible(perm) { return !perm || (perm === 'PDG' ? ME && ME.role === 'pdg' : can(perm)); }

function shell(content) {
  root.innerHTML = `
  <div class="layout">
    <div class="side" id="side">
      <div class="logo">Klean Services<br><span class="small" style="color:#6d9c94;font-weight:600">Administration</span>
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
      <div class="admin-topbar">
        ${ADMIN_CURSOR > 0 ? `<button class="btn sec admin-back" onclick="adminBack()" aria-label="Retour à l’écran précédent">← Retour</button>` : ''}
        <div style="display:flex;gap:8px;flex:1;align-items:center">
        <input id="gs-q" style="flex:1;max-width:620px;padding:10px 14px;border:1.5px solid #cfe0dd;border-radius:10px;font-size:14px"
          placeholder="🔎 Rechercher partout : nom, téléphone, e-mail, code KP, service, mission, paiement…" value="${esc(sessionStorage.getItem('adm_gs') || '')}">
        <button class="btn sm" onclick="A.gsGo()">Rechercher</button>
        </div>
      </div>
      ${content}
    </div>
  </div>
  <button class="menu-toggle" onclick="document.getElementById('side').classList.toggle('open')">☰</button>`;
  const gq = document.getElementById('gs-q');
  if (gq) gq.addEventListener('keydown', e => { if (e.key === 'Enter') A.gsGo(); });
}
function adminCommit(view){
  if(view===ADMIN_CURRENT)return;
  if(ADMIN_PENDING_MOVE){const expect=ADMIN_CURSOR+ADMIN_PENDING_MOVE; if(ADMIN_STACK[expect]===view)ADMIN_CURSOR=expect;else {const f=ADMIN_STACK.lastIndexOf(view);ADMIN_CURSOR=f>=0?f:Math.max(0,expect);} ADMIN_PENDING_MOVE=0;}
  else if(ADMIN_STACK[ADMIN_CURSOR-1]===view)ADMIN_CURSOR--;
  else if(ADMIN_STACK[ADMIN_CURSOR+1]===view)ADMIN_CURSOR++;
  else {ADMIN_STACK=ADMIN_STACK.slice(0,ADMIN_CURSOR+1);ADMIN_STACK.push(view);ADMIN_CURSOR=ADMIN_STACK.length-1;}
  ADMIN_CURRENT=view;VIEW=view;adminResetDirty();render();
}
function go(v) { if(v===ADMIN_CURRENT)return; adminWithLeave(()=>{ADMIN_ALLOW_ONCE=true;adminForceCloseModal();location.hash=v;}); }
function adminBack(){ const m=document.getElementById('modal');if(m){adminCloseAttempt();return;}adminWithLeave(()=>{if(ADMIN_CURSOR>0){ADMIN_ALLOW_ONCE=true;ADMIN_PENDING_MOVE=-1;history.back();}else toast('Vous êtes déjà sur le premier écran de cette navigation.','ok');}); }
function adminLogout() { TOKEN = null; localStorage.removeItem('ks_admin_token'); adminResetDirty(); renderLogin(); }
window.go = go; window.adminBack = adminBack; window.adminLogout = adminLogout; window.closeModal = closeModal;

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

/* ---------- Statistiques de fréquentation ---------- */
let FREQ_QUERY = 'days=30', FREQ_PRESET = '30jours';
views.frequentation = async () => {
  const d = await api('/admin/frequentation?' + FREQ_QUERY);
  const max = Math.max(1, ...d.series.map(x => x.active));
  const fmt = n => Number(n || 0).toLocaleString('fr-FR');
  shell(`<h1>📈 Statistiques de fréquentation</h1>
  <div class="panel"><div class="frow"><button class="btn sm ${FREQ_PRESET==='today'?'':'sec'}" onclick="A.frequencyPreset('today')">Aujourd’hui</button><button class="btn sm ${FREQ_PRESET==='yesterday'?'':'sec'}" onclick="A.frequencyPreset('yesterday')">Hier</button><button class="btn sm ${FREQ_PRESET==='week'?'':'sec'}" onclick="A.frequencyPreset('week')">Cette semaine</button><button class="btn sm ${FREQ_PRESET==='lastweek'?'':'sec'}" onclick="A.frequencyPreset('lastweek')">Semaine dernière</button><button class="btn sm ${FREQ_PRESET==='month'?'':'sec'}" onclick="A.frequencyPreset('month')">Ce mois</button><button class="btn sm ${FREQ_PRESET==='lastmonth'?'':'sec'}" onclick="A.frequencyPreset('lastmonth')">Mois dernier</button><button class="btn sm ${FREQ_PRESET==='30jours'?'':'sec'}" onclick="A.frequencyPeriod(30)">30 jours</button></div><div class="frow" style="margin-top:8px"><div><label class="small">Du</label><input type="date" id="fq-from" value="${esc(d.range.from)}"></div><div><label class="small">Au</label><input type="date" id="fq-to" value="${esc(d.range.to)}"></div><button class="btn sm sec" style="align-self:end" onclick="A.frequencyCustom()">Période personnalisée</button><span class="small muted" style="align-self:end">Période : ${esc(d.range.from)} → ${esc(d.range.to)}</span></div>
  <div class="cards" style="margin-top:12px"><div class="kpi"><div class="v">${fmt(d.active)}</div><div class="l">Actifs période</div></div><div class="kpi"><div class="v">${fmt(d.dau)}</div><div class="l">Actifs jour</div></div><div class="kpi"><div class="v">${fmt(d.wau)}</div><div class="l">Actifs semaine</div></div><div class="kpi"><div class="v">${fmt(d.mau)}</div><div class="l">Actifs mois</div></div><div class="kpi"><div class="v">${fmt(d.registrations)}</div><div class="l">Inscriptions</div></div><div class="kpi"><div class="v">${fmt(d.returning)}</div><div class="l">Retours</div></div></div>
  <div class="small muted mt">Clients actifs : <b>${fmt(d.clients)}</b> • Professionnels actifs : <b>${fmt(d.pros)}</b>. Une activité est enregistrée sur une interaction réelle (pas sur un simple rafraîchissement). Seuil courant : ${d.threshold_minutes} min.</div></div>
  <div class="panel"><h2 style="margin-top:0">Activité quotidienne</h2><div style="display:flex;align-items:end;gap:3px;height:150px;border-bottom:1px solid #d8e5e2;padding:0 3px">${d.series.map(x=>`<div title="${esc(x.date)} : ${x.active} actif(s), ${x.registrations} inscription(s)" style="flex:1;min-width:3px;height:${Math.max(3,Math.round(x.active/max*125))}px;background:#0b7a6b;border-radius:3px 3px 0 0"></div>`).join('')}</div><div class="small muted" style="display:flex;justify-content:space-between"><span>${esc(d.series[0]?.date||'')}</span><span>${esc(d.series.at(-1)?.date||'')}</span></div></div>
  <div class="panel"><h2 style="margin-top:0">Villes (actifs sur la période)</h2><table><tr><th>Ville</th><th>Utilisateurs actifs</th></tr>${d.cities.map(c=>`<tr><td>${esc(c.city)}</td><td><b>${fmt(c.n)}</b></td></tr>`).join('') || '<tr><td colspan="2" class="muted">Aucune interaction dans cette période.</td></tr>'}</table></div>
  <div class="panel"><h2 style="margin-top:0">Utilisateurs récemment actifs <span class="small muted">(détail réservé aux personnes autorisées)</span></h2><div class="small muted mb">🟢 actif = interaction récente au premier plan ; 🟡 arrière-plan = l’application a signalé son passage en arrière-plan ; ⚪ inactif = aucune activité dans le seuil. L’état ne prétend pas connaître l’activité hors application.</div><table><tr><th>Compte</th><th>Type / ville</th><th>Dernière interaction</th><th>État</th></tr>${d.recent.slice(0,50).map(u=>`<tr><td><b>${esc(u.name)}</b><br><span class="small muted">${esc(u.phone)}</span></td><td>${u.pro_status==='approved'?'Pro':'Client'}<br><span class="small muted">${esc(u.ville||'—')}</span></td><td class="small">${fmtD(u.last_activity_at||u.last_background_at)}</td><td>${u.status==='actif'?'🟢 Actif':u.status==='arriere_plan'?'🟡 Arrière-plan':'⚪ Inactif'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Aucune activité mesurée.</td></tr>'}</table></div>`);
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
  <div class="panel"><table><tr><th>Nom</th><th>Téléphone</th><th>Code pro</th><th>Service</th><th>Localisation</th><th>Statut</th><th>Inscrit le</th><th>Actions</th></tr>
  ${list.map(u => {
    const services = Array.isArray(u.services) ? u.services : [];
    const domaine = services.length ? services.join(' • ') : (u.pro_profession || '—');
    return `<tr>
    <td><b>${esc(u.name)}</b> ${u.verified ? '✅' : ''}${u.profile_incomplete ? ' <span class="pill warn small">profil à compléter</span>' : ''}</td>
    <td>${esc(u.phone)}${u.email ? `<div class="small muted">${esc(u.email)}</div>` : ''}</td>
    <td class="small">${u.kp_code ? '<b>' + esc(u.kp_code) + '</b>' : '—'}</td>
    <td class="small" style="min-width:180px;white-space:normal">${esc(domaine)}${u.service_city ? `<div class="muted">📍 Service : ${esc(u.service_city)}</div>` : ''}</td>
    <td class="small">${esc(u.ville ? u.ville + (u.quartier ? ' / ' + u.quartier : '') : (u.address || '—'))}</td>
    <td>${userStatusPill(u)}</td>
    <td class="small">${fmtD(u.created_at)}</td>
    <td><button class="btn sm sec" onclick="A.userDetail(${u.id})">📋 Fiche</button></td></tr>`;
  }).join('')}
  ${!list.length ? '<tr><td colspan="8" class="muted">Aucun compte.</td></tr>' : ''}</table></div>`);
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
  const q=window._maintQuery||'',role=window._maintRole||'all';
  const [base,accountsData]=await Promise.all([api('/admin/maintenance'),api('/admin/maintenance/accounts?q='+encodeURIComponent(q)+'&role='+encodeURIComponent(role))]);
  MAINTD=base;const {config:m,actif,scheduled,stats}=base,accounts=accountsData.accounts||[];
  const display={...m,...(window._maintDraft||{})};
  if(!window._maintSelected)window._maintSelected=new Set();
  const selected=window._maintSelected,checked=id=>selected.has(Number(id))?'checked':'';
  const currentActive=!!actif,indicator=currentActive?'🔴 Maintenance activée':'🟢 Maintenance désactivée',color=currentActive?'#b91c1c':'#15803d';
  shell(`<h1>🛠 Maintenance / Suspension des activités <span class="pill info">Klean Services</span></h1>
  <div class="panel" style="border-left:5px solid ${color}"><h2 style="margin-top:0">1. État de la plateforme</h2><div class="row"><div class="grow"><b style="color:${color}">${indicator}</b><div class="small muted mt">${currentActive?'Tous les comptes sont bloqués par défaut. Seuls Klean Services et les comptes explicitement autorisés peuvent accéder à la plateforme.':'Les droits habituels sont appliqués. Les sanctions, suspensions et désactivations administratives individuelles restent toujours en vigueur.'}</div></div><label class="check-line" style="font-weight:700"><input id="mt-simple-active" type="checkbox" ${currentActive?'checked':''} onchange="A.maintSimpleToggle(this.checked)"> Maintenance activée</label></div>${scheduled?`<div class="hint mt">Une configuration programmée existe : ${esc(String(m.start_at||'').replace('T',' à '))}. La bascule de cet interrupteur applique immédiatement votre décision confirmée.</div>`:''}<div class="cards mt"><div class="kpi"><div class="v">${stats.blocked||0}</div><div class="l">Comptes bloqués par défaut</div></div><div class="kpi"><div class="v">${stats.allowed||0}</div><div class="l">Comptes autorisés</div></div><div class="kpi"><div class="v">${stats.denied_attempts||0}</div><div class="l">Accès refusés · 30 jours</div></div></div></div>
  <div class="panel"><h2 style="margin-top:0">2. Gestion des comptes</h2><div class="small muted mb">Cette liste unique ne modifie jamais une sanction administrative. « Bloquer » retire seulement l’exception temporaire de maintenance ; à la désactivation, chaque compte retrouve automatiquement son droit normal sous réserve de ses sanctions individuelles.</div><div class="frow" style="align-items:flex-end"><div style="flex:1;min-width:210px"><label>Rechercher</label><input id="mt-account-q" value="${esc(q)}" placeholder="Nom, identifiant, téléphone…" onkeydown="if(event.key==='Enter')A.maintAccountsFilter()"></div><div><label>Rôle</label><select id="mt-account-role"><option value="all">Tous les rôles</option><option value="client" ${role==='client'?'selected':''}>Utilisateur</option><option value="professional" ${role==='professional'?'selected':''}>Professionnel</option><option value="pdg" ${role==='pdg'?'selected':''}>Klean Services</option><option value="admin" ${role==='admin'?'selected':''}>Administrateur</option><option value="gestionnaire" ${role==='gestionnaire'?'selected':''}>Gestionnaire</option><option value="agent" ${role==='agent'?'selected':''}>Agent</option></select></div><button class="btn sm sec" onclick="A.maintAccountsFilter()">Filtrer</button></div><div class="btn-row mt"><button class="btn sm sec" onclick="A.maintSelectAll()">Sélectionner tous</button><button class="btn sm sec" onclick="A.maintClearSelection()">Désélectionner tous</button><button class="btn sm" onclick="A.maintBatchAllowed(true)">Autoriser sélectionnés</button><button class="btn sm warn" onclick="A.maintBatchAllowed(false)">Bloquer sélectionnés</button><button class="btn sm" onclick="A.maintReleaseAll()">Débloquer tous les comptes</button></div><table style="margin-top:12px"><tr><th>Sélection</th><th>Nom / prénom</th><th>Identifiant</th><th>Rôle</th><th>Statut</th><th>Maintenance</th></tr>${accounts.map(a=>`<tr><td>${a.role==='pdg'?'—':`<input class="mt-account-check" type="checkbox" ${checked(a.id)} onchange="A.maintToggleSelection(${a.id},this.checked)">`}</td><td><b>${esc(a.name)}</b></td><td>${esc(a.kp_code||a.phone||('Compte #'+a.id))}</td><td>${esc(a.role_label||a.role)}</td><td>${esc(a.status)}</td><td>${a.role==='pdg'?'<span class="pill ok">Accès permanent</span>':a.maintenance_allowed?'<span class="pill ok">Autorisé</span>':'<span class="pill off">Bloqué si maintenance</span>'}</td></tr>`).join('')||'<tr><td colspan="6" class="muted">Aucun compte trouvé.</td></tr>'}</table></div>
  <div class="panel"><h2 style="margin-top:0">3. Message de maintenance</h2><div class="small muted mb">Préparez et prévisualisez le message avant d’activer la maintenance. Lorsqu’elle est active, l’enregistrement met à jour immédiatement l’alerte affichée.</div><div class="frow"><div style="flex:1"><label>Titre</label><input id="mt-title" maxlength="180" value="${esc(display.title||'MAINTENANCE EN COURS')}" style="width:100%"></div><div><label>Icône</label><select id="mt-icon"><option value="⚠️" ${(display.icon||'⚠️')==='⚠️'?'selected':''}>⚠️ Alerte</option><option value="🚧" ${(display.icon||'')==='🚧'?'selected':''}>🚧 Travaux</option><option value="🛠️" ${(display.icon||'')==='🛠️'?'selected':''}>🛠️ Maintenance</option><option value="🔒" ${(display.icon||'')==='🔒'?'selected':''}>🔒 Accès suspendu</option></select></div><div><label>Couleur</label><input id="mt-color" type="color" value="${esc(display.background_color||'#b91c1c')}"></div></div><div class="field"><label>Message</label><textarea id="mt-msg" maxlength="4000">${esc(display.message||'Klean Services effectue une opération de maintenance. Veuillez réessayer dans quelques instants.')}</textarea></div><div class="field"><label>Précision</label><input id="mt-precision" maxlength="700" value="${esc(display.precision||'Nous serons de retour très bientôt.')}" style="width:100%"></div><div class="frow"><div style="flex:1"><label>Logo</label><input id="mt-logo" maxlength="1000" value="${esc(display.logo_url||'/logo.png')}" style="width:100%"></div><div><label>Téléverser un logo</label><input id="mt-logo-file" type="file" accept="image/*"><button class="btn sm sec mt" onclick="A.maintLogoUpload(this)">Téléverser</button></div></div><div class="btn-row mt"><button class="btn sec" onclick="A.maintPreview()">👁️ Aperçu</button><button class="btn" onclick="A.maintSaveMessage()">${currentActive?'Mettre à jour le message':'Préparer ce message'}</button></div></div>`);
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
let ESTD = null; // catalogue + règles du moteur intelligent
views.catalog = async () => {
  const tab = sessionStorage.getItem('adm_cat_tab') || 'cat';
  if (tab === 'villes') return views._villes();
  if (tab === 'pop') return views._populaires();
  if (tab === 'photos') return views._grandPhotos();
  const d = CATD = await api('/admin/catalog');
  const q = (sessionStorage.getItem('adm_cat_q') || '').toLowerCase();
  let sel = parseInt(sessionStorage.getItem('adm_cat_sel') || 0, 10);
  if (!d.categories.some(c => c.id === sel)) sel = d.categories[0]?.id || 0;

  const nTaches = {}; d.taches.forEach(t => nTaches[t.service_id] = (nTaches[t.service_id] || 0) + 1);
  const grandImages = (d.grand_categories || []).sort((a,b)=>(a.sort||0)-(b.sort||0)||a.id-b.id).map(g => {
    const photo = g.image_url ? `<img src="${esc(mediaUrl(g.image_url))}" alt="${esc(g.name)}" style="width:72px;height:56px;object-fit:cover;border-radius:8px;border:1px solid #d3e4e0">` : '<span style="display:grid;place-items:center;width:72px;height:56px;border-radius:8px;background:#edf5f3">🖼️</span>';
    return `<div style="display:flex;align-items:center;gap:8px;padding:7px;border:1px solid #e2eeeb;border-radius:10px;min-width:245px;flex:1">${photo}<div style="min-width:0;flex:1"><b class="small" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.short_label || g.name)}</b><span class="small ${g.image_url ? 'muted' : 'bad'}">${g.image_url ? 'Photo principale publiée' : 'Photo manquante'}</span></div>${ME && ME.role==='pdg' ? `<button class="btn sm sec" onclick="A.grandCategoryForm(${g.id})">Photo</button>` : ''}</div>`;
  }).join('');
  const imagePanel = `<div class="panel"><div class="frow" style="align-items:center"><div><h2 style="margin:0">Photos des grandes catégories</h2><div class="small muted">Une source par identifiant de grande catégorie, partagée par les cartes publiques et le tableau PDG.</div></div>${ME && ME.role==='pdg' ? '<span class="pill ok">Modification réservée au PDG</span>' : ''}</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(255px,1fr));gap:8px;margin-top:12px">${grandImages}</div></div>`;
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
  ${imagePanel}
  <div class="tabs">
    <button class="on">🗂️ Catalogue</button>
    <button onclick="sessionStorage.setItem('adm_cat_tab','pop');render()">⭐ Services populaires</button>
    <button onclick="sessionStorage.setItem('adm_cat_tab','villes');render()">🏙️ Villes (${'villes' in STATS ? STATS.villes : '…'})</button>
    <button onclick="sessionStorage.setItem('adm_cat_tab','photos');render()">🖼️ Catégories & photos</button>
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


/* ---------- Photos des grandes catégories (source unique par identifiant) ---------- */
views._grandPhotos = async () => {
  const d = CATD = await api('/admin/catalog');
  const rows = (d.grand_categories || []).slice().sort((a,b)=>(a.sort||0)-(b.sort||0)||a.id-b.id);
  const cards = rows.map(g => {
    const photo = g.image_url
      ? `<img src="${esc(mediaUrl(g.image_url))}" alt="${esc(g.name)}" style="width:100%;height:152px;object-fit:cover;display:block">`
      : '<div style="height:152px;display:grid;place-items:center;background:#edf5f3;font-size:38px">🖼️</div>';
    const action = ME && ME.role==='pdg'
      ? `<button class="btn sm ${g.image_url ? 'sec' : ''}" onclick="A.grandCategoryPhotoForm(${g.id})">${g.image_url ? 'Modifier la photo' : 'Ajouter une photo'}</button>`
      : '<span class="small muted">Modification réservée au PDG</span>';
    return `<article class="grand-photo-card" style="min-width:0;overflow:hidden;background:#fff;border:1px solid #dce9e6;border-radius:12px;display:flex;flex-direction:column">${photo}<div style="padding:10px"><div style="display:flex;gap:6px;align-items:flex-start;justify-content:space-between"><b style="line-height:1.25">${esc(g.short_label || g.name)}</b>${g.active ? '<span class="pill ok">Active</span>' : '<span class="pill off">Inactive</span>'}</div><div class="small muted" style="min-height:32px;margin:5px 0 9px">${g.image_url ? 'Photo principale publiée sur les cartes et associée à la catégorie #' + Number(g.id) : 'Aucune photo principale enregistrée.'}</div>${action}</div></article>`;
  }).join('');
  shell(`<h1>🖼️ Catégories & photos</h1>
    <div class="tabs"><button onclick="sessionStorage.setItem('adm_cat_tab','cat');render()">🗂️ Catalogue</button><button onclick="sessionStorage.setItem('adm_cat_tab','pop');render()">⭐ Services populaires</button><button onclick="sessionStorage.setItem('adm_cat_tab','villes');render()">🏙️ Villes</button><button class="on">🖼️ Catégories & photos</button></div>
    <div class="panel small muted">Chaque carte lit l’unique champ photo de sa grande catégorie. Remplacer ou retirer une photo met donc immédiatement à jour le tableau PDG et les cartes publiques, sans toucher aux métiers, prestations, missions ni historiques.</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:14px">${cards}</div>`);
};


/* ---------- Tarifs et estimations intelligentes (PDG) ---------- */
views.estimates = async () => {
  const [catalog, rules, cfg, villes, terms] = await Promise.all([
    api('/admin/catalog'), api('/admin/estimation-rules'), api('/admin/estimation-config'), api('/admin/villes'), api('/admin/search-terms')
  ]);
  ESTD = { catalog, rules, cfg, villes, terms };
  const target = r => [r.grand_category_name, r.category_name, r.sub_name, r.service_name, r.task_name].filter(Boolean).join(' › ') || 'Cible non renseignée';
  const source = r => r.source_type === 'pdg' ? 'Règle direction' : 'Donnée locale vérifiée';
  const cities = villes.filter(v => v.active).map(v => v.name);
  const allServices = catalog.services.filter(s => s.active);
  shell(`<h1>🧠 Gestion des tarifs et estimations intelligentes</h1>
    <div class="panel small muted">Le moteur applique d’abord les règles explicites de la direction, puis les données locales vérifiées, ensuite l’historique suffisamment documenté, puis le tarif de référence autorisé. Sans donnée fiable, il affiche « Prix à confirmer ». Aucun prix de marché n’est inventé.</div>
    <div class="panel"><div class="frow" style="align-items:center"><h2 style="margin:0;flex:1">Grandes catégories centrales</h2><button class="btn sm" onclick="A.grandCategoryForm(0)">＋ Ajouter</button></div>
      <div style="display:flex;flex-wrap:wrap;gap:7px;margin-top:10px">${catalog.grand_categories.map(g => `<span class="pill ${g.active ? 'ok' : 'off'}">${esc(g.icon || '🧩')} ${esc(g.name)} <button type="button" style="border:0;background:transparent;cursor:pointer" onclick="A.grandCategoryForm(${g.id})">✏️</button></span>`).join('')}</div></div>
    <div class="panel"><h2 style="margin-top:0">Règles globales</h2><div class="frow">
      <label><input type="checkbox" id="est-geo" ${cfg.geo_enabled ? 'checked' : ''}> Ajustements géographiques par ville actifs</label>
      <label>Repli si aucune donnée locale <select id="est-fallback"><option value="reference" ${cfg.fallback === 'reference' ? 'selected' : ''}>Tarif de référence PDG (provisoire)</option><option value="confirmer" ${cfg.fallback === 'confirmer' ? 'selected' : ''}>Prix à confirmer</option></select></label>
      <label>Historique minimum <input id="est-samples" type="number" min="3" max="100" value="${cfg.history_min_samples}" style="width:78px"> interventions validées</label>
      <button class="btn" onclick="A.saveEstimationConfig()">Enregistrer</button>
    </div></div>
    <div class="panel"><div class="frow" style="align-items:center"><h2 style="margin:0;flex:1">Règles tarifaires (${rules.length})</h2><button class="btn" onclick="A.estimateRuleForm(0)">＋ Nouvelle règle</button></div>
      <div class="small muted" style="margin:8px 0">Une règle peut cibler une grande catégorie, un métier, une sous-catégorie, une prestation ou une tâche, et éventuellement une ville/zone. Les facteurs JSON permettent par exemple un ajustement fixe ou un pourcentage.</div>
      <div style="overflow:auto"><table><tr><th>Cible</th><th>Ville / zone</th><th>Estimation</th><th>Source / actualisation</th><th>État</th><th></th></tr>
      ${rules.map(r => `<tr><td><b>${esc(target(r))}</b><div class="small muted">Priorité ${r.priority || 0}</div></td><td>${esc(r.city || 'Toutes villes')}${r.zone ? '<br><span class="small muted">' + esc(r.zone) + '</span>' : ''}</td><td><b>${r.base_price ? fcfa(r.base_price) : '—'}</b>${r.min_price || r.max_price ? `<div class="small muted">${r.min_price ? fcfa(r.min_price) : '—'} → ${r.max_price ? fcfa(r.max_price) : '—'}</div>` : ''}</td><td>${esc(source(r))}<div class="small muted">${esc(r.source_date || r.verified_at || r.updated_at || '')}</div></td><td>${r.active ? '<span class="pill ok">Active</span>' : '<span class="pill off">Inactive</span>'}</td><td style="white-space:nowrap"><button class="btn sm sec" onclick="A.estimateRuleForm(${r.id})">Modifier</button><button class="btn sm warn" onclick="A.deleteEstimationRule(${r.id})">🗑️</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Aucune règle : le moteur utilisera seulement le repli éventuellement autorisé.</td></tr>'}
      </table></div></div>
    <div class="panel"><h2 style="margin-top:0">Tester une estimation avant publication</h2><div class="frow"><select id="est-test-service" style="min-width:230px"><option value="">Choisir une prestation</option>${allServices.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select><select id="est-test-city" style="min-width:180px"><option value="">Choisir une ville</option>${cities.map(c => `<option>${esc(c)}</option>`).join('')}</select><button class="btn" onclick="A.testEstimation()">Tester</button></div><div id="est-test-result" class="small muted" style="margin-top:9px">Aucun test en cours.</div></div>
    <div class="panel"><div class="frow" style="align-items:center"><h2 style="margin:0;flex:1">Dictionnaire de recherche (${terms.length})</h2><button class="btn" onclick="A.searchTermForm()">＋ Ajouter une expression</button></div>
      <div class="small muted" style="margin:8px 0">Synonymes, formulations familières et fautes connues reliés à une prestation/tâche réelle. Les expressions du catalogue restent modifiables ou désactivables.</div>
      <div style="max-height:340px;overflow:auto"><table><tr><th>Expression</th><th>Destination</th><th>Source</th><th>État</th><th></th></tr>${terms.map(t => `<tr><td>${esc(t.term)}</td><td>${esc(t.service_name)}${t.task_name ? ' › ' + esc(t.task_name) : ''}</td><td class="small">${esc(t.source)}</td><td>${t.active ? '<span class="pill ok">Active</span>' : '<span class="pill off">Inactive</span>'}</td><td style="white-space:nowrap"><button class="btn sm sec" onclick="A.toggleSearchTerm(${t.id},${t.active ? 0 : 1})">${t.active ? 'Désactiver' : 'Activer'}</button><button class="btn sm warn" onclick="A.deleteSearchTerm(${t.id})">🗑️</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Aucune expression.</td></tr>'}</table></div></div>`);
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
      : `<button class="btn sm warn" onclick="A.litige(${m.id},true)">Litige</button>`}
      <button class="btn sm sec" onclick="A.conversationLock(${m.id},${m.conversation_locked_at ? 0 : 1})">${m.conversation_locked_at ? '🔓 Réactiver échanges' : '🔒 Suspendre échanges'}</button></td></tr>`; }).join('')}
  ${!list.length ? '<tr><td colspan="8" class="muted">Aucune mission.</td></tr>' : ''}</table></div>`);
};

/* ---------- Paiements ---------- */
views.payments = async () => {
  const list = await api('/admin/payments');
  const valid = list.filter(p => p.status === 'valide');
  shell(`<h1>💰 Paiements & commissions</h1>
  <div class="cards">
    <div class="kpi"><div class="v">${fcfa(valid.reduce((s, p) => s + p.amount, 0))}</div><div class="l">Total encaissé (validé)</div></div>
    <div class="kpi"><div class="v">${fcfa(valid.reduce((s, p) => s + p.commission_amount, 0))}</div><div class="l">Commissions Klean Services</div></div>
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

/* ---------- 💰 Paramètres commerciaux (tout le modèle économique, sans toucher au code) ---------- */
views.commerce = async () => {
  const s = await api('/admin/settings');
  const com = await api('/admin/commissions');
  const plans = await api('/admin/visibilite/plans');
  let cats = [];
  try { cats = (await api('/admin/catalog')).categories; } catch { }
  let niveaux = [];
  try { niveaux = JSON.parse(s.pub_niveaux || '[]'); } catch { }
  const onoff = (k, lb) => `<button class="btn sm ${s[k] === '1' ? '' : 'sec'}" onclick="A.toggleSetting('${k}','${s[k] === '1' ? '0' : '1'}')">${lb} : ${s[k] === '1' ? '🟢 ACTIVÉE' : '🔴 DÉSACTIVÉE'}</button>`;
  const num = (k, label, w = 110) => `<div><label>${label}</label><input type="number" id="cm-${k}" value="${esc(s[k] || '')}" style="width:${w}px" onchange="A.cmNum('${k}')"></div>`;
  shell(`<h1>💰 Paramètres commerciaux</h1>
  <div class="small muted" style="margin-bottom:10px">Modèle Klean Services : <b>prestation → commission obligatoire</b> • <b>visibilité → paiement facultatif</b> • <b>publicité → campagne payante</b> • <b>avis de recherche → gratuit ou payant selon vos réglages</b> • <b>recherche d'emploi → gratuite + mise en avant facultative</b>. Toute modification est journalisée (qui, ancienne et nouvelle valeur).</div>

  <div class="panel"><h2 style="margin-top:0">A. 💰 Commission sur les prestations</h2>
    <div class="frow" style="align-items:flex-end">
      ${onoff('commission_enabled', 'Commission')}
      <div><label>Taux général (%)</label><input type="number" id="cm-commission_rate" value="${esc(s.commission_rate || '25')}" min="0" max="100" style="width:90px" onchange="A.cmNum('commission_rate')"></div>
      <span class="small muted">Exemple à ${esc(s.commission_rate || '25')} % : prestation 40 000 → commission ${Math.round(40000 * parseFloat(s.commission_rate || '25') / 100).toLocaleString('fr-FR')} F, part pro ${(40000 - Math.round(40000 * parseFloat(s.commission_rate || '25') / 100)).toLocaleString('fr-FR')} F. Calcul toujours effectué côté serveur : impossible à contourner.</span>
    </div>
    <h3 class="small" style="margin:12px 0 4px">Règles particulières (la plus prioritaire gagne ; sans règle → taux général)</h3>
    <div class="frow" style="align-items:flex-end;flex-wrap:wrap">
      <div><label>Libellé</label><input id="cr-label" placeholder="Ex : promo entreprises" style="width:140px"></div>
      <div><label>Type de pro</label><select id="cr-protype"><option value="">Tous</option><option value="particulier">Particulier</option><option value="entreprise">Entreprise</option></select></div>
      <div><label>Catégorie</label><select id="cr-cat"><option value="">Toutes</option>${cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div><label>Ville / zone</label><input id="cr-ville" placeholder="Toutes" style="width:110px"></div>
      <div><label>Taux (%)</label><input type="number" id="cr-rate" min="0" max="100" style="width:70px"></div>
      <div><label>Priorité</label><input type="number" id="cr-prio" value="1" style="width:60px"></div>
      <div><label>Du (campagne)</label><input type="date" id="cr-debut"></div>
      <div><label>Au</label><input type="date" id="cr-fin"></div>
      <button class="btn" onclick="A.crAdd()">＋</button>
    </div>
    <table style="margin-top:8px"><tr><th>Libellé</th><th>Type pro</th><th>Catégorie</th><th>Zone</th><th>Taux</th><th>Priorité</th><th>Période</th><th>État</th><th></th></tr>
    ${com.rules.map(r => `<tr><td>${esc(r.label || '—')}</td><td>${r.pro_type || 'Tous'}</td><td>${esc(r.category_name || 'Toutes')}</td><td>${esc(r.ville || 'Toutes')}</td>
      <td><b>${r.rate} %</b></td><td>${r.priority}</td><td class="small">${r.date_debut || '—'} → ${r.date_fin || '—'}</td>
      <td>${r.active ? '<span class="pill ok">Active</span>' : '<span class="pill off">Inactive</span>'}</td>
      <td><button class="btn sm sec" onclick="A.crToggle(${r.id},${r.active ? 0 : 1})">${r.active ? 'Désactiver' : 'Activer'}</button>
      <button class="btn sm warn" onclick="A.crDel(${r.id})">🗑️</button></td></tr>`).join('')}
    ${!com.rules.length ? '<tr><td colspan="9" class="muted">Aucune règle particulière : le taux général s\u2019applique partout.</td></tr>' : ''}</table>
  </div>

  <div class="panel"><h2 style="margin-top:0">B. ⭐ Visibilité professionnelle (toujours facultative)</h2>
    <div class="frow">${onoff('visibilite_enabled', 'Visibilité payante')}
    <span class="small muted">Désactivée : plus aucune offre proposée, les profils restent complets et gratuits, l'historique est conservé.</span></div>
    <div class="frow" style="align-items:flex-end;flex-wrap:wrap;margin-top:8px">
      <div><label>Nom</label><input id="vp-name" placeholder="Visibilité Plus" style="width:140px"></div>
      <div><label>Prix (FCFA)</label><input type="number" id="vp-price" style="width:90px"></div>
      <div><label>Durée (jours)</label><input type="number" id="vp-dur" value="30" style="width:80px"></div>
      <div><label>Niveau (1-3)</label><input type="number" id="vp-level" value="1" min="1" max="3" style="width:70px"></div>
      <div><label>Cible</label><select id="vp-cible"><option value="tous">Tous les pros</option><option value="particulier">Particuliers</option><option value="entreprise">Entreprises</option></select></div>
      <div style="flex:1;min-width:180px"><label>Avantages</label><input id="vp-av" style="width:100%" placeholder="Profil mis en avant, badge…"></div>
      <button class="btn" onclick="A.vpAdd()">＋</button>
    </div>
    <table style="margin-top:8px"><tr><th>Formule</th><th>Prix</th><th>Durée</th><th>Niveau</th><th>Cible</th><th>Avantages</th><th>État</th><th>Actions</th></tr>
    ${plans.map(pl => `<tr><td><b>${esc(pl.name)}</b></td><td>${fcfa(pl.price)}</td><td>${pl.duration_days} j</td><td>${pl.level}</td><td>${pl.cible}</td><td class="small">${esc(pl.avantages || '')}</td>
      <td>${pl.active ? '<span class="pill ok">Active</span>' : '<span class="pill off">Inactive</span>'}</td>
      <td><button class="btn sm sec" onclick="A.vpToggle(${pl.id},${pl.active ? 0 : 1})">${pl.active ? 'Désactiver' : 'Activer'}</button>
      <button class="btn sm sec" onclick="A.vpEdit(${pl.id})">✏️</button>
      <button class="btn sm warn" onclick="A.vpDel(${pl.id})">🗑️</button></td></tr>`).join('')}</table>
  </div>

  <div class="panel"><h2 style="margin-top:0">C. 📣 Campagnes publicitaires</h2>
    <div class="frow" style="align-items:flex-end;flex-wrap:wrap">
      ${onoff('pub_campagnes_enabled', 'Campagnes publicitaires')}
      ${num('pub_max_actives', 'Emplacements simultanés', 90)}
      <div style="min-width:220px"><label>Budgets proposés (FCFA, séparés par des virgules)</label><input id="cm-pub_budgets" value="${esc(s.pub_budgets || '')}" style="width:100%" onchange="A.cmTxt('pub_budgets')"></div>
    </div>
    <div class="small muted" style="margin-top:4px">Au-delà des emplacements disponibles, les campagnes validées entrent en <b>file d'attente</b> et passent en ligne automatiquement quand une place se libère. Le montant personnalisé reste toujours possible côté annonceur.</div>
    <h3 class="small" style="margin:12px 0 4px">Niveaux de priorité (le poids augmente la fréquence de rotation — maximum ×3, jamais de monopole)</h3>
    <table><tr><th>Code</th><th>Libellé</th><th>Poids (1-3)</th><th>Budget minimum (attribution auto)</th><th>Actif</th></tr>
    ${niveaux.map((n, i) => `<tr><td>${esc(n.code)}</td>
      <td><input id="nv-lb-${i}" value="${esc(n.label)}" style="width:110px"></td>
      <td><input type="number" id="nv-po-${i}" value="${n.poids}" min="1" max="3" style="width:60px"></td>
      <td><input type="number" id="nv-mb-${i}" value="${n.min_budget || 0}" style="width:100px"></td>
      <td><input type="checkbox" id="nv-ac-${i}" ${n.actif ? 'checked' : ''}></td></tr>`).join('')}</table>
    <button class="btn sm" style="margin-top:6px" onclick="A.nivSave(${niveaux.length})">Enregistrer les niveaux</button>
  </div>

  <div class="panel"><h2 style="margin-top:0">D. 🔎 Avis de recherche</h2>
    <div class="frow" style="align-items:flex-end;flex-wrap:wrap">
      ${num('avis_prix_normal', 'Avis normal (FCFA, 0 = gratuit)')}
      ${onoff('avis_avant_enabled', 'Formule « Mis en avant »')} ${num('avis_prix_avant', 'Prix mis en avant')}
      ${onoff('avis_urgent_enabled', 'Formule « Urgent »')} ${num('avis_prix_urgent', 'Prix urgent')}
      ${num('avis_duree_jours', 'Durée de publication (jours)', 80)}
    </div>
  </div>

  <div class="panel"><h2 style="margin-top:0">E. 👷 Recherche d'emploi (gratuite de base)</h2>
    <div class="frow" style="align-items:flex-end;flex-wrap:wrap">
      ${onoff('emploi_boost_enabled', 'Mise en avant emploi')}
      ${num('emploi_prix_avant', 'Prix « Mis en avant »')}
      ${num('emploi_prix_prioritaire', 'Prix « Prioritaire »')}
      ${num('emploi_boost_duree_jours', 'Durée (jours)', 80)}
    </div>
    <div class="small muted">La création d'un profil « Je cherche un travail » reste toujours gratuite : seules les options de visibilité sont payantes, et elles peuvent être désactivées ici.</div>
  </div>

  <div class="panel"><h2 style="margin-top:0">🌍 International (préparation)</h2>
    <div class="frow" style="align-items:flex-end">
      <div><label>Pays</label><input id="cm-pays" value="${esc(s.pays || 'CI')}" style="width:70px" onchange="A.cmTxt('pays')"></div>
      <div><label>Devise affichée</label><input id="cm-devise" value="${esc(s.devise || 'FCFA')}" style="width:90px" onchange="A.cmTxt('devise')"></div>
      <span class="small muted">Les règles de commission par <b>zone</b> (section A) permettent déjà des taux différents par ville ou par pays.</span>
    </div>
  </div>`);
};

/* ---------- 📈 Finances & revenus (résumé + historique + encaissements) ---------- */
views.finances = async () => {
  const f = await api('/admin/finances');
  const F = window._fxF || {};
  const qs = Object.entries(F).filter(([, v]) => v).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const trx = await api('/admin/transactions' + (qs ? '?' + qs : ''));
  const camps = await api('/admin/pub/campagnes');
  const subs = await api('/admin/visibilite/subs');
  const pms = await api('/admin/prix-modifs');
  const KL = { commission: '💰 Commission', publicite: '📣 Publicité', visibilite: '⭐ Visibilité', avis_recherche: '🔎 Avis de recherche', emploi: '👷 Emploi', remboursement: '↩️ Remboursement' };
  const STL = { en_attente: '<span class="pill warn">En attente</span>', confirme: '<span class="pill ok">Confirmé</span>', echoue: '<span class="pill off">Échoué</span>', rembourse: '<span class="pill info">Remboursé</span>' };
  const CST = { attente_paiement: '<span class="pill warn">Attente paiement</span>', attente_validation: '<span class="pill warn">À valider</span>', validee: '<span class="pill info">File d\u2019attente</span>', active: '<span class="pill ok">Active</span>', suspendue: '<span class="pill off">Suspendue</span>', refusee: '<span class="pill off">Refusée</span>', expiree: '<span class="pill off">Expirée</span>' };
  shell(`<h1>📈 Finances & revenus</h1>
  <div class="cards">
    <div class="kpi"><div class="v">${fcfa(f.commissions.aujourdhui)}</div><div class="l">💰 Commissions aujourd'hui</div></div>
    <div class="kpi"><div class="v">${fcfa(f.commissions.semaine)}</div><div class="l">💰 Cette semaine</div></div>
    <div class="kpi"><div class="v">${fcfa(f.commissions.mois)}</div><div class="l">💰 Ce mois</div></div>
    <div class="kpi"><div class="v">${fcfa(f.revenu_total)}</div><div class="l">🏦 REVENU TOTAL confirmé</div></div>
  </div>
  <div class="cards">
    <div class="kpi"><div class="v">${f.pub.actives} / ${f.pub.en_attente}</div><div class="l">📢 Pubs actives / en attente — revenus ${fcfa(f.pub.revenus)}</div></div>
    <div class="kpi"><div class="v">${f.visibilite.actifs}</div><div class="l">⭐ Abonnements visibilité — revenus ${fcfa(f.visibilite.revenus)}</div></div>
    <div class="kpi"><div class="v">${f.avis.actifs}</div><div class="l">🔎 Avis actifs — revenus ${fcfa(f.avis.revenus)}</div></div>
    <div class="kpi"><div class="v">${f.emploi.profils_actifs} / ${f.emploi.mis_en_avant}</div><div class="l">👷 Profils emploi / mis en avant — revenus ${fcfa(f.emploi.revenus)}</div></div>
  </div>

  <div class="panel"><h2 style="margin-top:0">📣 Campagnes publicitaires (${camps.filter(c => c.status === 'active').length} actives, ${camps.filter(c => ['attente_paiement', 'attente_validation', 'validee'].includes(c.status)).length} en attente, ${camps.filter(c => c.status === 'expiree').length} expirées, ${camps.filter(c => c.status === 'refusee').length} refusées)</h2>
    <table><tr><th>Annonceur</th><th>Campagne</th><th>Budget</th><th>Durée</th><th>Priorité</th><th>Statut</th><th>Actions</th></tr>
    ${camps.map(c => `<tr><td>${esc(c.user_name)}<div class="small muted">${esc(c.phone || '')}</div></td>
      <td><b>${esc(c.title)}</b><div class="small muted">${esc(c.type)}${c.zone ? ' • ' + esc(c.zone) : ''}${c.end_at && c.status === 'active' ? ' • fin ' + fmtD(c.end_at) : ''}</div></td>
      <td>${fcfa(c.budget)}</td><td>${c.duration_days} j</td><td>${esc(c.priorite)}</td><td>${CST[c.status] || esc(c.status)}</td>
      <td>${c.status === 'attente_paiement' ? `<button class="btn sm" onclick="A.campAct(${c.id},'paiement')">💵 Paiement reçu</button>` : ''}
      ${['attente_validation', 'paiement_confirme'].includes(c.status) ? `<button class="btn sm" onclick="A.campAct(${c.id},'valider')">✅ Valider</button>
        <button class="btn sm warn" onclick="A.campAct(${c.id},'refuser',true)">Refuser</button>` : ''}
      ${c.status === 'active' ? `<button class="btn sm sec" onclick="A.campAct(${c.id},'suspendre',true)">⏸ Suspendre</button>` : ''}
      ${c.status === 'suspendue' ? `<button class="btn sm" onclick="A.campAct(${c.id},'reactiver')">▶️ Réactiver</button>` : ''}
      <button class="btn sm sec" onclick="A.campDuree(${c.id},${c.duration_days})">⏱</button>
      <button class="btn sm warn" onclick="A.campDel(${c.id})">🗑️</button></td></tr>`).join('')}
    ${!camps.length ? '<tr><td colspan="7" class="muted">Aucune campagne pour le moment.</td></tr>' : ''}</table></div>

  <div class="panel"><h2 style="margin-top:0">⭐ Abonnements de visibilité</h2>
    <table><tr><th>Professionnel</th><th>Formule</th><th>Prix</th><th>Période</th><th>Statut</th></tr>
    ${subs.map(sb => `<tr><td>${esc(sb.user_name)}<div class="small muted">${esc(sb.phone || '')}</div></td><td>${esc(sb.plan_name)}</td><td>${fcfa(sb.price)}</td>
      <td class="small">${sb.start_at ? fmtD(sb.start_at) + ' → ' + fmtD(sb.end_at) : '—'}</td>
      <td>${sb.status === 'active' ? '<span class="pill ok">Active</span>' : sb.status === 'attente_paiement' ? '<span class="pill warn">Attente paiement</span>' : `<span class="pill off">${esc(sb.status)}</span>`}</td></tr>`).join('')}
    ${!subs.length ? '<tr><td colspan="5" class="muted">Aucun abonnement. La visibilité payante est facultative : les pros fonctionnent normalement sans.</td></tr>' : ''}</table></div>

  <div class="panel"><h2 style="margin-top:0">💵 Historique financier — toutes les transactions</h2>
    <div class="frow" style="align-items:flex-end;flex-wrap:wrap">
      <div><label>Type</label><select id="fx-kind"><option value="">Tous</option>${Object.entries(KL).map(([k, l]) => `<option value="${k}" ${F.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div><label>Statut</label><select id="fx-status"><option value="">Tous</option>${['en_attente', 'confirme', 'echoue', 'rembourse'].map(x => `<option value="${x}" ${F.status === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div><label>Du</label><input type="date" id="fx-du" value="${F.du || ''}"></div>
      <div><label>Au</label><input type="date" id="fx-au" value="${F.au || ''}"></div>
      <div><label>Recherche (ville, catégorie, nom…)</label><input id="fx-q" value="${esc(F.q || '')}" style="width:170px"></div>
      <button class="btn sm" onclick="A.fxFilter()">Filtrer</button>
    </div>
    <table style="margin-top:8px"><tr><th>Date</th><th>Type</th><th>Détail</th><th>Utilisateur</th><th>Ville</th><th>Montant</th><th>Statut</th><th>Encaissement</th></tr>
    ${trx.map(t => `<tr><td class="small">${fmtD(t.created_at)}</td><td>${KL[t.kind] || esc(t.kind)}</td><td class="small">${esc(t.label)}</td>
      <td>${esc(t.user_name || '—')}</td><td class="small">${esc(t.ville || '—')}</td><td><b>${fcfa(t.amount)}</b></td><td>${STL[t.status] || esc(t.status)}</td>
      <td>${t.status === 'en_attente' ? `<button class="btn sm" onclick="A.trxStatut(${t.id},'confirme')">💵 Paiement reçu</button>
        <button class="btn sm warn" onclick="A.trxStatut(${t.id},'echoue')">Échec</button>` : ''}
      ${t.status === 'confirme' && t.kind !== 'commission' ? `<button class="btn sm sec" onclick="A.trxStatut(${t.id},'rembourse')">↩️ Rembourser</button>` : ''}</td></tr>`).join('')}
    ${!trx.length ? '<tr><td colspan="8" class="muted">Aucune transaction pour ces filtres.</td></tr>' : ''}</table>
    <div class="small muted" style="margin-top:6px">« Paiement reçu » applique automatiquement l'effet associé : activation de la visibilité, passage de la campagne en validation, mise en avant de l'avis ou du profil emploi. Tout est journalisé.</div></div>

  <div class="panel"><h2 style="margin-top:0">✏️ Modifications de prix sur le terrain</h2>
    <table><tr><th>Date</th><th>Mission</th><th>Professionnel</th><th>Client</th><th>Ancien prix</th><th>Nouveau prix</th><th>Motif</th><th>Décision</th></tr>
    ${pms.map(pc => `<tr><td class="small">${fmtD(pc.created_at)}</td><td class="small">${esc(pc.code)}</td><td>${esc(pc.pro_name)}</td><td>${esc(pc.client_name)}</td>
      <td>${fcfa(pc.old_amount)}</td><td><b>${fcfa(pc.new_amount)}</b> <span class="small muted">(${pc.new_amount > pc.old_amount ? '+' : ''}${(pc.new_amount - pc.old_amount).toLocaleString('fr-FR')} F)</span></td>
      <td class="small">${esc(pc.reason)}</td>
      <td>${pc.status === 'accepte' ? '<span class="pill ok">Acceptée</span>' : pc.status === 'refuse' ? '<span class="pill off">Refusée</span>' : '<span class="pill warn">En attente</span>'}</td></tr>`).join('')}
    ${!pms.length ? '<tr><td colspan="8" class="muted">Aucune modification de prix demandée.</td></tr>' : ''}</table></div>`);
};

/* ---------- Publicités ---------- */
views.ads = async () => {
  const list = await api('/admin/ads');
  const s = await api('/admin/settings');
  const annonces = await api('/admin/annonces');
  const villes = await api('/villes');
  const vitesses = { '15': 'Très lente', '30': 'Lente', '60': 'Normale', '120': 'Rapide', '200': 'Très rapide' };
  const TB = { pub: { ic: '📢', lb: 'Pub', pl: 'Publicité' }, info: { ic: 'ℹ️', lb: 'Info', pl: 'Information' }, urgence: { ic: '🚨', lb: 'Urgence', pl: 'Urgence' } };
  const nAct = t => annonces.filter(a => (a.type || 'info') === t && a.active).length;
  const F = window._annFiltre || 'toutes';
  const liste = F === 'toutes' ? annonces : annonces.filter(a => (a.type || 'info') === F);
  const apercu = a => { const t = TB[a.type] || TB.info;
    return `<span style="background:#0b1320;color:${esc(a.color)};padding:3px 10px;border-radius:6px"><b style="${(a.type || 'info') === 'urgence' ? 'color:#ff6b6b' : ''}">${t.ic} ${t.lb}${(a.theme || '').trim() ? ' (' + esc(a.theme) + ')' : ''} :</b> ${esc(a.content || a.title || '')}</span>`; };
  shell(`<h1>📣 Publicités & informations</h1>
  <div class="panel">
    <h2 style="margin-top:0">📺 Bandeau fixe en bas de l'accueil — publicités, informations et urgences (défilement style chaîne info)</h2>
    <div class="frow" style="align-items:center">
      <button class="btn ${s.bandeau_enabled === '1' ? '' : 'sec'}" onclick="A.toggleSetting('bandeau_enabled','${s.bandeau_enabled === '1' ? '0' : '1'}')">Bandeau : ${s.bandeau_enabled === '1' ? 'Activé ✅' : 'Désactivé'}</button>
      <label style="margin:0"><b>Vitesse du défilement :</b></label>
      <select onchange="A.bandeauVitesse(this.value)">
        ${Object.entries(vitesses).map(([v, lb]) => `<option value="${v}" ${s.bandeau_speed === v ? 'selected' : ''}>${lb} (${v} px/s)</option>`).join('')}
        <option value="autre" ${!vitesses[s.bandeau_speed] ? 'selected' : ''}>Personnalisée${!vitesses[s.bandeau_speed] ? ' (' + esc(s.bandeau_speed || '60') + ' px/s)' : '…'}</option>
      </select>
      <span class="small muted">Changement répercuté sur l'accueil en quelques secondes, sans recharger. Boucle sans temps mort, pause au survol/toucher.</span>
    </div>
    <div class="frow" style="margin-top:10px;flex-wrap:wrap">
      <button class="btn sm ${F === 'pub' ? '' : 'sec'}" onclick="A.annFiltre('pub')">📢 Publicités actives : ${nAct('pub')}</button>
      <button class="btn sm ${F === 'info' ? '' : 'sec'}" onclick="A.annFiltre('info')">ℹ️ Informations actives : ${nAct('info')}</button>
      <button class="btn sm ${F === 'urgence' ? '' : 'sec'}" onclick="A.annFiltre('urgence')">🚨 Urgences actives : ${nAct('urgence')}</button>
      <button class="btn sm ${F === 'toutes' ? '' : 'sec'}" onclick="A.annFiltre('toutes')">Toutes (${annonces.length})</button>
    </div>
    <div class="frow" style="align-items:flex-end;flex-wrap:wrap;margin-top:8px">
      <div><label>Type</label><select id="an-type">
        <option value="pub" ${F === 'pub' ? 'selected' : ''}>📢 Publicité</option>
        <option value="info" ${F === 'pub' || F === 'urgence' ? '' : 'selected'}>ℹ️ Information</option>
        <option value="urgence" ${F === 'urgence' ? 'selected' : ''}>🚨 Urgence</option></select></div>
      <div><label>Thème (entre parenthèses)</label><input id="an-theme" placeholder="Sport, Éducation, Paiement…" style="width:160px"></div>
      <div style="flex:1;min-width:200px"><label>Message</label><input id="an-content" style="width:100%" placeholder="Le grand tournoi commence ce samedi…"></div>
      <div><label>Couleur</label><input type="color" id="an-color" value="#ffffff" style="width:50px;height:34px;padding:2px"></div>
      <div><label>Lien (optionnel)</label><input id="an-link" placeholder="#/services ou https://…" style="width:150px"></div>
      <button class="btn" onclick="A.annAdd()">＋ Publier</button>
    </div>
    <div class="small muted" style="margin-top:4px">Inutile d'écrire « Pub », « Info » ou « Urgence » dans le message : l'application l'ajoute automatiquement selon le type choisi → <b>📢 Pub (Sport) : votre message…</b></div>
    <table style="margin-top:10px"><tr><th>Ordre</th><th>Aperçu sur l'accueil</th><th>Lien</th><th>État</th><th>Actions</th></tr>
    ${liste.map(a => { const gi = annonces.indexOf(a); return `<tr>
      <td><button class="btn sm sec" ${gi === 0 ? 'disabled' : ''} onclick="A.annMove(${a.id},-1)">↑</button>
        <button class="btn sm sec" ${gi === annonces.length - 1 ? 'disabled' : ''} onclick="A.annMove(${a.id},1)">↓</button></td>
      <td>${apercu(a)}</td>
      <td class="small">${a.link ? esc(a.link) : '—'}</td>
      <td>${a.active ? '<span class="pill ok">Active</span>' : '<span class="pill off">Inactive</span>'}</td>
      <td><button class="btn sm sec" onclick="A.annToggle(${a.id},${a.active ? 0 : 1})">${a.active ? 'Désactiver' : 'Activer'}</button>
        <button class="btn sm sec" onclick="A.annEdit(${a.id})">✏️</button>
        <button class="btn sm warn" onclick="A.annDel(${a.id})">🗑️</button></td></tr>`; }).join('')}
    ${!liste.length ? '<tr><td colspan="5" class="muted">Aucune publication dans cette catégorie. Ajoutez-en une ci-dessus : elle défilera en bas de l\u2019accueil.</td></tr>' : ''}</table>
  </div>
  <div class="panel">
    <h2 style="margin-top:0">Publier (zone du haut de l'accueil)</h2>
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
    <div class="frow" style="align-items:flex-start;margin-top:8px"><div style="min-width:250px"><label>Zone de diffusion</label>
      <label style="display:block;margin:5px 0"><input type="radio" name="ad-zone-mode" value="all" checked onchange="A.adZoneMode()"> 🌍 Toute la Côte d’Ivoire</label>
      <label style="display:block;margin:5px 0"><input type="radio" name="ad-zone-mode" value="cities" onchange="A.adZoneMode()"> 📍 Une ou plusieurs villes</label>
      <div id="ad-zones-wrap" style="display:none;max-height:185px;overflow:auto;border:1px solid #d9e5e2;border-radius:8px;padding:8px;margin-top:6px">${villes.map(v => `<label style="display:inline-flex;gap:5px;align-items:center;width:220px;padding:3px 0;font-size:13px"><input class="ad-zone" type="checkbox" value="${esc(v)}"> ${esc(v)}</label>`).join('')}</div>
      <div class="small muted">Une publicité ciblée n'est montrée qu'aux comptes dont la ville correspond exactement (les communes d'Abidjan restent distinctes).</div></div></div>
    <div class="small muted">Les images/vidéos trop lourdes sont limitées à 15 Mo. Les publicités s'affichent sans bloquer l'utilisation de l'application.</div>
  </div>
  <div class="panel"><table><tr><th>Type</th><th>Titre</th><th>Contenu</th><th>Emplacement</th><th>Zone de diffusion</th><th>👁️ Vues</th><th>État</th><th>Actions</th></tr>
  ${list.map(a => `<tr><td>${a.type}</td><td><b>${esc(a.title || '')}</b></td>
    <td class="small">${esc((a.content || '').slice(0, 60))} ${a.file ? `<a href="${esc(a.file)}" target="_blank">📎</a>` : ''}</td>
    <td>${a.placement}</td><td class="small">${esc(zonesLabel(a.zones))}</td><td><b>${Number(a.views || 0).toLocaleString('fr-FR')}</b></td><td>${a.active ? '<span class="pill ok">Active</span>' : '<span class="pill off">Inactive</span>'}</td>
    <td><button class="btn sm sec" onclick="A.toggleAd(${a.id},${a.active ? 0 : 1})">${a.active ? 'Désactiver' : 'Activer'}</button>
    <button class="btn sm warn" onclick="A.delAd(${a.id})">🗑️</button></td></tr>`).join('')}
  ${!list.length ? '<tr><td colspan="8" class="muted">Aucune publicité.</td></tr>' : ''}</table></div>`);
};

/* ---------- Messagerie Klean Services ---------- */
/* ---------- Gestion PDG de la bande défilante ---------- */
views.bandeau = async () => {
  const [cfg,items]=await Promise.all([api('/admin/bandeau/config'),api('/admin/annonces')]);
  const msg=items.filter(a=>a.active).map(a=>`${a.icon||'📢'} ${a.content||a.title}`).join('   ◆   ')||'Ajoutez un premier message.';
  shell(`<h1>📺 Gestion bande défilante <span class="pill info">PDG</span></h1>
  <div class="panel"><h2 style="margin-top:0">Aperçu direct de l’accueil</h2><div id="bd-preview" style="height:${cfg.height}px;background:${esc(cfg.background)};color:${esc(cfg.text_color)};border-top:2px solid ${esc(cfg.border_color)};display:flex;align-items:center;overflow:hidden;padding:0 14px;font-size:${cfg.font_size}px;font-weight:${cfg.font_weight};white-space:nowrap">${esc(msg)}</div><div class="small muted mt">L’aperçu réagit aux champs ci-dessous. Après enregistrement, l’accueil applique la configuration automatiquement.</div></div>
  <div class="panel"><h2 style="margin-top:0">Présentation, animation et dimensions</h2><div class="frow" style="flex-wrap:wrap"><label class="check-line" style="margin:0"><input id="bd-enabled" type="checkbox" ${cfg.enabled?'checked':''} onchange="A.bandeauPreview()"> Activer le bandeau</label><div><label>Présentation</label><select id="bd-style" onchange="A.bandeauPreview()"><option value="classic" ${cfg.style==='classic'?'selected':''}>Classique</option><option value="colored" ${cfg.style==='colored'?'selected':''}>Colorée</option><option value="icon" ${cfg.style==='icon'?'selected':''}>Avec icônes</option><option value="image" ${cfg.style==='image'?'selected':''}>Avec image</option><option value="modern" ${cfg.style==='modern'?'selected':''}>Moderne</option></select></div><div><label>Animation</label><select id="bd-animation" onchange="A.bandeauPreview()"><option value="scroll" ${cfg.animation==='scroll'?'selected':''}>Défilement continu</option><option value="slide" ${cfg.animation==='slide'?'selected':''}>Glissement</option><option value="fade" ${cfg.animation==='fade'?'selected':''}>Fondu message par message</option></select></div><div><label>Vitesse (px/s)</label><input id="bd-speed" type="number" value="${cfg.speed}" min="10" max="400" oninput="A.bandeauPreview()" style="width:90px"></div><div><label>Durée fondu (s)</label><input id="bd-duration" type="number" value="${cfg.message_duration}" min="3" max="60" oninput="A.bandeauPreview()" style="width:90px"></div></div>
    <div class="frow" style="flex-wrap:wrap;margin-top:10px"><div><label>Fond</label><input id="bd-bg" type="color" value="${esc(cfg.background)}" onchange="A.bandeauPreview()"></div><div><label>Texte</label><input id="bd-text" type="color" value="${esc(cfg.text_color)}" onchange="A.bandeauPreview()"></div><div><label>Bordure</label><input id="bd-border" type="color" value="${esc(cfg.border_color)}" onchange="A.bandeauPreview()"></div><div><label>Taille texte</label><input id="bd-font-size" type="number" value="${cfg.font_size}" min="10" max="28" oninput="A.bandeauPreview()" style="width:80px"></div><div><label>Graisse</label><select id="bd-weight" onchange="A.bandeauPreview()">${['400','500','600','700','800'].map(v=>`<option value="${v}" ${String(cfg.font_weight)===v?'selected':''}>${v}</option>`).join('')}</select></div><div><label>Hauteur</label><input id="bd-height" type="number" value="${cfg.height}" min="28" max="86" oninput="A.bandeauPreview()" style="width:80px"></div></div><button class="btn mt" onclick="A.saveBandeauConfig()">Enregistrer la configuration</button></div>
  <div class="panel"><h2 style="margin-top:0">Messages, ordre et liens</h2><div class="frow" style="align-items:flex-end;flex-wrap:wrap"><div><label>Type</label><select id="bdm-type"><option value="pub">📢 Publicité</option><option value="info" selected>ℹ️ Information</option><option value="urgence">🚨 Urgence</option></select></div><div><label>Icône (facultative)</label><input id="bdm-icon" maxlength="16" placeholder="📣" style="width:90px"></div><div><label>Thème</label><input id="bdm-theme" maxlength="80" placeholder="Paiement" style="width:120px"></div><div style="flex:1;min-width:190px"><label>Message</label><input id="bdm-content" maxlength="1000" placeholder="Votre message à faire défiler" style="width:100%"></div><div><label>Couleur</label><input id="bdm-color" type="color" value="#ffffff"></div><div><label>Durée (fondu)</label><input id="bdm-duration" type="number" min="3" max="60" value="8" style="width:70px"></div><div><label>Lien</label><input id="bdm-link" maxlength="500" placeholder="#/services ou https://" style="width:150px"></div><div><label>Image (optionnelle)</label><input id="bdm-image" type="file" accept="image/*"></div><button class="btn" onclick="A.bandeauAddFull(this)">＋ Ajouter</button></div>
  <table style="margin-top:12px"><tr><th>Ordre</th><th>Message / aperçu</th><th>Lien</th><th>État</th><th>Actions</th></tr>${items.map((a,i)=>`<tr><td><button class="btn sm sec" ${i===0?'disabled':''} onclick="A.annMove(${a.id},-1)">↑</button><button class="btn sm sec" ${i===items.length-1?'disabled':''} onclick="A.annMove(${a.id},1)">↓</button></td><td><span style="display:inline-flex;align-items:center;gap:5px;background:${esc(cfg.background)};color:${esc(a.color||cfg.text_color)};padding:5px 8px;border-radius:6px">${a.image_url?`<img src="${esc(mediaUrl(a.image_url))}" style="width:22px;height:22px;border-radius:4px;object-fit:cover">`:esc(a.icon||'📢')} <b>${esc(a.theme||'')}</b> ${esc(a.content||a.title)}</span></td><td class="small">${esc(a.link||'—')}</td><td>${a.active?'<span class="pill ok">Actif</span>':'<span class="pill off">Inactif</span>'}</td><td><button class="btn sm sec" onclick="A.annToggle(${a.id},${a.active?0:1})">${a.active?'Désactiver':'Activer'}</button><button class="btn sm sec" onclick="A.bandeauEditFull(${a.id})">✏️</button><button class="btn sm warn" onclick="A.annDel(${a.id})">🗑️</button></td></tr>`).join('')||'<tr><td colspan="5" class="muted">Aucun message : le bandeau reste masqué.</td></tr>'}</table></div>`);
};

/* ---------- Braderie d’articles : pilotage PDG ---------- */
views['voice-search'] = async () => {
  const [cfg,stats]=await Promise.all([api('/admin/voice-search/config'),api('/admin/voice-search/stats?period=month')]);
  shell(`<h1>🎤 Recherche vocale <span class="pill info">PDG</span></h1><div class="cards"><div class="kpi"><div class="v">${stats.total||0}</div><div class="l">Analyses ce mois</div></div><div class="kpi"><div class="v">${stats.by_state&&stats.by_state.matched||0}</div><div class="l">Correspondances fiables</div></div><div class="kpi"><div class="v">${(stats.by_state&&stats.by_state.no_match||0)+(stats.by_state&&stats.by_state.uncertain||0)+(stats.by_state&&stats.by_state.error||0)}</div><div class="l">À améliorer</div></div></div><div class="panel"><h2 style="margin-top:0">Activation, confidentialité et limite</h2><label class="check-line"><input id="vs-enabled" type="checkbox" ${cfg.enabled?'checked':''}> Recherche vocale activée</label><label class="check-line"><input id="vs-home-visible" type="checkbox" ${cfg.home_visible?'checked':''}> Afficher le microphone sur l’accueil</label><label class="check-line"><input id="vs-store-text" type="checkbox" ${cfg.store_text?'checked':''}> Conserver le texte reconnu pour améliorer les statistiques <span class="small muted">(jamais l’audio)</span></label><div class="field" style="max-width:230px"><label>Durée maximale (secondes)</label><input id="vs-max" type="number" min="1" max="25" value="${Number(cfg.max_seconds)}"><div class="small muted">Le navigateur est aussi arrêté techniquement à cette durée. Maximum : 25 secondes.</div></div><button class="btn" onclick="A.saveVoiceSearchConfig()">Enregistrer</button></div><div class="panel"><h2 style="margin-top:0">Reconnaissances à améliorer</h2><div class="small muted mb">Les associations utilisent le dictionnaire central des métiers, catégories, sous-catégories, prestations, tâches, synonymes et localités. Aucun vocabulaire parallèle n’est créé ici.</div><table><tr><th>Texte ${cfg.store_text?'reconnu':'masqué par le réglage confidentialité'}</th><th>Localité détectée</th><th>Résultat</th><th>Date</th></tr>${(stats.errors||[]).map(e=>`<tr><td>${cfg.store_text?esc(e.transcript||'—'):'—'}</td><td>${esc([e.recognized_city,e.recognized_commune].filter(Boolean).join(' · ')||'—')}</td><td>${esc(e.result_state)}</td><td class="small">${fmtD(e.created_at)}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">Aucune erreur ou incertitude sur cette période.</td></tr>'}</table><div class="hint mt">Pour enrichir les expressions ivoiriennes, synonymes ou associations, utilisez le <b>Dictionnaire de recherche</b> du catalogue central.</div></div>`);
};

views.braderie = async () => {
  const subscriptionPeriod=window._bradSubscriptionPeriod||'month';
  const [cfg,stats,items,reports,contacts,categories,alerts,plans,spaces,subs,subscriptionStats]=await Promise.all([api('/admin/braderie/config'),api('/admin/braderie/stats?period=month'),api('/admin/braderie/items'),api('/admin/braderie/reports'),api('/admin/braderie/contacts'),api('/admin/braderie/categories'),api('/admin/braderie/alerts'),api('/admin/braderie/plans'),api('/admin/braderie/spaces'),api('/admin/braderie/subscriptions'),api('/admin/braderie/subscription-stats?period='+subscriptionPeriod)]);
  const subPill=s=>`<span class="pill ${s==='active'?'ok':s==='pending_payment'||s==='payment_confirmed'?'warn':'off'}">${esc({pending_payment:'Attente paiement',payment_confirmed:'Paiement confirmé',active:'Actif',expired:'Expiré',suspended:'Suspendu',cancelled:'Annulé'}[s]||s)}</span>`;
  const pill=s=>`<span class="pill ${s==='available'||s==='sold'?'ok':s==='pending'?'warn':'off'}">${esc({pending:'À valider',available:'Disponible',sold:'Vendu',suspended:'Suspendu',expired:'Expiré',rejected:'Refusé',deleted:'Retiré'}[s]||s)}</span>`;
  shell(`<h1>🏷️ Braderie d’articles <span class="pill info">PDG</span></h1><div class="cards"><div class="kpi"><div class="v">${stats.total||0}</div><div class="l">Articles historisés</div></div><div class="kpi"><div class="v">${stats.created||0}</div><div class="l">Publications ce mois</div></div><div class="kpi"><div class="v">${stats.sold||0}</div><div class="l">Vendus ce mois</div></div><div class="kpi"><div class="v">${stats.offers||0}</div><div class="l">Propositions ce mois</div></div><div class="kpi"><div class="v">${stats.pending_reports||0}</div><div class="l">Signalements à traiter</div></div><div class="kpi"><div class="v">${stats.pending_contacts||0}</div><div class="l">Contacts à gérer</div></div></div>
  <div class="panel"><h2 style="margin-top:0">💳 Espaces vendeurs, abonnements et recettes</h2><div class="frow" style="flex-wrap:wrap"><b>Période statistiques :</b>${[['day','Jour'],['week','Semaine'],['month','Mois'],['year','Année']].map(([v,l])=>`<button class="btn sm ${subscriptionPeriod===v?'':'sec'}" onclick="A.bradSubPeriod('${v}')">${l}</button>`).join('')}</div><div class="cards" style="margin-top:10px"><div class="kpi"><div class="v">${subscriptionStats.spaces_total||0}</div><div class="l">Espaces · ${subscriptionStats.spaces_created||0} créés</div></div><div class="kpi"><div class="v">${subscriptionStats.subscriptions.active||0}</div><div class="l">Abonnements actifs</div></div><div class="kpi"><div class="v">${subscriptionStats.subscriptions.expired||0}</div><div class="l">Abonnements expirés</div></div><div class="kpi"><div class="v">${subscriptionStats.renewals||0}</div><div class="l">Renouvellements</div></div><div class="kpi"><div class="v">${fcfa(subscriptionStats.revenue||0)}</div><div class="l">Recettes confirmées</div></div><div class="kpi"><div class="v">${subscriptionStats.articles_published||0} / ${subscriptionStats.articles_sold||0}</div><div class="l">Articles publiés / vendus</div></div></div><div class="small muted mt">Statut : ${subscriptionStats.subscriptions.pending_payment||0} paiement(s) en attente · ${subscriptionStats.subscriptions.payment_confirmed||0} confirmé(s) programmé(s) · ${subscriptionStats.subscriptions.suspended||0} suspendu(s) · ${subscriptionStats.subscriptions.cancelled||0} annulé(s).</div></div>
  <div class="panel"><div class="row"><h2 style="margin:0" class="grow">Formules vendeur configurables</h2><button class="btn" onclick="A.bradPlanEdit()">＋ Créer une formule</button></div><div class="small muted mt">Les tarifs et limites sont définis ici, jamais dans le code. Toute souscription garde l’instantané historique de la formule choisie.</div><table><tr><th>Formule</th><th>Prix et promotion</th><th>Quotas / médias</th><th>Visibilité</th><th>Actions</th></tr>${plans.map(p=>`<tr><td><b>${esc(p.name)}</b><br><span class="small muted">${esc(p.description||'—')}</span></td><td>3 mois : <b>${fcfa(p.quarterly.amount)}</b>${p.quarterly.promotion?' · promo':''}<br>12 mois : <b>${fcfa(p.annual.amount)}</b>${p.annual.promotion?' · promo':''}<br><span class="small ok">Économie annuelle : ${fcfa(p.annual_saving||0)}</span></td><td class="small">${p.publication_quota} publication(s)<br>${p.active_items_quota} article(s) actif(s)<br>${p.photos_per_item} photo(s) / article<br>${p.videos_allowed?`${p.videos_per_item} vidéo(s), ${p.video_max_seconds}s, ${Math.round(p.video_max_bytes/1048576)} Mo`:'Vidéos non autorisées'}</td><td>${p.active?'<span class="pill ok">Active</span>':'<span class="pill off">Inactive</span>'} ${p.visible?'<span class="pill info">Visible</span>':'<span class="pill off">Masquée</span>'}</td><td><button class="btn sm sec" onclick="A.bradPlanEdit(${p.id})">Modifier</button><button class="btn sm sec" onclick="A.bradPlanHistory(${p.id})">Historique (${p.history_count||0})</button></td></tr>`).join('')||'<tr><td colspan="5" class="muted">Aucune formule. Créez une formule avant de l’ouvrir à la souscription.</td></tr>'}</table></div>
  <div class="panel"><h2 style="margin-top:0">Espaces, suspensions et attributions</h2><table><tr><th>Espace / propriétaire</th><th>Formule active</th><th>Articles actifs</th><th>État</th><th>Actions traçables</th></tr>${spaces.map(s=>`<tr><td><b>${esc(s.name)}</b><br><span class="small">${esc(s.owner_name)} · ${esc(s.owner_phone||'')}</span></td><td>${esc(s.plan_name||'—')}${s.end_at?`<br><span class="small muted">jusqu’au ${fmtD(s.end_at)}</span>`:''}</td><td>${s.active_items||0}</td><td>${subPill(s.status)}</td><td><button class="btn sm sec" onclick="A.bradSpaceAction(${s.id},'${s.status==='suspended'?'reactivate':'suspend'}')">${s.status==='suspended'?'Réactiver':'Suspendre'}</button><button class="btn sm" onclick="A.bradGrant(${s.id})">Attribuer / promo</button><button class="btn sm warn" onclick="A.bradSpaceAction(${s.id},'cancel')">Annuler</button></td></tr>`).join('')||'<tr><td colspan="5" class="muted">Aucun espace vendeur.</td></tr>'}</table></div>
  <div class="panel"><h2 style="margin-top:0">Paiements, renouvellements et prolongations</h2><table><tr><th>Vendeur / espace</th><th>Formule / période</th><th>Montant / moyen</th><th>Dates</th><th>État</th><th>Actions</th></tr>${subs.map(s=>`<tr><td><b>${esc(s.owner_name)}</b><br><span class="small muted">${esc(s.space_name)}</span></td><td>${esc(s.plan_name)}<br><span class="small muted">${s.billing_period==='annual'?'Annuel':'Trimestriel'} · ${esc(s.source)}</span></td><td><b>${fcfa(s.amount)}</b><br><span class="small muted">${esc(s.transaction_method||'—')}</span></td><td class="small">${s.start_at?`${fmtD(s.start_at)} → ${fmtD(s.end_at)}`:'—'}</td><td>${subPill(s.status)}${s.transaction_status?`<br><span class="small muted">Transaction : ${esc(s.transaction_status)}</span>`:''}</td><td>${s.status==='pending_payment'&&s.transaction_id?`<button class="btn sm" onclick="A.bradConfirmPayment(${s.transaction_id})">💵 Confirmer paiement</button>`:''}<button class="btn sm sec" onclick="A.bradExtend(${s.id})">⏱ Prolonger</button></td></tr>`).join('')||'<tr><td colspan="6" class="muted">Aucun abonnement.</td></tr>'}</table><div class="small muted mt">La confirmation de paiement appelle le même contrôle serveur que l’historique financier ; l’activation ne se produit qu’après cette confirmation.</div></div>
  <div class="panel"><h2 style="margin-top:0">Activation, diffusion et limites</h2><div class="frow" style="flex-wrap:wrap"><label class="check-line"><input id="br-enabled" type="checkbox" ${cfg.enabled?'checked':''}> Braderie opérationnelle</label><label class="check-line"><input id="br-home-visible" type="checkbox" ${cfg.home_visible?'checked':''}> Afficher l’entrée sur l’accueil</label><label class="check-line"><input id="br-require" type="checkbox" ${cfg.require_conditions?'checked':''}> Conditions obligatoires</label><label class="check-line"><input id="br-hide-link" type="checkbox" ${cfg.hide_external_link?'checked':''}> Masquer aussi le lien externe</label><label class="check-line"><input id="br-quartier-required" type="checkbox" ${cfg.quartier_required?'checked':''}> Quartier obligatoire</label><label class="check-line"><input id="br-alerts-enabled" type="checkbox" ${cfg.alerts_enabled?'checked':''}> Alertes acheteurs actives</label></div><div class="frow" style="flex-wrap:wrap"><b>Diffusion autorisée :</b><label class="check-line"><input id="br-geo-city" type="checkbox" ${cfg.geo_modes.city?'checked':''}> Ville</label><label class="check-line"><input id="br-geo-national" type="checkbox" ${cfg.geo_modes.national?'checked':''}> Côte d’Ivoire</label><label class="check-line"><input id="br-geo-abidjan" type="checkbox" ${cfg.geo_modes.abidjan?'checked':''}> Abidjan</label><label class="check-line"><input id="br-geo-commune" type="checkbox" ${cfg.geo_modes.commune?'checked':''}> Commune</label></div><div class="frow" style="flex-wrap:wrap"><div><label>Publications / client</label><input id="br-client-max" type="number" min="1" value="${cfg.max_per_client}" style="width:100px"></div><div><label>Publications plateforme</label><input id="br-platform-max" type="number" min="1" value="${cfg.max_platform}" style="width:110px"></div><div><label>Période publication</label><select id="br-period"><option value="day" ${cfg.limit_period==='day'?'selected':''}>Jour</option><option value="week" ${cfg.limit_period==='week'?'selected':''}>Semaine</option><option value="month" ${cfg.limit_period==='month'?'selected':''}>Mois</option><option value="year" ${cfg.limit_period==='year'?'selected':''}>Année</option></select></div><div><label>Photos max.</label><input id="br-photos-max" type="number" min="1" max="8" value="${cfg.max_photos}" style="width:80px"></div><div><label>Propositions max.</label><input id="br-offer-max" type="number" min="1" value="${cfg.offer_limit}" style="width:100px"></div><div><label>Période propositions</label><select id="br-offer-period"><option value="day" ${cfg.offer_period==='day'?'selected':''}>Jour</option><option value="week" ${cfg.offer_period==='week'?'selected':''}>Semaine</option><option value="month" ${cfg.offer_period==='month'?'selected':''}>Mois</option><option value="year" ${cfg.offer_period==='year'?'selected':''}>Année</option></select></div><div><label>Expiration (jours)</label><input id="br-expiry" type="number" min="1" max="365" value="${cfg.expiry_days}" style="width:85px"></div><div><label>Contact</label><select id="br-contact"><option value="klean" ${cfg.contact_mode==='klean'?'selected':''}>Via Klean Services</option><option value="direct" ${cfg.contact_mode==='direct'?'selected':''}>Direct vendeur</option></select></div></div><div><label>Conditions de publication</label><textarea id="br-conditions" maxlength="4000">${esc(cfg.conditions)}</textarea><label class="check-line"><input id="br-purchase-enabled" type="checkbox" ${cfg.purchase_conditions_enabled?'checked':''}> Publier les conditions d’achat</label><label class="check-line"><input id="br-purchase-require" type="checkbox" ${cfg.purchase_confirmation_required?'checked':''}> Confirmation obligatoire avant offre ou demande de contact</label><label>Conditions d’achat</label><textarea id="br-purchase-conditions" maxlength="4000">${esc(cfg.purchase_conditions)}</textarea></div><button class="btn" onclick="A.saveBraderieConfig()">Enregistrer les règles</button><div class="small muted mt">Les quotas, validation, confidentialité et états sont appliqués par le serveur. La ville de l’article provient de la source centrale, indépendamment de la ville d’inscription du vendeur.</div></div>
  <div class="panel"><h2 style="margin-top:0">Catégories et sous-références d’articles</h2><div class="frow"><input id="brc-name" maxlength="120" placeholder="Nouvelle catégorie / sous-référence" style="flex:1"><select id="brc-parent"><option value="">Sans parent (catégorie)</option>${categories.map(c=>`<option value="${c.id}">${esc(c.parent_name?'↳ ':'')}${esc(c.name)}</option>`).join('')}</select><input id="brc-icon" maxlength="16" value="🏷️" style="width:65px"><input id="brc-image" maxlength="500" placeholder="URL image (facultatif)" style="flex:1"><button class="btn" onclick="A.bradCategoryCreate()">Ajouter</button></div><table><tr><th>Référence</th><th>Description</th><th>Ordre</th><th>État</th><th></th></tr>${categories.map(c=>`<tr><td>${c.parent_id?'↳ ':''}${esc(c.icon||'🏷️')} <b>${esc(c.name)}</b>${c.parent_name?`<br><span class="small muted">Sous : ${esc(c.parent_name)}</span>`:''}</td><td class="small">${esc(c.description||'—')}<br><span class="muted">${(c.visibility_modes||[]).length?'Diffusion : '+esc((c.visibility_modes||[]).join(', ')):'Diffusion : globale'}</span></td><td>${Number(c.sort||0)}</td><td><span class="pill ${c.active?'ok':'off'}">${c.active?'Active':'Désactivée'}</span></td><td><button class="btn sm sec" onclick="A.bradCategoryEdit(${c.id})">Modifier</button><button class="btn sm warn" onclick="A.bradCategoryDelete(${c.id})">Supprimer</button></td></tr>`).join('')||'<tr><td colspan="5" class="muted">Aucune catégorie.</td></tr>'}</table></div>
  <div class="panel"><h2 style="margin-top:0">Alertes acheteurs</h2><div class="small muted">${alerts.length} alerte(s) enregistrée(s). Les notifications ne sont envoyées qu’aux comptes dont le périmètre et les catégories correspondent.</div><table><tr><th>Compte</th><th>Zone</th><th>Références</th><th>État</th></tr>${alerts.map(a=>`<tr><td>${esc(a.user_name)}<br><span class="small muted">${esc(a.user_city||'')}</span></td><td>${esc(a.scope)} · ${esc(a.city||a.commune||'Toutes')}</td><td class="small">${a.category_ids.length?a.category_ids.join(', '):'Toutes'}</td><td><span class="pill ${a.active?'ok':'off'}">${a.active?'Active':'Suspendue'}</span></td></tr>`).join('')||'<tr><td colspan="4" class="muted">Aucune alerte.</td></tr>'}</table></div>
  <div class="panel"><h2 style="margin-top:0">Articles et validation</h2><table><tr><th>Article</th><th>Vendeur / ville</th><th>Prix / état</th><th>État</th><th>Actions</th></tr>${items.map(i=>`<tr><td><b>${esc(i.title)}</b><br><span class="small muted">${esc(i.description).slice(0,110)}</span></td><td>${esc(i.seller_name)}<br><span class="small muted">${esc(i.city)} · ${esc(i.seller_phone||'—')}</span></td><td><b>${fcfa(i.price)}</b><br><span class="small muted">${esc({neuf:'Neuf',tres_bon:'Très bon',bon:'Bon',a_reparer:'À réparer'}[i.item_condition]||i.item_condition)}</span></td><td>${pill(i.status)}</td><td><button class="btn sm sec" onclick="A.bradAdminEdit(${i.id})">✏️ Modifier</button>${i.status==='pending'?`<button class="btn sm" onclick="A.bradAdminStatus(${i.id},'available')">Valider</button><button class="btn sm warn" onclick="A.bradAdminStatus(${i.id},'rejected')">Refuser</button>`:''}${i.status==='available'?`<button class="btn sm warn" onclick="A.bradAdminStatus(${i.id},'suspended')">Suspendre</button>`:''}${['sold','suspended','expired'].includes(i.status)?`<button class="btn sm" onclick="A.bradAdminReactivate(${i.id})">Réactiver</button>`:''}<button class="btn sm sec" onclick="A.bradAdminStatus(${i.id},'deleted')">Retirer</button></td></tr>`).join('')||'<tr><td colspan="5" class="muted">Aucun article.</td></tr>'}</table></div>
  <div class="panel"><h2 style="margin-top:0">Signalements et fraudes</h2><table><tr><th>Article / auteur</th><th>Motif</th><th>Date</th><th>Décision</th></tr>${reports.map(r=>`<tr><td><b>${esc(r.title)}</b><br><span class="small">${esc(r.reporter_name)} → vendeur ${esc(r.seller_name)}</span></td><td>${esc(r.reason)}<br><span class="small muted">${esc(r.details||'')}</span></td><td class="small">${fmtD(r.created_at)}</td><td>${esc(r.status)} ${r.status==='pending'?`<button class="btn sm" onclick="A.bradAdminReport(${r.id},'actioned')">Traité</button><button class="btn sm sec" onclick="A.bradAdminReport(${r.id},'dismissed')">Classer</button>`:''}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">Aucun signalement.</td></tr>'}</table></div>
  <div class="panel"><h2 style="margin-top:0">Demandes de contact via Klean Services</h2><table><tr><th>Article</th><th>Demande</th><th>Parties</th><th>État / action</th></tr>${contacts.map(c=>`<tr><td><b>${esc(c.title)}</b></td><td>${esc(c.message)}</td><td>${esc(c.buyer_name)}<br><span class="small muted">${esc(c.buyer_phone)}</span><br>→ ${esc(c.seller_name)}<br><span class="small muted">${esc(c.seller_phone)}</span></td><td>${esc(c.status)} ${c.status==='pending'?`<button class="btn sm" onclick="A.bradAdminContact(${c.id},'approved')">Transmettre</button><button class="btn sm warn" onclick="A.bradAdminContact(${c.id},'rejected')">Refuser</button>`:''}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">Aucune demande.</td></tr>'}</table></div>`);
};

views.support = async () => {
  const list = await api('/admin/support/conversations');
  const subject = window._supportFilter || 'toutes';
  const rows = subject === 'toutes' ? list : list.filter(c => c.subject === subject);
  const label = c => c.subject === 'suggestion' ? '💡 Suggestion' : '⚠️ Préoccupation';
  shell(`<h1>📩 Messages Klean Services</h1><div class="panel"><div class="small muted" style="margin-bottom:10px">Conversations directes des clients. Les réponses sont synchronisées immédiatement dans leur application.</div>
    <div class="frow"><button class="btn sm ${subject === 'toutes' ? '' : 'sec'}" onclick="A.supportFilter('toutes')">Toutes (${list.length})</button><button class="btn sm ${subject === 'suggestion' ? '' : 'sec'}" onclick="A.supportFilter('suggestion')">💡 Suggestions (${list.filter(c => c.subject === 'suggestion').length})</button><button class="btn sm ${subject === 'preoccupation' ? '' : 'sec'}" onclick="A.supportFilter('preoccupation')">⚠️ Préoccupations (${list.filter(c => c.subject === 'preoccupation').length})</button></div>
    <table style="margin-top:12px"><tr><th>Type</th><th>Client</th><th>Dernier message</th><th>État</th><th>Mis à jour</th><th></th></tr>
      ${rows.map(c => `<tr><td>${label(c)}</td><td><b>${esc(c.user_name)}</b><br><span class="small muted">${esc(c.user_phone || '')} • ${esc(c.user_ville || '')}</span></td><td class="small">${c.last_type === 'audio' ? '🎤 Message vocal' : esc((c.last_content || '').slice(0, 120))}</td><td>${c.status === 'ouverte' ? '<span class="pill ok">Ouverte</span>' : '<span class="pill off">Fermée</span>'}</td><td class="small">${fmtD(c.last_at || c.updated_at)}</td><td><button class="btn sm" onclick="A.supportOpen(${c.id})">Ouvrir</button></td></tr>`).join('')}
      ${!rows.length ? '<tr><td colspan="6" class="muted">Aucune conversation.</td></tr>' : ''}</table></div>`);
};

/* ---------- Messages généraux ciblables ---------- */
views.broadcast = async () => {
  const [list, villes] = await Promise.all([api('/admin/general-messages'), api('/admin/villes')]);
  const st = { draft:'Brouillon', scheduled:'Programmé', sent:'Envoyé', cancelled:'Annulé' };
  shell(`<h1>📨 Messages généraux</h1>
  <div class="panel"><div class="small muted mb">Les destinataires sont calculés et enregistrés côté serveur, sans doublon. « Notification enregistrée » signifie qu’elle est dans l’application ; la livraison système (push) dépend des autorisations de l’appareil.</div>
    <div class="frow"><div style="flex:1"><label>Titre</label><input id="gm-title" maxlength="160" style="width:100%" placeholder="Ex : Information importante"></div></div>
    <div class="frow"><div style="flex:1"><label>Message</label><textarea id="gm-body" maxlength="2000" placeholder="Votre message…"></textarea></div></div>
    <div class="frow" style="align-items:flex-start"><div><label>Destinataires</label><label class="check-line"><input id="gm-clients" type="checkbox"> Clients</label><label class="check-line"><input id="gm-pros" type="checkbox"> Professionnels validés</label><div class="small muted">Aucune case : tous les comptes utilisateur.</div></div>
    <div style="min-width:220px;flex:1"><label>Villes <span class="small muted">(aucune = toutes)</span></label><select id="gm-cities" multiple size="5" style="width:100%">${villes.map(v=>`<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('')}</select></div>
    <div><label>Programmation</label><input type="datetime-local" id="gm-date"><div class="small muted">Heure locale du serveur</div></div></div>
    <div class="btn-row"><button class="btn sec" onclick="A.generalMessage('draft')">💾 Enregistrer brouillon</button><button class="btn outline" onclick="A.previewGeneralMessage()">👁️ Prévisualiser</button><button class="btn" onclick="A.generalMessage('immediate')">📨 Envoyer maintenant</button><button class="btn outline" onclick="A.generalMessage('scheduled')">🕒 Programmer</button></div></div>
  <div class="panel"><h2 style="margin-top:0">Historique</h2><table><tr><th>Message</th><th>Ciblage</th><th>État / livraison</th><th>Date</th><th></th></tr>
  ${list.map(m=>`<tr><td><b>${esc(m.title)}</b><br><span class="small muted">${esc((m.body||'').slice(0,120))}</span></td><td class="small">${m.account_types.length ? m.account_types.join(', ') : 'Tous'}<br>${m.cities.length ? m.cities.join(', ') : 'Toutes les villes'}</td><td><span class="pill ${m.status==='sent'?'ok':m.status==='draft'?'info':'warn'}">${st[m.status]||esc(m.status)}</span><br><span class="small muted">${m.status==='sent' ? `${m.delivered_count}/${m.target_count} notification(s) enregistrée(s) • lues : ${m.read_count}` : ''}</span></td><td class="small">${fmtD(m.sent_at||m.scheduled_at||m.created_at)}</td><td>${m.status==='draft'?`<button class="btn sm sec" onclick="A.editGeneralMessage(${m.id})">Modifier</button> <button class="btn sm" onclick="A.sendGeneralMessage(${m.id})">Envoyer</button> <button class="btn sm warn" onclick="A.deleteGeneralMessage(${m.id})">Supprimer</button>`:''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Aucun message général.</td></tr>'}</table></div>`);
};

/* ---------- Règles ---------- */
views.rules = async () => {
  const [s, about] = await Promise.all([api('/admin/settings'), ME && ME.role === 'pdg' ? api('/admin/about') : Promise.resolve(null)]);
  shell(`<h1>📜 Règles & conditions</h1>
  <div class="panel"><h2 style="margin-top:0">Règles client</h2><textarea class="rules-ta" id="r-client">${esc(s.rules_client || '')}</textarea><button class="btn" style="margin-top:8px" onclick="A.saveRules('rules_client','r-client')">Enregistrer les règles client</button></div>
  <div class="panel"><h2 style="margin-top:0">Règles professionnel</h2><textarea class="rules-ta" id="r-pro">${esc(s.rules_pro || '')}</textarea><button class="btn" style="margin-top:8px" onclick="A.saveRules('rules_pro','r-pro')">Enregistrer les règles professionnel</button></div>
  ${about ? `<div class="panel"><h2 style="margin-top:0">ℹ️ À propos de Klean Services <span class="pill info">Paramètre PDG</span></h2><div class="small muted mb">Le brouillon n’est visible dans l’application qu’après publication. Ajoutez, modifiez ou supprimez des paragraphes avant l’aperçu.</div><label>Titre</label><input id="about-title" style="width:100%" value="${esc(about.title||'')}"><div id="about-paragraphs">${about.draft.map((p,i)=>aboutParagraphHtml(p,i)).join('')}</div><div class="btn-row mt"><button class="btn sec" onclick="A.addAboutParagraph()">＋ Paragraphe</button><button class="btn outline" onclick="A.previewAbout()">👁️ Aperçu du brouillon</button><button class="btn" onclick="A.saveAbout(false)">💾 Enregistrer le brouillon</button><button class="btn" onclick="A.saveAbout(true)">📢 Publier</button></div><div class="small muted mt">Dernière publication : ${about.published_at ? fmtD(about.published_at) : 'jamais'}</div><div style="border-top:1px solid #e4eeeb;margin-top:14px;padding-top:12px"><h3 style="margin:0 0 8px">↗️ Partager l’application</h3><label>Lien officiel (https://…)</label><input id="share-url" style="width:100%" value="${esc(s.share_official_url||'')}" placeholder="https://votre-domaine…"><label style="margin-top:8px">Texte de partage</label><textarea id="share-text" maxlength="500">${esc(s.share_text||'Découvrez Klean Services : exprimez votre besoin, un professionnel arrive.')}</textarea><button class="btn sec mt" onclick="A.saveShareSettings()">Enregistrer le partage</button></div></div>` : ''}
  <div class="panel small muted">Ces textes sont affichés et doivent être acceptés : à la création d'un compte (règles client) et lors de la demande professionnelle (règles professionnel). L'acceptation est enregistrée avec la date.</div>`);
};
function aboutParagraphHtml(p = {}, i = 0) { return `<div class="about-row" style="border:1px solid #dce9e6;border-radius:10px;padding:10px;margin-top:9px"><div class="frow"><div style="flex:1"><label class="small">Intertitre (facultatif)</label><input class="about-heading" style="width:100%" value="${esc(p.heading||'')}" placeholder="Ex : Notre objectif"></div><button class="btn sm warn" style="align-self:end" onclick="this.closest('.about-row').remove()">Supprimer</button></div><label class="small">Paragraphe</label><textarea class="about-text" maxlength="4000">${esc(p.text||'')}</textarea></div>`; }
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

/* ---------- Échanges & fichiers, organisés par client ---------- */
views.files = async () => {
  const q = sessionStorage.getItem('adm_fq') || '';
  const type = sessionStorage.getItem('adm_ft') || 'all';
  const from = sessionStorage.getItem('adm_ffrom') || '';
  const to = sessionStorage.getItem('adm_fto') || '';
  const page = Math.max(1, parseInt(sessionStorage.getItem('adm_fp') || '1', 10));
  const d = await api('/admin/files/clients?q=' + encodeURIComponent(q) + '&type=' + encodeURIComponent(type) + '&from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to) + '&page=' + page);
  const typeLabel = { all: 'Tous les contenus', texte: 'Textes', audio: 'Audios / vocaux', image: 'Images / photos' };
  shell(`<h1>🗄️ Échanges & fichiers par client</h1>
  <div class="cards">
    <div class="kpi"><div class="v">${d.total_clients}</div><div class="l">Clients avec contenu</div></div>
    <div class="kpi"><div class="v">${d.total}</div><div class="l">Fichiers stockés</div></div>
    <div class="kpi"><div class="v">${(d.total_size / 1048576).toFixed(1)} Mo</div><div class="l">Espace utilisé</div></div>
    <div class="kpi"><div class="v">${d.retention_days} j</div><div class="l">Durée de conservation</div></div>
  </div>
  <div class="panel"><div class="small muted" style="margin-bottom:12px">Rechercher un client, puis consulter ses messages, vocaux et photos. Les téléchargements sont générés côté serveur et arrivent dans le dossier Téléchargements du navigateur.</div>
    <div class="frow"><div style="min-width:250px;flex:1"><label>Recherche : client, téléphone ou texte d’un message</label><input id="files-q" value="${esc(q)}" placeholder="Ex : Dangbé, fuite, rendez-vous…" style="width:100%"></div>
      <div><label>Type de contenu</label><select id="files-type">${Object.entries(typeLabel).map(([v,l]) => `<option value="${v}" ${type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div><label>Du</label><input type="date" id="files-from" value="${esc(from)}"></div><div><label>Au</label><input type="date" id="files-to" value="${esc(to)}"></div>
      <button class="btn" onclick="A.filesSearch()">🔎 Rechercher</button><button class="btn sec" onclick="A.filesReset()">Réinitialiser</button></div>
  </div>
  <div class="panel"><table><tr><th>Client</th><th>Localisation</th><th>Textes</th><th>Vocaux</th><th>Photos</th><th>Dernière activité</th><th>Actions</th></tr>
  ${d.clients.map(c => { const latest = c.items && c.items[0]; return `<tr><td><b>${esc(c.name)}</b><br><span class="small muted">${esc(c.phone || '')}</span></td>
    <td class="small">${esc(c.ville || '—')}${c.quartier ? '<br>' + esc(c.quartier) : ''}</td>
    <td>💬 <b>${c.texts}</b></td><td>🎤 <b>${c.audios}</b></td><td>🖼️ <b>${c.images}</b></td>
    <td class="small">${latest ? `${fmtD(latest.created_at)}<br><span class="muted">${esc(latest.label)}</span>` : '—'}</td>
    <td style="white-space:nowrap"><button class="btn sm sec" onclick="A.openClientFiles(${c.id})">Voir</button> <button class="btn sm" onclick="A.downloadClient(${c.id})">⬇ Télécharger</button></td></tr>`; }).join('')}
  ${!d.clients.length ? '<tr><td colspan="7" class="muted">Aucun client ou contenu ne correspond à cette recherche.</td></tr>' : ''}</table>
  ${d.pages > 1 ? `<div class="frow" style="margin:14px 0 0;align-items:center"><button class="btn sm sec" ${d.page <= 1 ? 'disabled' : ''} onclick="A.filesPage(${d.page - 1})">← Précédent</button><span class="small muted">Page ${d.page} / ${d.pages} — ${d.total_clients} client(s)</span><button class="btn sm sec" ${d.page >= d.pages ? 'disabled' : ''} onclick="A.filesPage(${d.page + 1})">Suivant →</button></div>` : ''}</div>
  <div class="panel"><h2 style="margin-top:0">Cycle de vie et registre sécurisé</h2><div class="small muted" style="margin-bottom:10px">Masquez, archivez ou placez des fichiers en récupération avant suppression réelle. Les messages texte restent conservés. Les archives ZIP sont limitées à 200 Mo.</div><button class="btn" onclick="A.fileRegistry()">🗃️ Gérer les fichiers enregistrés</button> <button class="btn warn" onclick="A.cleanup()">🧹 Purger les récupérations échues</button></div>`);
};

/* ---------- Contenu : avis, jobs, école ---------- */
views.avis = async () => {
  const [list,categories] = await Promise.all([api('/admin/avis-recherche'),api('/admin/avis-categories')]);
  window._avisCategories=categories;
  shell(`<h1>📢 Avis de recherche</h1>
  <div class="panel"><div class="frow" style="justify-content:space-between"><div><b>Catégories configurables</b><div class="small muted">Seules les catégories actives sont proposées dans l’application.</div></div><button class="btn" onclick="A.avisCategoryForm()">＋ Ajouter une catégorie</button></div>
  <table><tr><th>Catégorie</th><th>Description</th><th>Ordre</th><th>État</th><th>Action</th></tr>${categories.map(c=>`<tr><td><b>${esc(c.name)}</b></td><td class="small">${esc(c.description||'')}</td><td>${c.sort}</td><td>${c.active?'<span class="pill ok">Active</span>':'<span class="pill bad">Inactive</span>'}</td><td><button class="btn sm sec" onclick="A.avisCategoryForm(${c.id})">Modifier</button> <button class="btn sm ${c.active?'warn':''}" onclick="A.avisCategoryState(${c.id},${c.active?0:1})">${c.active?'Désactiver':'Activer'}</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Aucune catégorie.</td></tr>'}</table></div>
  <div class="panel"><h2>Publications à modérer</h2><table><tr><th></th><th>Catégorie / intitulé</th><th>Publié par</th><th>Détails</th><th>Contact</th><th>Statut</th><th>Actions</th></tr>
  ${list.map(a => `<tr><td>${a.photo ? `<img class="thumb" src="${esc(mediaUrl(a.photo))}">` : '—'}</td><td><span class="small muted">${esc(a.category_name||'Sans catégorie')}</span><br><b>${esc(a.nom)}</b></td><td class="small">${esc(a.publisher)}<br>${esc(a.phone)}</td><td class="small">${esc([a.city,a.dernier_lieu,a.description].filter(Boolean).join(' • '))}</td><td class="small">${esc(a.contact)}</td><td>${a.status==='approved'?'<span class="pill ok">Publié</span>':a.status==='pending'?'<span class="pill warn">En attente</span>':a.status==='resolved'?'<span class="pill info">Résolu</span>':'<span class="pill bad">Refusé</span>'}</td><td>${a.status==='pending'?`<button class="btn sm" onclick="A.avisStatus(${a.id},'approved')">Publier</button><button class="btn sm warn" onclick="A.avisStatus(${a.id},'rejected')">Refuser</button>`:''}${a.status==='approved'?`<button class="btn sm sec" onclick="A.avisStatus(${a.id},'resolved')">Marquer résolu</button>`:''}</td></tr>`).join('')}${!list.length?'<tr><td colspan="7" class="muted">Aucun avis de recherche.</td></tr>':''}</table></div>`);
};

views.jobs = async () => {
  const [offers,list] = await Promise.all([api('/admin/job-offers'),api('/admin/jobs')]);
  shell(`<h1>💼 Trouver ou proposer un job</h1><div class="panel"><h2>Offres de job proposées</h2><table><tr><th>Poste</th><th>Publié par</th><th>Informations</th><th>Contact</th><th>Statut</th><th>Actions</th></tr>${offers.map(o=>`<tr><td><b>${esc(o.title)}</b></td><td class="small">${esc(o.publisher)}<br>${esc(o.phone)}</td><td class="small">${esc([o.skills,o.city,o.location,o.duration,o.compensation].filter(Boolean).join(' • '))}<br>${esc(o.description)}</td><td class="small">${esc(o.contact)}${o.application_method?'<br>'+esc(o.application_method):''}</td><td>${o.status==='approved'?'<span class="pill ok">Publiée</span>':o.status==='pending'?'<span class="pill warn">En attente</span>':o.status==='closed'?'<span class="pill info">Clôturée</span>':'<span class="pill bad">Refusée</span>'}</td><td>${o.status==='pending'?`<button class="btn sm" onclick="A.jobOfferStatus(${o.id},'approved')">Publier</button><button class="btn sm warn" onclick="A.jobOfferStatus(${o.id},'rejected')">Refuser</button>`:''}${o.status==='approved'?`<button class="btn sm sec" onclick="A.jobOfferStatus(${o.id},'closed')">Clôturer</button>`:''}</td></tr>`).join('')||'<tr><td colspan="6" class="muted">Aucune offre de job.</td></tr>'}</table></div>
  <div class="panel"><h2>Profils de candidats historiques</h2><div class="small muted">Ces données et leur modération sont conservées pour compatibilité.</div><table><tr><th>Métier</th><th>Publié par</th><th>Détails</th><th>Contact</th><th>Statut</th><th>Actions</th></tr>${list.map(j=>`<tr><td><b>${esc(j.metier)}</b></td><td class="small">${esc(j.publisher)}<br>${esc(j.phone)}</td><td class="small">${esc([j.competences,j.experience,j.localisation,j.disponibilite].filter(Boolean).join(' • '))} ${j.cv?`<a href="${esc(j.cv)}" target="_blank">📄 CV</a>`:''}</td><td class="small">${esc(j.contact)}</td><td>${j.status==='approved'?'<span class="pill ok">Publié</span>':j.status==='pending'?'<span class="pill warn">En attente</span>':'<span class="pill bad">Refusé</span>'}</td><td>${j.status==='pending'?`<button class="btn sm" onclick="A.jobStatus(${j.id},'approved')">Publier</button><button class="btn sm warn" onclick="A.jobStatus(${j.id},'rejected')">Refuser</button>`:''}</td></tr>`).join('')||'<tr><td colspan="6" class="muted">Aucun profil.</td></tr>'}</table></div>`);
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
  const archives = await api('/admin/quiz-archives');
  let shares = { clicks: 0, opened: 0, joined: 0 };
  try { shares = await api('/admin/shares/stats'); } catch { }
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
    </div>
    <div style="margin-top:14px;border-top:1px solid #e4eeeb;padding-top:10px"><b>Conditions cumulatives de participation</b><div class="small muted mb">Le clic « Partager » ne suffit jamais : seules l’ouverture mesurable d’un lien ou l’inscription attribuée au lien peuvent être exigées.</div>
      ${[['quiz','🧠 Quiz'],['flipfizz','🎲 Flip Fizz'],['kdo','🎁 Kdo']].map(([g,lb])=>`<div class="frow" style="align-items:center;border-top:1px solid #edf3f1;padding:8px 0"><b style="min-width:100px">${lb}</b><select onchange="A.toggleSetting('game_${g}_account',this.value)">${[['tous','Tous comptes'],['clients','Clients'],['pros','Pros validés'],['clients_pros','Clients et pros']].map(([v,t])=>`<option value="${v}" ${(s['game_'+g+'_account']||'tous')===v?'selected':''}>${t}</option>`).join('')}</select><select onchange="A.toggleSetting('game_${g}_share',this.value)">${[['tous','Partage : sans condition'],['lien_ouvert','Partage : lien ouvert'],['inscription_acquise','Partage : inscription acquise'],['sans_partage','Partage : aucun partage mesuré']].map(([v,t])=>`<option value="${v}" ${(s['game_'+g+'_share']||'tous')===v?'selected':''}>${t}</option>`).join('')}</select><select onchange="A.toggleSetting('game_${g}_service',this.value)">${[['tous','Mission : sans condition'],['realisee','Mission réalisée'],['non_realisee','Mission non réalisée']].map(([v,t])=>`<option value="${v}" ${(s['game_'+g+'_service']||'tous')===v?'selected':''}>${t}</option>`).join('')}</select></div>`).join('')}
      <div class="cards" style="margin-top:10px"><div class="kpi"><div class="v">${Number(shares.clicks || 0).toLocaleString('fr-FR')}</div><div class="l">Menus Partager ouverts</div></div><div class="kpi"><div class="v">${Number(shares.opened || 0).toLocaleString('fr-FR')}</div><div class="l">Liens ouverts (mesurés)</div></div><div class="kpi"><div class="v">${Number(shares.joined || 0).toLocaleString('fr-FR')}</div><div class="l">Inscriptions attribuées</div></div></div><div class="small muted mt">Un menu ouvert n’est pas un partage confirmé. Une ouverture de lien ou une inscription est la seule information mesurable ici.</div>
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
      <td>${stLbl[x.status] || esc(x.status)}${x.paused_at ? '<br><span class="pill info">⏸ Pause</span>' : ''}</td>
      <td class="small">${x.nb_questions} questions • ${x.time_per_q}s/question • pause ${x.interval_s == null ? 30 : x.interval_s}s<br>${x.elimination ? '👁️ Progression (spectateurs) • ' : ''}${x.nb_winners} gagnant(s) • désignation ${x.winner_mode === 'auto' ? 'auto' : 'admin'}</td>
      <td>👥 ${x.in_competition} en lice <span class="small muted">/ ${x.participants} inscrits</span>${x.spectators ? ` • 👁️ ${x.spectators}` : ''}${x.gagnants ? ` <span class="pill ok">🏆 ${x.gagnants}</span>` : ''}</td>
      <td>
        ${x.status === 'brouillon' ? `<button class="btn sm" onclick="A.quizLancer(${x.id})" ${enCours ? 'disabled title="Un quiz est déjà en cours"' : ''}>🚀 Lancer</button>
          <button class="btn sm warn" onclick="A.quizSessionDel(${x.id})">🗑️</button>` : ''}
        ${x.status === 'en_cours' ? `${x.paused_at ? `<button class="btn sm" onclick="A.quizReprendre(${x.id})">▶️ Reprendre</button>` : `<button class="btn sm sec" onclick="A.quizPause(${x.id})">⏸️ Pause</button>`} <button class="btn sm warn" onclick="A.quizArreter(${x.id})">⏹️ Arrêter</button>` : ''}
        ${x.status === 'terminee' ? `<button class="btn sm" onclick="A.quizRejouer(${x.id})">🔄 Archiver puis rejouer</button>` : ''}
        ${x.status !== 'brouillon' ? `<button class="btn sm sec" onclick="A.quizSessionDetail(${x.id})">📋 Détails</button>` : ''}
      </td></tr>`).join('')}
    ${!sessions.length ? '<tr><td colspan="5" class="muted">Aucune session. Créez votre premier quiz concours ci-dessus.</td></tr>' : ''}</table></div>

  <div class="panel"><h2 style="margin-top:0">🗄️ Archives de réinitialisation</h2><div class="small muted mb">Chaque redémarrage confirmé archive les résultats et réponses précédents.</div><table><tr><th>Quiz</th><th>Session source</th><th>Archivé le</th><th></th></tr>${archives.map(a => `<tr><td>${esc(a.title)}</td><td>#${a.source_session_id}</td><td class="small">${fmtD(a.archived_at)}</td><td><button class="btn sm sec" onclick="A.quizArchive(${a.id})">Voir</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Aucune archive.</td></tr>'}</table></div>

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

/* ---------- Options de comptes professionnels (PDG) ---------- */
views.prooptions = async () => {
  const [opts, catalog] = await Promise.all([api('/admin/pro-options'), api('/admin/catalog')]);
  window._PRO_OPTS = opts; window._PRO_OPT_CATS = catalog.categories || [];
  shell(`<h1>🧩 Options des comptes professionnels</h1>
    <div class="panel"><div class="frow"><div class="grow"><b>Fonctions configurables par la direction</b><div class="small muted">Créez uniquement les options réellement proposées. Elles sont filtrées côté serveur par cible et catégories, et aucune option inactive ne peut être utilisée.</div></div><button class="btn" onclick="A.proOptForm()">＋ Créer une option</button></div></div>
    <div class="panel"><table><tr><th>Ordre</th><th>Option</th><th>Cible / catégories</th><th>Règle</th><th>État</th><th>Actions</th></tr>
    ${opts.map((o,i) => `<tr><td><b>${o.sort}</b>${i ? ` <button class="btn sm sec" onclick="A.proOptMove(${o.id},${opts[i-1].sort},true)">↑</button>` : ''}${i<opts.length-1 ? ` <button class="btn sm sec" onclick="A.proOptMove(${o.id},${opts[i+1].sort},false)">↓</button>` : ''}</td><td><b>${esc(o.name)}</b><br><span class="small muted">${esc(o.opt_key)}${o.description ? ' — ' + esc(o.description) : ''}</span></td><td class="small">${o.pro_type === 'tous' ? 'Tous les pros' : esc(o.pro_type)}<br>${o.categories.length ? o.categories.map(id => (catalog.categories || []).find(c => c.id === +id)?.name || ('#' + id)).map(esc).join(', ') : 'Toutes catégories'}</td><td>${o.required ? '<span class="pill warn">Obligatoire</span>' : '<span class="pill info">Facultative</span>'}</td><td>${o.active && !o.suspended ? '<span class="pill ok">Active</span>' : `<span class="pill bad">${o.suspended ? 'Suspendue' : 'Inactive'}</span>`}</td><td><button class="btn sm sec" onclick="A.proOptForm(${o.id})">Modifier</button> <button class="btn sm ${o.active && !o.suspended ? 'warn' : ''}" onclick="A.proOptToggle(${o.id},'${o.active && !o.suspended ? 'suspended' : 'active'}')">${o.active && !o.suspended ? 'Suspendre' : 'Activer'}</button> <button class="btn sm warn" onclick="A.proOptDelete(${o.id})">Supprimer</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Aucune option créée : rien n’est affiché aux professionnels.</td></tr>'}</table></div>`);
};

/* ---------- Paramètres ---------- */
views.settings = async () => {
  const [s, dispatch] = await Promise.all([api('/admin/settings'), api('/admin/dispatch/overview')]);
  const contacts = JSON.parse(s.urgence_contacts || '[]');
  const ps = dispatch.professionals || {};
  shell(`<h1>⚙️ Paramètres généraux</h1>
  <div class="panel"><h2 style="margin-top:0">Suivi des demandes</h2><div class="cards"><div class="kpi"><div class="v">${dispatch.searching || 0}</div><div class="l">Recherches en cours</div></div><div class="kpi"><div class="v">${dispatch.unanswered || 0}</div><div class="l">Sans réponse</div></div><div class="kpi"><div class="v">${ps.disponible || 0}</div><div class="l">Pros disponibles</div></div><div class="kpi"><div class="v">${ps.en_mission || 0}</div><div class="l">Pros en mission</div></div></div><div class="small muted">Les demandes sans réponse sont aussi consultables dans Demandes & missions. Les services et capacités autorisés d’un professionnel se règlent dans Utilisateurs → Fiche → Autorisations pro.</div></div>
  <div class="panel">
    <h2 style="margin-top:0">Missions & paiements</h2>
    <div class="frow">
      <div><label>Commission Klean Services (%)</label><input type="number" id="st-comm" value="${esc(s.commission_rate)}" min="0" max="100" step="0.5" style="width:110px"></div>
      <div><label>Délai de réponse d'un professionnel (secondes)</label><input type="number" id="st-wait" value="${esc(s.dispatch_wait_seconds)}" min="15" max="3600" style="width:130px"></div>
      <div><label>Conservation des fichiers (jours)</label><input type="number" id="st-ret" value="${esc(s.file_retention_days)}" min="1" style="width:110px"></div>
      <div><label>Photos / demande</label><input type="number" id="st-reqphotos" value="${esc(s.request_image_limit || '3')}" min="0" max="3" style="width:90px"></div>
      <div><label>Vocal demande (max. s)</label><input type="number" id="st-reqaudio" value="${esc(s.request_audio_max_seconds || '25')}" min="1" max="25" style="width:100px"></div>
      <div><label>Seuil « actif récemment » (min)</label><input type="number" id="st-activity" value="${esc(s.activity_active_minutes || '5')}" min="1" max="120" style="width:110px"></div>
    </div>
    <h3 style="margin:18px 0 8px">Paramètres des demandes et des alertes</h3>
    <div class="frow" style="margin-bottom:10px">
      <label class="check-line"><input type="checkbox" id="st-auto" ${s.dispatch_auto_enabled !== '0' ? 'checked' : ''}> Attribution automatique</label>
      <label class="check-line"><input type="checkbox" id="st-geo" ${s.dispatch_geo_enabled !== '0' ? 'checked' : ''}> Priorité géographique</label>
      <label class="check-line"><input type="checkbox" id="st-sound" ${s.dispatch_alert_sound !== '0' ? 'checked' : ''}> Son d’alerte mission</label>
      <label class="check-line"><input type="checkbox" id="st-particulier" ${s.dispatch_allow_particulier !== '0' ? 'checked' : ''}> Particuliers autorisés</label>
      <label class="check-line"><input type="checkbox" id="st-entreprise" ${s.dispatch_allow_entreprise !== '0' ? 'checked' : ''}> Entreprises autorisées</label>
    </div>
    <div class="frow">
      <div><label>1re vague (professionnels)</label><input type="number" id="st-wave1" value="${esc(s.dispatch_initial_alert_count || '3')}" min="1" max="50" style="width:110px"></div>
      <div><label>Vagues suivantes</label><input type="number" id="st-wave2" value="${esc(s.dispatch_expand_alert_count || '5')}" min="1" max="50" style="width:110px"></div>
      <div><label>Rappel d’alerte (secondes)</label><input type="number" id="st-reminder" value="${esc(s.dispatch_reminder_seconds || '20')}" min="2" max="600" style="width:130px"></div>
      <div><label>Rappels max. / offre</label><input type="number" id="st-maxrem" value="${esc(s.dispatch_max_reminders || '6')}" min="0" max="100" style="width:120px"></div>
      <div><label>Recherche max. (secondes)</label><input type="number" id="st-searchmax" value="${esc(s.dispatch_search_max_seconds || '3600')}" min="60" max="86400" style="width:130px"></div>
    </div>
    <div class="small muted">Le moteur compare le type choisi, les services déclarés et autorisés, l’état du compte, la capacité, la ville/zone et la disponibilité. Chaque vague part seulement après expiration ou refus de la précédente. À 2 s, le rappel est sonore/badge uniquement si l’application est au premier plan ; il ne force jamais une sonnerie verrouillée ni une rafale de Push iPhone/Android.</div>
    <h3 style="margin:18px 0 8px">Messagerie mission</h3>
    <div class="frow">
      <div><label>Textes / personne</label><input type="number" id="st-chattext" value="${esc(s.chat_text_limit || '30')}" min="1" max="500" style="width:110px"></div>
      <div><label>Images / personne</label><input type="number" id="st-chatimages" value="${esc(s.chat_image_limit || '3')}" min="0" max="30" style="width:110px"></div>
      <div><label>Vocal max. (secondes)</label><input type="number" id="st-chataudio" value="${esc(s.chat_audio_max_seconds || '20')}" min="1" max="120" style="width:130px"></div>
      <div><label>Récupération fichiers (jours)</label><input type="number" id="st-recovery" value="${esc(s.file_recovery_days || '30')}" min="0" max="365" style="width:130px"></div>
    </div>
    <div class="frow">
      <button class="btn ${s.chat_audio_enabled !== '0' ? '' : 'sec'}" onclick="A.toggleSetting('chat_audio_enabled',${s.chat_audio_enabled !== '0' ? "'0'" : "'1'"})">🎤 Vocaux : ${s.chat_audio_enabled !== '0' ? 'activés ✅' : 'suspendus'}</button>
      <button class="btn ${s.chat_image_enabled !== '0' ? '' : 'sec'}" onclick="A.toggleSetting('chat_image_enabled',${s.chat_image_enabled !== '0' ? "'0'" : "'1'"})">📷 Images : ${s.chat_image_enabled !== '0' ? 'activées ✅' : 'suspendues'}</button>
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
    <h2 style="margin-top:0">Urgences — configuration réelle</h2>
    <label class="check-line"><input type="checkbox" id="st-urgavailable" ${s.urgence_assistance_enabled === '1' ? 'checked' : ''}> Assistance Klean Services disponible</label>
    <div class="small muted" style="margin:4px 0 10px">Désactivée par défaut : aucun bouton d’alerte n’est affiché. Klean Services ne remplace jamais les secours publics.</div>
    <div class="frow"><div style="flex:1"><label>Message d'information affiché dans l'application</label><textarea id="st-urginfo">${esc(s.urgence_info || '')}</textarea></div></div>
    <label class="small muted">Catégories / services (une par ligne : Nom | description)</label><textarea id="st-urgcats">${(() => { try { return JSON.parse(s.urgence_categories || '[]').map(c => c.name + (c.description ? ' | ' + c.description : '')).join('\n'); } catch { return ''; } })()}</textarea>
    <label class="small muted">Contacts vérifiés (une par ligne : Nom | Numéro | oui). Seuls les contacts marqués « oui » sont affichés publiquement.</label>
    <textarea id="st-urgc">${contacts.map(c => c.nom + ' | ' + c.tel + ' | ' + (c.verified ? 'oui' : 'non')).join('\n')}</textarea>
    <button class="btn" style="margin-top:8px" onclick="A.saveUrgence()">Enregistrer la configuration d’urgence</button>
  </div>`);
};

/* ---------- Actions ---------- */
/* ---------- Gestion de Klean Cabine : pilotage central, sans faux paiement ---------- */
views.cabine = async () => {
  const cabEmpty=message=>`<div class="hint small">${esc(message)}</div>`;
  const [d,stats]=await Promise.all([api('/admin/cabine/overview'),api('/admin/cabine/stats')]);const cfg=d.settings||{};
  shell(`<h1>📲 Gestion de Klean Cabine <span class="pill info">PDG</span></h1><div class="panel" style="border-left:4px solid #f59e0b"><h2 style="margin-top:0">⚠️ Exécution verrouillée</h2><p class="small">Aucun connecteur de paiement ou opérateur officiel n’est configuré. Les actions utilisateur sont bloquées côté serveur : aucun débit, achat de forfait ou transfert ne peut être créé ou présenté comme réussi.</p><div class="cards"><div class="kpi"><div class="v">${stats.operations_total||0}</div><div class="l">Opérations réelles historisées</div></div><div class="kpi"><div class="v">${stats.blocked_checkout_attempts_30d||0}</div><div class="l">Tentatives bloquées · 30 j</div></div><div class="kpi"><div class="v">0 FCFA</div><div class="l">Encaissement Cabine</div></div></div></div>
  <div class="panel"><h2 style="margin-top:0">Paramètres et communication</h2><div class="frow"><div><label>Titre</label><input id="cab-title" maxlength="100" value="${esc(cfg.title||'Klean Cabine')}"></div><div><label>Icône</label><input id="cab-icon" maxlength="20" value="${esc(cfg.icon||'📲')}"></div><div><label>Couleur</label><input id="cab-color" maxlength="20" value="${esc(cfg.color||'#166534')}"></div></div><label>Description publique</label><textarea id="cab-description" maxlength="1000">${esc(cfg.description||'')}</textarea><label>Message d’indisponibilité</label><textarea id="cab-unavailable" maxlength="2000">${esc(cfg.unavailable_message||'')}</textarea><label>Conditions</label><textarea id="cab-conditions" maxlength="4000">${esc(cfg.conditions||'')}</textarea><div class="frow"><label class="check-line"><input id="cab-enabled" type="checkbox" ${cfg.enabled?'checked':''}> Afficher Klean Cabine</label><label class="check-line"><input id="cab-detect" type="checkbox" ${cfg.operator_detection?'checked':''}> Prévoir détection opérateur</label><label class="check-line"><input id="cab-manual" type="checkbox" ${cfg.manual_operator?'checked':''}> Sélection manuelle opérateur</label><label class="check-line"><input id="cab-custom" type="checkbox" ${cfg.custom_amount?'checked':''}> Montant libre à préparer</label></div><button class="btn" onclick="A.cabineSettings()">Enregistrer les paramètres</button></div>
  <div class="grid2"><div class="panel"><div class="row"><h2 class="grow" style="margin:0">Opérateurs</h2><button class="btn sec sm" onclick="A.cabineOperatorEdit()">＋ Ajouter</button></div>${d.operators.length?`<table><thead><tr><th>Opérateur</th><th>État API</th><th>Catalogue</th><th></th></tr></thead><tbody>${d.operators.map(o=>`<tr><td><b>${esc(o.name)}</b><br><span class="small muted">${esc(o.code)}</span></td><td><span class="pill ${o.api_status==='connected'?'ok':'off'}">${esc(o.api_status)}</span><br><span class="small muted">${esc(o.api_message||'Non configuré')}</span></td><td>${o.enabled?'Visible':'Masqué'} · crédit ${o.transfer_enabled?'préparé':'non'} · forfaits ${o.bundles_enabled?'préparés':'non'}</td><td><button class="btn sm sec" onclick="A.cabineOperatorEdit(${o.id})">Modifier</button> <button class="btn sm warn" onclick="A.cabineDelete('operators',${o.id})">Suppr.</button></td></tr>`).join('')}</tbody></table>`:cabEmpty('Aucun opérateur.')}</div>
  <div class="panel"><div class="row"><h2 class="grow" style="margin:0">Catégories / services</h2><button class="btn sec sm" onclick="A.cabineServiceEdit()">＋ Ajouter</button></div>${d.services.length?`<table><thead><tr><th>Service</th><th>Type</th><th>Visibilité</th><th></th></tr></thead><tbody>${d.services.map(s=>`<tr><td>${esc(s.icon||'📱')} <b>${esc(s.name)}</b><br><span class="small muted">${esc(s.code)}</span></td><td>${esc(s.service_type)}</td><td>${s.enabled?'Active':'Masquée'}</td><td><button class="btn sm sec" onclick="A.cabineServiceEdit(${s.id})">Modifier</button> <button class="btn sm warn" onclick="A.cabineDelete('services',${s.id})">Suppr.</button></td></tr>`).join('')}</tbody></table>`:cabEmpty('Aucune catégorie.')}</div></div>
  <div class="panel"><div class="row"><h2 class="grow" style="margin:0">Catalogue d’offres et frais</h2><button class="btn sec sm" onclick="A.cabineOfferEdit()">＋ Ajouter</button></div><div class="hint small">Les prix affichés ici sont administrés ; cocher une offre ne l’exécute jamais. Elle demeure indisponible tant qu’un connecteur officiel réellement vérifié n’est pas intégré.</div>${d.offers.length?`<table><thead><tr><th>Offre</th><th>Opérateur / catégorie</th><th>Prix / frais</th><th>État</th><th></th></tr></thead><tbody>${d.offers.map(o=>`<tr><td><b>${esc(o.name)}</b><br><span class="small muted">${esc(o.benefit||'')}</span></td><td>${esc(o.operator_name)}<br>${esc(o.service_name)}</td><td>${Number(o.customer_price).toLocaleString('fr-FR')} FCFA<br><span class="small">${Number(o.fee_fixed||0)} FCFA + ${Number(o.fee_percent||0)}%</span></td><td>${o.visible?'Visible':'Masquée'} · ${o.enabled?'Préparée':'Non préparée'}<br><span class="pill off">Exécution bloquée</span></td><td><button class="btn sm sec" onclick="A.cabineOfferEdit(${o.id})">Modifier</button> <button class="btn sm warn" onclick="A.cabineDelete('offers',${o.id})">Suppr.</button></td></tr>`).join('')}</tbody></table>`:cabEmpty('Aucune offre administrée.')}</div>
  <div class="grid2"><div class="panel"><h2 style="margin-top:0">Historique des opérations</h2>${d.operations.length?`<table><thead><tr><th>Référence</th><th>Compte</th><th>Montant</th><th>État</th></tr></thead><tbody>${d.operations.map(o=>`<tr><td>${esc(o.operation_ref)}<br><span class="small muted">${esc(o.created_at)}</span></td><td>${esc(o.user_name)}<br><span class="small muted">${esc(o.user_phone||'')}</span></td><td>${Number(o.total_amount).toLocaleString('fr-FR')} FCFA</td><td><span class="pill off">${esc(o.status)}</span></td></tr>`).join('')}</tbody></table>`:cabEmpty('Aucune opération. Le système n’invente pas d’historique.')}</div><div class="panel"><h2 style="margin-top:0">Audit de sécurité</h2>${d.audit.length?`<table><thead><tr><th>Date</th><th>Action</th><th>Acteur</th><th>Motif</th></tr></thead><tbody>${d.audit.slice(0,50).map(a=>`<tr><td>${esc(a.created_at)}</td><td>${esc(a.action)}</td><td>${esc(a.actor_name||'Système')}</td><td>${esc(a.reason||'')}</td></tr>`).join('')}</tbody></table>`:cabEmpty('Aucune entrée audit.')}</div></div>
  <div class="panel"><h2 style="margin-top:0">Modèles de notification</h2>${d.templates.map(t=>`<div class="card compact-card"><b>${esc(t.code)}</b> · ${t.enabled?'Actif':'Inactif'}<br><span class="small">${esc(t.title)} — ${esc(t.body)}</span><br><button class="btn sm sec mt" onclick="A.cabineTemplateEdit('${esc(t.code)}')">Modifier</button></div>`).join('')}</div>`);
};

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
          ${u.pro && u.pro_status === 'approved' ? `<button class="btn sm sec" onclick="A.proEligibility(${u.id})">🧰 Autorisations pro</button><button class="btn sm sec" onclick="A.domainRequests(${u.id})">🗂️ Demandes de domaines</button>` : ''}
          ${u.pro_status !== 'approved' ? `<button class="btn sm sec" onclick="A.convertUserPro(${u.id})">💼 Convertir en pro</button>` : ''}
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
  async convertUserPro(id) {
    try { const u=await api('/admin/users/'+id); openModal(`<h3>💼 Conversion professionnelle</h3><p class="small muted">Identité conservée : <b>${esc(u.name)}</b> • ${esc(u.phone)}. Aucune information professionnelle fictive n’est créée. Le profil sera marqué incomplet et restera indisponible tant que ses services ne sont pas autorisés.</p><label>Type</label><select id="cp-type" style="width:100%"><option value="particulier">Particulier</option><option value="entreprise">Entreprise</option></select><label class="check-line mt"><input id="cp-exception" type="checkbox"> Valider exceptionnellement tout de suite (réservé à une situation justifiée)</label><label>Motif <span class="small muted">(obligatoire pour validation exceptionnelle)</span></label><textarea id="cp-reason" maxlength="500" placeholder="Motif administratif…"></textarea><div class="btn-row mt"><button class="btn" onclick="A.saveConvertUserPro(${id})">Confirmer</button><button class="btn sec" onclick="closeModal()">Annuler</button></div>`); }catch(e){toast(e.message,'err');}
  },
  async saveConvertUserPro(id) { try { const exceptional=document.getElementById('cp-exception').checked; await api('/admin/users/'+id+'/convert-pro',{method:'POST',body:{pro_type:document.getElementById('cp-type').value,exceptional,reason:document.getElementById('cp-reason').value}});closeModal();toast(exceptional?'Professionnel exceptionnellement validé (profil incomplet).':'Conversion envoyée vers le parcours professionnel.','ok');A.userDetail(id);}catch(e){toast(e.message,'err');} },
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
  async proEligibility(id) {
    try {
      const [u, catalog, villes] = await Promise.all([api('/admin/users/' + id), api('/admin/catalog'), api('/admin/villes')]);
      if (!u.pro) return toast('Ce compte ne possède pas de profil professionnel.', 'err');
      const declared = (u.pro.services || []).map(Number), allowed = (u.pro.authorized_services || declared).map(Number);
      const declaredDomains = (u.pro.domain_categories || []).map(Number);
      const allowedDomains = (u.pro.authorized_domain_categories || declaredDomains).map(Number);
      const flat = (catalog.services || []).filter(s => declared.includes(+s.id));
      const domains = (catalog.grand_categories || []);
      openModal(`<h3>🧰 Autorisations de ${esc(u.name)}</h3>
        <p class="small muted">Les domaines cochés sont contrôlés par le backend avant l’alerte et l’acceptation. Une tâche ajoutée ultérieurement dans un domaine autorisé devient automatiquement éligible.</p>
        <label class="small muted">Type de prestataire</label><select id="pe-type" style="width:100%;margin-bottom:10px"><option value="particulier" ${u.pro.pro_type !== 'entreprise' ? 'selected' : ''}>Un particulier</option><option value="entreprise" ${u.pro.pro_type === 'entreprise' ? 'selected' : ''}>Une entreprise</option></select>
        <label class="small muted">Capacité de mission</label><select id="pe-cap" style="width:100%;margin-bottom:10px"><option value="1" ${(+u.pro.capacity_level || 1) === 1 ? 'selected' : ''}>Standard</option><option value="2" ${(+u.pro.capacity_level || 1) === 2 ? 'selected' : ''}>Renforcée / gros travaux</option><option value="3" ${(+u.pro.capacity_level || 1) >= 3 ? 'selected' : ''}>Grande capacité</option></select>
        <label class="small muted">Domaines d’activité autorisés</label><div style="max-height:240px;overflow:auto;border:1px solid #e3edeb;border-radius:8px;padding:8px;margin:6px 0 12px">${domains.map(g => `<label style="display:block;padding:5px 0"><input class="pe-domain" type="checkbox" value="${g.id}" ${allowedDomains.includes(+g.id) ? 'checked' : ''}> ${esc(g.icon || '🧩')} <b>${esc(g.name)}</b>${g.active ? '' : ' <span class="muted small">(inactive)</span>'}</label>`).join('') || '<span class="small muted">Aucune grande catégorie disponible.</span>'}</div>
        ${declaredDomains.length ? `<div class="small muted" style="margin:-7px 0 12px">Déclarés initialement : ${domains.filter(g=>declaredDomains.includes(+g.id)).map(g=>esc(g.name)).join(' • ') || '—'}</div>` : `<label class="small muted">Services autorisés (profil historique)</label><div style="max-height:160px;overflow:auto;border:1px solid #e3edeb;border-radius:8px;padding:8px;margin:6px 0 12px">${flat.map(s => `<label style="display:block;padding:5px 0"><input class="pe-service" type="checkbox" value="${s.id}" ${allowed.includes(+s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('') || '<span class="small muted">Aucun service déclaré.</span>'}</div>`}
        <label class="small muted">Villes d’intervention autorisées</label><div class="small muted">Une seule ville est la règle normale. Plusieurs villes ou « toutes » sont réservées à un administrateur / PDG et appliquées au matching.</div><div style="max-height:180px;overflow:auto;border:1px solid #e3edeb;border-radius:8px;padding:8px;margin:6px 0 12px">${(['pdg','admin'].includes(ME.role) ? `<label style="display:block;padding:5px 0"><input class="pe-city" type="checkbox" value="*" ${(u.pro.service_cities||[]).includes('*')?'checked':''}> Toutes les villes actives</label>` : '')}${villes.map(v=>`<label style="display:block;padding:5px 0"><input class="pe-city" type="checkbox" value="${esc(v.name)}" ${(u.pro.service_cities||[]).includes(v.name)?'checked':''}> ${esc(v.name)}</label>`).join('')}</div>
        <button class="btn" onclick="A.saveProEligibility(${id})">Enregistrer</button><button class="btn sec mt" onclick="A.userDetail(${id})">Annuler</button>`);
    } catch (e) { toast(e.message, 'err'); }
  },
  async domainRequests(id) {
    try { const [items,catalog,u]=await Promise.all([api('/admin/pros/'+id+'/domain-requests'),api('/admin/catalog'),api('/admin/users/'+id)]); const nameBy=new Map((catalog.grand_categories||[]).map(g=>[+g.id,g.name])); const labels=ids=>(ids||[]).map(i=>nameBy.get(+i)||('#'+i)).join(' • ')||'—';
      openModal(`<h3>Demandes de domaines — ${esc(u.name)}</h3><div style="max-height:55vh;overflow:auto">${items.map(r=>`<div style="border:1px solid #e3edeb;border-radius:9px;padding:9px;margin:8px 0"><b>${r.status==='en_attente'?'⏳ En attente':r.status==='approuvee'?'✅ Approuvée':'❌ Refusée'}</b><div class="small">Demandés : ${esc(labels(r.requested_domains))}</div><div class="small muted">Avant : ${esc(labels(r.previous_domains))} • ${fmtD(r.created_at)}</div>${r.note?`<div class="small">Note : ${esc(r.note)}</div>`:''}${r.status==='en_attente'?`<div class="frow mt"><button class="btn sm" onclick="A.reviewDomainRequest(${id},${r.id},'approuver')">Approuver</button><button class="btn sm warn" onclick="A.reviewDomainRequest(${id},${r.id},'refuser')">Refuser</button></div>`:''}</div>`).join('')||'<div class="muted">Aucune demande enregistrée.</div>'}</div><button class="btn sec mt" onclick="A.userDetail(${id})">Retour à la fiche</button>`);
    } catch(e){toast(e.message,'err');}
  },
  async reviewDomainRequest(uid,rid,decision) { const note=prompt(decision==='approuver'?'Note facultative pour le professionnel :':'Motif du refus (facultatif) :')||'';try{await api(`/admin/pros/${uid}/domain-requests/${rid}/review`,{method:'POST',body:{decision,note}});toast(decision==='approuver'?'Domaines approuvés ✓':'Demande refusée.','ok');A.domainRequests(uid);}catch(e){toast(e.message,'err');} },
  async saveProEligibility(id) {
    const authorized_services = [...document.querySelectorAll('.pe-service:checked')].map(el => +el.value);
    const authorized_domain_categories = [...document.querySelectorAll('.pe-domain:checked')].map(el => +el.value);
    const service_cities = [...document.querySelectorAll('.pe-city:checked')].map(el => el.value);
    try { await api('/admin/pros/' + id + '/eligibility', { method: 'PUT', body: { authorized_services, authorized_domain_categories, service_cities, pro_type: document.getElementById('pe-type').value, capacity_level: +document.getElementById('pe-cap').value } }); toast('Autorisations professionnelles enregistrées ✓', 'ok'); A.userDetail(id); }
    catch (e) { toast(e.message, 'err'); }
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

  grandCategoryForm(id) {
    const source = (ESTD && ESTD.catalog) || CATD || { grand_categories:[] };
    const g=id ? (source.grand_categories || []).find(x=>x.id===id) : {name:'',icon:'🧩',description:'',active:1,sort:99,image_url:''};
    if (id && !g) return toast('Grande catégorie introuvable.','err');
    const imageUrl=String(g.image_url || '');
    openModal(`<h3>${id?'Modifier':'Nouvelle'} grande catégorie</h3>
      <label>Nom</label><input id="gc-name" style="width:100%" value="${esc(g.name||'')}">
      <label>Icône</label><input id="gc-icon" value="${esc(g.icon||'🧩')}" style="width:90px">
      <label>Description courte</label><textarea id="gc-desc" rows="3">${esc(g.description||'')}</textarea>
      <input id="gc-image-url" type="hidden" value="${esc(imageUrl)}">
      <div style="margin:12px 0;padding:10px;border:1px solid #d9e7e4;border-radius:10px;background:#f8fcfb">
        <b>Photo principale de la catégorie</b><div id="gc-photo-preview" style="margin-top:8px">${imageUrl ? `<img src="${esc(mediaUrl(imageUrl))}" alt="Aperçu photo catégorie" style="display:block;width:132px;height:92px;object-fit:cover;border-radius:8px;border:1px solid #cfe1dd"><div class="small muted" style="margin-top:5px">Photo actuellement publiée</div>` : '<div class="small muted">Aucune photo sélectionnée.</div>'}</div>
        <div class="small muted" style="margin:8px 0">La même photo est utilisée sur les cartes publiques et dans ce tableau de bord. Formats image, 15 Mo maximum.</div>
        <input id="gc-image-file" type="file" accept="image/jpeg,image/png,image/webp" style="max-width:100%">
        <div class="frow mt"><button id="gc-upload-btn" type="button" class="btn sm sec" onclick="A.uploadGrandCategoryImage()">Téléverser et remplacer</button><button id="gc-remove-btn" type="button" class="btn sm warn" onclick="A.clearGrandCategoryImage()" ${imageUrl?'':'disabled'}>Retirer la photo</button></div>
      </div>
      <div class="frow"><label>Ordre <input id="gc-sort" type="number" value="${g.sort||99}" style="width:70px"></label><label class="check-line"><input id="gc-active" type="checkbox" ${g.active?'checked':''}> Active</label></div>
      <button class="btn" onclick="A.saveGrandCategory(${id||0})">Enregistrer</button><button class="btn sec mt" onclick="closeModal()">Annuler</button>`);
  },
  // Entrée dédiée à la galerie PDG : elle réutilise la même fiche et la même source en base.
  grandCategoryPhotoForm(id) { this.grandCategoryForm(id); },
  categoryImagePreview(url, message) {
    const target=document.getElementById('gc-photo-preview'); if (!target) return;
    if (!url) { target.innerHTML='<div class="small muted">Aucune photo sélectionnée.</div>'; return; }
    target.innerHTML=`<img src="${esc(mediaUrl(url))}" alt="Aperçu photo catégorie" style="display:block;width:132px;height:92px;object-fit:cover;border-radius:8px;border:1px solid #cfe1dd"><div class="small muted" style="margin-top:5px">${esc(message || 'Photo actuellement sélectionnée')}</div>`;
  },
  async uploadGrandCategoryImage() {
    const field=document.getElementById('gc-image-file'), button=document.getElementById('gc-upload-btn');
    if (!field || !field.files || !field.files[0]) return toast('Choisissez une image avant de téléverser.','err');
    try { if(button) { button.disabled=true; button.textContent='Téléversement…'; }
      const url=await uploadImageForCategory(field.files[0]), saved=document.getElementById('gc-image-url');
      if (saved) saved.value=url; this.categoryImagePreview(url,'Nouvelle photo prête — cliquez sur Enregistrer pour la publier.');
      const remove=document.getElementById('gc-remove-btn'); if(remove) remove.disabled=false;
      toast('Photo téléversée. Enregistrez la catégorie pour la publier.','ok');
    } catch(e) { toast(e.message,'err'); }
    finally { if(button) { button.disabled=false; button.textContent='Téléverser et remplacer'; } }
  },
  clearGrandCategoryImage() {
    const saved=document.getElementById('gc-image-url'), field=document.getElementById('gc-image-file'), remove=document.getElementById('gc-remove-btn');
    if (saved) saved.value=''; if (field) field.value=''; if (remove) remove.disabled=true;
    this.categoryImagePreview(''); toast('La photo sera retirée partout après Enregistrer.','ok');
  },
  deleteGrandCategoryPhoto() { this.clearGrandCategoryImage(); },
  async saveGrandCategory(id) { 
    const image=document.getElementById('gc-image-url');
    const body={name:document.getElementById('gc-name').value,icon:document.getElementById('gc-icon').value,description:document.getElementById('gc-desc').value,sort:document.getElementById('gc-sort').value,active:document.getElementById('gc-active').checked,image_url:image && image.value.trim() ? image.value.trim() : null};
    try { await api('/admin/grand-categories'+(id?'/'+id:''),{method:id?'PUT':'POST',body});closeModal();toast('Grande catégorie et photo enregistrées ✓','ok');render(); } catch(e) { toast(e.message,'err'); }
  },
  async saveGrandCategoryPhoto(id) { return this.saveGrandCategory(id); },
  async saveEstimationConfig() {
    try { await api('/admin/estimation-config', { method:'PUT', body:{ geo_enabled:document.getElementById('est-geo').checked, fallback:document.getElementById('est-fallback').value, history_min_samples:document.getElementById('est-samples').value } }); toast('Paramètres d’estimation enregistrés ✓','ok'); render(); } catch(e){toast(e.message,'err');}
  },
  estimateRuleForm(id) {
    const d=ESTD, r=id ? d.rules.find(x=>x.id===id) : { grand_category_id:'',category_id:'',sub_id:'',service_id:'',task_id:'',city:'',zone:'',base_price:'',min_price:'',max_price:'',factors:'{}',source_type:'pdg',source_note:'',source_url:'',source_date:'',verified_at:'',active:1,priority:0 };
    const opt=(rows,key,label,cur)=>`<option value="">${label}</option>`+rows.map(v=>`<option value="${v.id}" ${Number(cur)===Number(v.id)?'selected':''}>${esc(v.name)}</option>`).join('');
    openModal(`<h3>${id?'Modifier':'Nouvelle'} règle tarifaire</h3><div class="small muted">Plus la cible est précise, plus elle est prioritaire à source et priorité égales. Laissez les niveaux inutiles vides.</div>
      <label>Grande catégorie</label><select id="er-grand" style="width:100%;margin-bottom:7px">${opt(d.catalog.grand_categories,'id','Toutes les grandes catégories',r.grand_category_id)}</select>
      <label>Métier</label><select id="er-cat" style="width:100%;margin-bottom:7px">${opt(d.catalog.categories,'id','Tous les métiers',r.category_id)}</select>
      <label>Sous-catégorie</label><select id="er-sub" style="width:100%;margin-bottom:7px">${opt(d.catalog.sous_categories,'id','Toutes les sous-catégories',r.sub_id)}</select>
      <label>Prestation</label><select id="er-service" style="width:100%;margin-bottom:7px">${opt(d.catalog.services,'id','Toutes les prestations',r.service_id)}</select>
      <label>Tâche</label><select id="er-task" style="width:100%;margin-bottom:7px">${opt(d.catalog.taches,'id','Toutes les tâches',r.task_id)}</select>
      <div class="frow"><div style="flex:1"><label>Ville <span class="muted">(vide = toutes)</span></label><select id="er-city" style="width:100%"><option value="">Toutes les villes</option>${d.villes.filter(v=>v.active).map(v=>`<option ${r.city===v.name?'selected':''}>${esc(v.name)}</option>`).join('')}</select></div><div style="flex:1"><label>Zone <span class="muted">(facultatif)</span></label><input id="er-zone" value="${esc(r.zone||'')}"></div></div>
      <div class="frow"><div><label>Prix de départ</label><input id="er-base" type="number" min="1" value="${esc(r.base_price??'')}"></div><div><label>Minimum</label><input id="er-min" type="number" min="1" value="${esc(r.min_price??'')}"></div><div><label>Maximum</label><input id="er-max" type="number" min="1" value="${esc(r.max_price??'')}"></div><div><label>Priorité</label><input id="er-priority" type="number" value="${esc(r.priority??0)}" style="width:75px"></div></div>
      <label>Source</label><select id="er-source"><option value="pdg" ${r.source_type==='pdg'?'selected':''}>Règle explicite de la direction</option><option value="local_verifie" ${r.source_type==='local_verifie'?'selected':''}>Donnée locale vérifiée</option></select>
      <label>Note / source vérifiable</label><textarea id="er-note" rows="2" placeholder="Ex : relevé validé par la direction, période et origine…">${esc(r.source_note||'')}</textarea>
      <div class="frow"><div style="flex:1"><label>URL source <span class="muted">(facultatif)</span></label><input id="er-url" value="${esc(r.source_url||'')}"></div><div><label>Date source</label><input id="er-date" type="date" value="${esc(r.source_date||'')}"></div></div>
      <label>Facteurs JSON <span class="muted">(facultatif : fixed_adjustment, percent_adjustment, includes)</span></label><textarea id="er-factors" rows="3">${esc(typeof r.factors==='string'?r.factors:JSON.stringify(r.factors||{}))}</textarea>
      <label class="check-line"><input id="er-active" type="checkbox" ${r.active?'checked':''}> Règle active</label>
      <button class="btn" onclick="A.saveEstimationRule(${id||0})">Enregistrer</button><button class="btn sec mt" onclick="closeModal()">Annuler</button>`);
  },
  async saveEstimationRule(id) {
    const num=k=>{const v=document.getElementById(k).value;return v===''?null:Number(v);};
    const body={grand_category_id:num('er-grand'),category_id:num('er-cat'),sub_id:num('er-sub'),service_id:num('er-service'),task_id:num('er-task'),city:document.getElementById('er-city').value,zone:document.getElementById('er-zone').value,base_price:num('er-base'),min_price:num('er-min'),max_price:num('er-max'),priority:num('er-priority'),source_type:document.getElementById('er-source').value,source_note:document.getElementById('er-note').value,source_url:document.getElementById('er-url').value,source_date:document.getElementById('er-date').value,factors:document.getElementById('er-factors').value,active:document.getElementById('er-active').checked};
    try { await api('/admin/estimation-rules'+(id?'/'+id:''),{method:id?'PUT':'POST',body});closeModal();toast('Règle tarifaire enregistrée ✓','ok');render();}catch(e){toast(e.message,'err');}
  },
  async deleteEstimationRule(id) { if(!confirm('Supprimer définitivement cette règle tarifaire ?'))return;try{await api('/admin/estimation-rules/'+id,{method:'DELETE'});toast('Règle supprimée.','ok');render();}catch(e){toast(e.message,'err');} },
  async testEstimation() { const sid=document.getElementById('est-test-service').value,city=document.getElementById('est-test-city').value,z=document.getElementById('est-test-result');if(!sid||!city){toast('Choisissez une prestation et une ville.','err');return;}z.textContent='Calcul en cours…';try{const r=await api('/admin/estimation-test?service_id='+encodeURIComponent(sid)+'&city='+encodeURIComponent(city));z.innerHTML=r.status==='estimated'?`<b style="color:#dc2626">À partir de ${fcfa(r.amount)}</b> — ${esc(r.source||'')}${r.provisional?' (provisoire)':''}<br><span class="muted">${esc(r.includes||'')}</span>`:`<b>Prix à confirmer</b> — ${esc(r.reason||'Aucune donnée fiable.')}`;}catch(e){z.textContent=e.message;} },
  searchTermForm() {
    const d=ESTD, serviceOpts=d.catalog.services.filter(s=>s.active).map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
    const taskOpts=d.catalog.taches.filter(t=>t.active).map(t=>{const s=d.catalog.services.find(v=>v.id===t.service_id)||{};return `<option value="${t.id}" data-service="${t.service_id}">${esc(s.name||'')} › ${esc(t.name)}</option>`;}).join('');
    openModal(`<h3>Ajouter une expression de recherche</h3><div class="small muted">Exemple : « mon eau coule » peut pointer vers une tâche de réparation de fuite.</div><label>Expression, synonyme ou formulation familière</label><input id="st-term" style="width:100%" placeholder="Ex : mon eau coule"><label>Prestation</label><select id="st-service" style="width:100%"><option value="">Choisir</option>${serviceOpts}</select><label>Tâche <span class="muted">(facultatif)</span></label><select id="st-task" style="width:100%"><option value="">Toute la prestation</option>${taskOpts}</select><button class="btn mt" onclick="A.saveSearchTerm()">Ajouter</button><button class="btn sec mt" onclick="closeModal()">Annuler</button>`);
  },
  async saveSearchTerm() { const service_id=Number(document.getElementById('st-service').value),task_id=Number(document.getElementById('st-task').value)||null;if(!service_id)return toast('Choisissez une prestation.','err');try{await api('/admin/search-terms',{method:'POST',body:{term:document.getElementById('st-term').value,service_id,task_id}});closeModal();toast('Expression ajoutée ✓','ok');render();}catch(e){toast(e.message,'err');} },
  async toggleSearchTerm(id,active) { try{await api('/admin/search-terms/'+id,{method:'PUT',body:{active}});render();}catch(e){toast(e.message,'err');} },
  async deleteSearchTerm(id) {if(!confirm('Supprimer cette expression du dictionnaire ?'))return;try{await api('/admin/search-terms/'+id,{method:'DELETE'});render();}catch(e){toast(e.message,'err');}},
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
      <label class="small muted">Grande catégorie racine</label><select id="em-grand" style="width:100%;margin-bottom:12px"><option value="">Non classée</option>${(CATD.grand_categories || []).map(g => `<option value="${g.id}" ${Number(c.grand_category_id)===Number(g.id)?'selected':''}>${esc(g.icon || '')} ${esc(g.name)}</option>`).join('')}</select>
      <div><button class="btn" onclick="A._metSave(${id})">Enregistrer</button> <button class="btn sec" onclick="closeModal()">Annuler</button></div>`);
  },
  async _metSave(id) { try { await api('/admin/categories/' + id, { method: 'PUT', body: { name: document.getElementById('em-name').value, icon: document.getElementById('em-icon').value, grand_category_id: document.getElementById('em-grand').value || null } }); closeModal(); toast('Catégorie modifiée ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
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
      <input id="es-cities" style="width:100%;margin-bottom:12px" value="${esc((s.cities || []).join(', '))}" placeholder="Ex : Bouaké, Abidjan / Cocody">
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

  // Maintenance générale et exceptions de tests (PDG)

  maintMessagePayload(){const get=id=>(document.getElementById(id)||{}).value||'';return {scope:'F',title:get('mt-title'),message:get('mt-msg'),precision:get('mt-precision'),background_color:get('mt-color'),icon:get('mt-icon'),logo_url:get('mt-logo')};},
  maintSelectAll(){if(!window._maintSelected)window._maintSelected=new Set();document.querySelectorAll('.mt-account-check').forEach(x=>{if(!x.disabled){window._maintSelected.add(Number((x.getAttribute('onchange')||'').match(/\((\d+)/)?.[1]||0));x.checked=true;}});},
  async maintSimpleToggle(on){if(on){const body={...A.maintMessagePayload(),active:1,reason:'Activation confirmée par Klean Services'};if(!confirm('Activer la maintenance générale maintenant ? Tous les comptes seront bloqués sauf Klean Services et les comptes explicitement autorisés.')){const el=document.getElementById('mt-simple-active');if(el)el.checked=false;return;}try{await api('/admin/maintenance',{method:'POST',body});window._maintDraft=null;toast('Maintenance générale activée.','ok');render();}catch(e){toast(e.message,'err');const el=document.getElementById('mt-simple-active');if(el)el.checked=false;}}else{await A.maintOff();}},
  async maintSaveMessage(){const message=A.maintMessagePayload();if(!MAINTD||!MAINTD.actif){window._maintDraft=message;toast('Message préparé. Prévisualisez-le puis activez la maintenance lorsque vous êtes prêt.','ok');return;}if(!confirm('Mettre à jour immédiatement le message affiché pendant la maintenance ?'))return;try{await api('/admin/maintenance',{method:'POST',body:{...message,active:1,reason:'Mise à jour confirmée du message de maintenance'}});window._maintDraft=null;toast('Message de maintenance mis à jour.','ok');render();}catch(e){toast(e.message,'err');}},
  async maintReleaseAll(){if(!confirm('Débloquer tous les comptes de la maintenance générale ? Les sanctions, suspensions et désactivations administratives individuelles ne seront jamais annulées.'))return;await A.maintOff();},
  maintScopeChanged(){const scope=(document.querySelector('input[name="mt-scope"]:checked')||{}).value;const f=document.getElementById('mt-fns');if(f)f.style.display=scope==='E'?'block':'none';},
  async maintOn(){const scope=(document.querySelector('input[name="mt-scope"]:checked')||{}).value,functions=[...document.querySelectorAll('.mt-fn:checked')].map(x=>x.value),start=document.getElementById('mt-start').value||null,until=document.getElementById('mt-until').value||null;const body={active:1,scope,functions,start_at:start,until,duration_minutes:document.getElementById('mt-duration').value||null,title:document.getElementById('mt-title').value,message:document.getElementById('mt-msg').value,precision:document.getElementById('mt-precision').value,background_color:document.getElementById('mt-color').value,icon:document.getElementById('mt-icon').value,logo_url:document.getElementById('mt-logo').value,reason:document.getElementById('mt-reason').value};const when=start?'à partir du '+start.replace('T',' à '):'immédiatement';if(!confirm(`Confirmez-vous ${scope==='F'?'la maintenance générale':'cette maintenance'} ${when} ?\nLes comptes non autorisés seront bloqués selon la portée sélectionnée.`))return;try{const r=await api('/admin/maintenance',{method:'POST',body});toast(r.config&&r.config.scheduled?'🟠 Maintenance programmée.':'🔴 Maintenance activée.','ok');render();}catch(e){toast(e.message,'err');}},
  async maintOff(){if(!confirm('Désactiver la maintenance et rétablir les accès normaux selon le statut habituel de chaque compte ?'))return;try{await api('/admin/maintenance',{method:'POST',body:{active:0,reason:'Arrêt manuel par le PDG'}});toast('🟢 Maintenance désactivée.','ok');render();}catch(e){toast(e.message,'err');}},
  maintAccountsFilter(){window._maintQuery=(document.getElementById('mt-account-q')||{}).value||'';window._maintRole=(document.getElementById('mt-account-role')||{}).value||'all';render();},
  maintToggleSelection(id,on){if(!window._maintSelected)window._maintSelected=new Set();if(on)window._maintSelected.add(Number(id));else window._maintSelected.delete(Number(id));},
  maintClearSelection(){window._maintSelected=new Set();render();},
  async maintBatchAllowed(allowed){const ids=[...(window._maintSelected||new Set())];if(!ids.length)return toast('Sélectionnez au moins un compte.', 'err');const label=allowed?'autoriser':'bloquer';if(!confirm(`${label[0].toUpperCase()+label.slice(1)} ${ids.length} compte(s) sélectionné(s) pendant la maintenance ?`))return;try{await api('/admin/maintenance/allowed',{method:'PUT',body:{user_ids:ids,allowed}});window._maintSelected=new Set();toast(`Comptes ${allowed?'autorisés':'bloqués'} mis à jour.`, 'ok');render();}catch(e){toast(e.message,'err');}},
  async maintBlockAll(){if(!confirm('Retirer toutes les autorisations de test ? Tous les comptes non-PDG seront bloqués lors d’une maintenance générale.'))return;try{await api('/admin/maintenance/allowed',{method:'DELETE'});window._maintSelected=new Set();toast('Toutes les autorisations de test ont été retirées.','ok');render();}catch(e){toast(e.message,'err');}},
  async maintLogoUpload(btn){const file=(document.getElementById('mt-logo-file')||{}).files?.[0];if(!file)return toast('Choisissez une image de logo.', 'err');busy(btn,true);try{const url=await uploadImageForCategory(file);document.getElementById('mt-logo').value=url;toast('Logo téléversé : enregistrez ensuite la maintenance pour le publier.','ok');}catch(e){toast(e.message,'err');}finally{busy(btn,false);}},
  maintPreview(){const get=id=>(document.getElementById(id)||{}).value||'',color=/^#[0-9a-fA-F]{6}$/.test(get('mt-color'))?get('mt-color'):'#b91c1c',logo=mediaUrl(get('mt-logo')||'/logo.png');openModal(`<div style="background:${esc(color)};color:#fff;margin:-18px;padding:24px;text-align:center;min-height:55vh;display:flex;flex-direction:column;justify-content:center"><img src="${esc(logo)}" alt="Klean Services" style="width:75px;height:75px;object-fit:contain;background:#fff;border-radius:15px;padding:7px;align-self:center" onerror="this.src='/logo.png'"><div style="font-size:48px;margin:15px">${esc(get('mt-icon')||'⚠️')}</div><h2 style="color:#fff">${esc(get('mt-title')||'MAINTENANCE EN COURS')}</h2><div style="white-space:pre-wrap;line-height:1.55">${esc(get('mt-msg'))}</div><b style="margin-top:18px">${esc(get('mt-precision'))}</b><button class="btn sec" style="margin-top:25px" onclick="closeModal()">Fermer l’aperçu</button></div>`);},

  // Options de comptes pro (PDG)
  proOptForm(id = null) {
    const o = id ? (window._PRO_OPTS || []).find(x => x.id === id) : null, cats = window._PRO_OPT_CATS || [];
    openModal(`<h3>${o ? 'Modifier' : 'Créer'} une option de compte pro</h3>
      <label class="small muted">Clé technique unique (lettres, chiffres, - ou _)</label><input id="po-key" style="width:100%;margin-bottom:8px" value="${o ? esc(o.opt_key) : ''}" placeholder="ex. charte-qualite">
      <label class="small muted">Nom visible</label><input id="po-name" style="width:100%;margin-bottom:8px" value="${o ? esc(o.name) : ''}" placeholder="ex. Charte qualité">
      <label class="small muted">Description</label><textarea id="po-desc" style="width:100%;margin-bottom:8px" placeholder="Expliquez l’option aux professionnels.">${o ? esc(o.description || '') : ''}</textarea>
      <div class="frow"><div><label>Cible</label><select id="po-type"><option value="tous" ${!o || o.pro_type === 'tous' ? 'selected' : ''}>Tous les pros</option><option value="particulier" ${o && o.pro_type === 'particulier' ? 'selected' : ''}>Particuliers</option><option value="entreprise" ${o && o.pro_type === 'entreprise' ? 'selected' : ''}>Entreprises</option></select></div><div><label>Ordre</label><input id="po-sort" type="number" value="${o ? o.sort : ((window._PRO_OPTS || []).length * 10 + 10)}" style="width:90px"></div></div>
      <label class="small muted">Catégories autorisées (aucune cochée = toutes)</label><div style="max-height:130px;overflow:auto;border:1px solid #e3edeb;padding:7px;border-radius:8px;margin:4px 0 10px">${cats.map(c => `<label style="display:block;padding:3px"><input type="checkbox" class="po-cat" value="${c.id}" ${o && o.categories.map(Number).includes(c.id) ? 'checked' : ''}> ${esc((c.icon || '') + ' ' + c.name)}</label>`).join('') || '<span class="small muted">Aucune catégorie configurée.</span>'}</div>
      <label style="display:block;margin:6px 0"><input type="checkbox" id="po-req" ${o && o.required ? 'checked' : ''}> Cette option est obligatoire</label><label style="display:block;margin:6px 0"><input type="checkbox" id="po-active" ${!o || o.active ? 'checked' : ''}> Active</label>
      <div class="frow"><button class="btn" onclick="A.proOptSave(${o ? o.id : 'null'})">Enregistrer</button><button class="btn sec" onclick="closeModal()">Annuler</button></div>`);
  },
  async proOptSave(id) {
    const body = { opt_key: document.getElementById('po-key').value, name: document.getElementById('po-name').value, description: document.getElementById('po-desc').value, pro_type: document.getElementById('po-type').value, sort: +document.getElementById('po-sort').value || 0, categories: [...document.querySelectorAll('.po-cat:checked')].map(x => +x.value), required: document.getElementById('po-req').checked, active: document.getElementById('po-active').checked, suspended: false };
    try { if (id) await api('/admin/pro-options/' + id, { method: 'PUT', body }); else await api('/admin/pro-options', { method: 'POST', body }); closeModal(); toast('Option professionnelle enregistrée ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); }
  },
  async proOptToggle(id, state) { try { await api('/admin/pro-options/' + id, { method: 'PUT', body: state === 'active' ? { active: true, suspended: false } : { suspended: true } }); toast(state === 'active' ? 'Option activée.' : 'Option suspendue.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async proOptMove(id, sort, up) { try { await api('/admin/pro-options/' + id, { method: 'PUT', body: { sort: sort + (up ? -1 : 1) } }); render(); } catch (e) { toast(e.message, 'err'); } },
  async proOptDelete(id) { if (!confirm('Supprimer cette option ? Les usages historiques associés seront supprimés, mais aucune autre donnée professionnelle ne sera touchée.')) return; try { await api('/admin/pro-options/' + id, { method: 'DELETE' }); toast('Option supprimée.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },

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

  async conversationLock(id, locked) { const reason = locked ? prompt('Motif de suspension des échanges :') : ''; if (locked && reason === null) return; try { await api(`/admin/missions/${id}/conversation-lock`, { method: 'POST', body: { locked: !!locked, reason: reason || '' } }); toast(locked ? 'Échanges suspendus.' : 'Échanges rétablis.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async litige(id, open) { try { await api(`/admin/missions/${id}/litige`, { method: 'POST', body: { open } }); toast(open ? 'Litige ouvert.' : 'Litige résolu.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },

  supportFilter(v) { window._supportFilter = v; render(); },
  async supportOpen(id) {
    try {
      const d = await api('/admin/support/conversations/' + id); const c = d.conversation;
      const bubble = m => `<div style="max-width:88%;margin:${m.sender_id ? '8px auto 8px 0' : '8px 0 8px auto'};padding:9px 11px;border-radius:10px;background:${m.sender_id ? '#f0f5f4' : '#e3f5ef'}"><b class="small">${m.sender_id ? esc(m.sender_name || c.user_name) : 'Klean Services'}${m.is_auto ? ' • automatique' : ''}</b><div class="small">${m.type === 'audio' ? `<audio controls src="${esc(mediaUrl(m.file))}"></audio>` : esc(m.content || '')}</div><div class="small muted">${fmtD(m.created_at)}</div></div>`;
      openModal(`<h3>${c.subject === 'suggestion' ? '💡 Suggestion' : '⚠️ Préoccupation'} — ${esc(c.user_name)}</h3><div class="small muted">${esc(c.user_phone || '')} • ${esc(c.user_ville || '')}</div><div id="support-thread" style="max-height:330px;overflow:auto;border:1px solid #e2ebe8;border-radius:10px;padding:8px;margin:12px 0">${d.messages.map(bubble).join('')}</div>
        <label class="small muted">Répondre au client</label><textarea id="support-reply" style="width:100%;min-height:84px"></textarea><div class="frow" style="margin-top:8px"><button class="btn" onclick="A.supportReply(${c.id})">Envoyer la réponse</button><button class="btn sec" onclick="A.supportStatus(${c.id},'${c.status === 'ouverte' ? 'fermee' : 'ouverte'}')">${c.status === 'ouverte' ? 'Fermer la conversation' : 'Rouvrir la conversation'}</button></div>`);
      window._supportPoll = setInterval(() => A.supportRefresh(c.id), 5000);
    } catch (e) { toast(e.message, 'err'); }
  },
  async supportRefresh(id) {
    try {
      const d = await api('/admin/support/conversations/' + id); const thread = document.getElementById('support-thread');
      if (!thread) return;
      thread.innerHTML = d.messages.map(m => `<div style="max-width:88%;margin:${m.sender_id ? '8px auto 8px 0' : '8px 0 8px auto'};padding:9px 11px;border-radius:10px;background:${m.sender_id ? '#f0f5f4' : '#e3f5ef'}"><b class="small">${m.sender_id ? esc(m.sender_name || d.conversation.user_name) : 'Klean Services'}${m.is_auto ? ' • automatique' : ''}</b><div class="small">${m.type === 'audio' ? `<audio controls src="${esc(mediaUrl(m.file))}"></audio>` : esc(m.content || '')}</div><div class="small muted">${fmtD(m.created_at)}</div></div>`).join('');
      thread.scrollTop = thread.scrollHeight;
    } catch { }
  },
  async supportReply(id) {
    const content = (document.getElementById('support-reply') || {}).value || ''; if (!content.trim()) return toast('Écrivez une réponse.', 'err');
    try { await api('/admin/support/conversations/' + id + '/messages', { method: 'POST', body: { type: 'text', content } }); closeModal(); toast('Réponse envoyée au client ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); }
  },
  async supportStatus(id, status) { try { await api('/admin/support/conversations/' + id + '/status', { method: 'POST', body: { status } }); closeModal(); toast(status === 'fermee' ? 'Conversation fermée.' : 'Conversation rouverte.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  adZoneMode() { const cities = document.querySelector('input[name="ad-zone-mode"]:checked').value === 'cities'; const box = document.getElementById('ad-zones-wrap'); if (box) box.style.display = cities ? 'block' : 'none'; },
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
          placement: document.getElementById('ad-place').value, duration: parseInt(document.getElementById('ad-dur').value, 10) || 6,
          zones: document.querySelector('input[name="ad-zone-mode"]:checked').value === 'cities' ? [...document.querySelectorAll('.ad-zone:checked')].map(c => c.value) : []
        }
      });
      toast('Publicité publiée ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  /* ----- Paramètres commerciaux ----- */
  async cmNum(k) {
    const v = document.getElementById('cm-' + k).value;
    try { await api('/admin/settings', { method: 'PUT', body: { [k]: String(v) } }); toast('Paramètre enregistré ✓ (modification journalisée)', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  },
  async cmTxt(k) {
    const v = document.getElementById('cm-' + k).value;
    try { await api('/admin/settings', { method: 'PUT', body: { [k]: v } }); toast('Paramètre enregistré ✓', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  },
  async crAdd() {
    try {
      await api('/admin/commissions', {
        method: 'POST', body: {
          label: document.getElementById('cr-label').value, pro_type: document.getElementById('cr-protype').value || null,
          category_id: document.getElementById('cr-cat').value || null, ville: document.getElementById('cr-ville').value,
          rate: document.getElementById('cr-rate').value, priority: document.getElementById('cr-prio').value,
          date_debut: document.getElementById('cr-debut').value, date_fin: document.getElementById('cr-fin').value
        }
      });
      toast('Règle de commission ajoutée ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async crToggle(id, v) { try { await api('/admin/commissions/' + id, { method: 'PUT', body: { active: v } }); render(); } catch (e) { toast(e.message, 'err'); } },
  async crDel(id) { if (!confirm('Supprimer cette règle ? Le taux général s\u2019appliquera à nouveau.')) return; try { await api('/admin/commissions/' + id, { method: 'DELETE' }); render(); } catch (e) { toast(e.message, 'err'); } },
  async vpAdd() {
    try {
      await api('/admin/visibilite/plans', {
        method: 'POST', body: {
          name: document.getElementById('vp-name').value, price: document.getElementById('vp-price').value,
          duration_days: document.getElementById('vp-dur').value, level: document.getElementById('vp-level').value,
          cible: document.getElementById('vp-cible').value, avantages: document.getElementById('vp-av').value
        }
      });
      toast('Formule créée ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async vpEdit(id) {
    try {
      const pl = (await api('/admin/visibilite/plans')).find(x => x.id === id);
      if (!pl) return;
      openModal(`<h3>✏️ ${esc(pl.name)}</h3>
        <div class="frow"><div><label>Nom</label><input id="ve-name" value="${esc(pl.name)}"></div>
        <div><label>Prix (FCFA)</label><input type="number" id="ve-price" value="${pl.price}" style="width:100px"></div>
        <div><label>Durée (jours)</label><input type="number" id="ve-dur" value="${pl.duration_days}" style="width:80px"></div>
        <div><label>Niveau</label><input type="number" id="ve-level" value="${pl.level}" min="1" max="3" style="width:60px"></div></div>
        <div><label>Avantages</label><input id="ve-av" value="${esc(pl.avantages || '')}" style="width:100%"></div>
        <div style="margin-top:10px"><button class="btn" onclick="A._vpSave(${pl.id})">Enregistrer</button>
        <button class="btn sec" onclick="closeModal()">Annuler</button></div>`);
    } catch (e) { toast(e.message, 'err'); }
  },
  async _vpSave(id) {
    try {
      await api('/admin/visibilite/plans/' + id, {
        method: 'PUT', body: {
          name: document.getElementById('ve-name').value, price: document.getElementById('ve-price').value,
          duration_days: document.getElementById('ve-dur').value, level: document.getElementById('ve-level').value,
          avantages: document.getElementById('ve-av').value
        }
      });
      toast('Formule modifiée ✓ — les abonnements déjà payés conservent leurs conditions.', 'ok'); closeModal(); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async vpToggle(id, v) { try { await api('/admin/visibilite/plans/' + id, { method: 'PUT', body: { active: v } }); render(); } catch (e) { toast(e.message, 'err'); } },
  async vpDel(id) { if (!confirm('Supprimer cette formule ? Les abonnements déjà vendus sont conservés dans l\u2019historique.')) return; try { await api('/admin/visibilite/plans/' + id, { method: 'DELETE' }); render(); } catch (e) { toast(e.message, 'err'); } },
  async nivSave(n) {
    try {
      const niveaux = [];
      const s = await api('/admin/settings');
      const base = JSON.parse(s.pub_niveaux || '[]');
      for (let i = 0; i < n; i++) niveaux.push({
        code: base[i].code, label: document.getElementById('nv-lb-' + i).value,
        poids: Math.max(1, Math.min(3, parseInt(document.getElementById('nv-po-' + i).value, 10) || 1)),
        min_budget: parseInt(document.getElementById('nv-mb-' + i).value, 10) || 0,
        actif: document.getElementById('nv-ac-' + i).checked ? 1 : 0
      });
      await api('/admin/settings', { method: 'PUT', body: { pub_niveaux: JSON.stringify(niveaux) } });
      toast('Niveaux de priorité enregistrés ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  /* ----- Finances ----- */
  fxFilter() {
    window._fxF = {
      kind: document.getElementById('fx-kind').value, status: document.getElementById('fx-status').value,
      du: document.getElementById('fx-du').value, au: document.getElementById('fx-au').value, q: document.getElementById('fx-q').value
    };
    render();
  },
  async trxStatut(id, st) {
    const msg = { confirme: 'Confirmer la réception de ce paiement ? L\u2019effet associé (visibilité, campagne, mise en avant…) sera appliqué automatiquement.', echoue: 'Marquer ce paiement comme échoué ?', rembourse: 'Marquer cette transaction comme remboursée ?' };
    if (!confirm(msg[st])) return;
    try { await api('/admin/transactions/' + id + '/statut', { method: 'POST', body: { status: st } }); toast('Transaction mise à jour ✓', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  },
  async campAct(id, action, withNote) {
    let note = null;
    if (withNote) { note = prompt(action === 'refuser' ? 'Motif du refus (transmis à l\u2019annonceur) :' : 'Motif (transmis à l\u2019annonceur) :'); if (note === null) return; }
    try { await api('/admin/pub/campagnes/' + id + '/action', { method: 'POST', body: { action, note } }); toast('Campagne mise à jour ✓', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  },
  async campDuree(id, cur) {
    const v = prompt('Nouvelle durée de diffusion (jours) :', cur);
    if (v === null) return;
    try { await api('/admin/pub/campagnes/' + id, { method: 'PUT', body: { duration_days: Math.max(1, parseInt(v, 10) || cur) } }); toast('Durée modifiée ✓', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  },
  async campDel(id) { if (!confirm('Supprimer définitivement cette campagne ?')) return; try { await api('/admin/pub/campagnes/' + id, { method: 'DELETE' }); render(); } catch (e) { toast(e.message, 'err'); } },
  async bandeauVitesse(v) {
    if (v === 'autre') {
      v = prompt('Vitesse personnalisée en pixels/seconde (10 à 400) :', '60');
      if (v === null) return;
    }
    try { await api('/admin/settings', { method: 'PUT', body: { bandeau_speed: String(parseInt(v, 10) || 60) } }); toast('Vitesse mise à jour ✓', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  },
  bandeauPreview() {
    const p=document.getElementById('bd-preview'); if(!p)return;
    const v=id=>(document.getElementById(id)||{}).value;
    p.style.height=Math.max(28,Math.min(86,parseInt(v('bd-height'),10)||38))+'px';p.style.background=v('bd-bg')||'#0b1320';p.style.color=v('bd-text')||'#fff';p.style.borderTopColor=v('bd-border')||'#16a34a';p.style.fontSize=Math.max(10,Math.min(28,parseInt(v('bd-font-size'),10)||14))+'px';p.style.fontWeight=v('bd-weight')||'700';p.style.opacity=(document.getElementById('bd-enabled')||{}).checked?'1':'.45';
  },
  async saveBandeauConfig() { const v=id=>(document.getElementById(id)||{}).value; try { await api('/admin/bandeau/config',{method:'PUT',body:{enabled:!!document.getElementById('bd-enabled').checked,style:v('bd-style'),animation:v('bd-animation'),speed:v('bd-speed'),message_duration:v('bd-duration'),background:v('bd-bg'),text_color:v('bd-text'),border_color:v('bd-border'),font_size:v('bd-font-size'),font_weight:v('bd-weight'),height:v('bd-height')}});toast('Bandeau enregistré : l’accueil se synchronise automatiquement.','ok');render();}catch(e){toast(e.message,'err');} },
  async bandeauAddFull(btn) { try { if(!document.getElementById('bdm-content').value.trim())throw new Error('Écrivez un message.');busy(btn,true);let image_url=null,file=document.getElementById('bdm-image').files[0];if(file)image_url=await uploadImageForCategory(file);await api('/admin/annonces',{method:'POST',body:{type:document.getElementById('bdm-type').value,icon:document.getElementById('bdm-icon').value,theme:document.getElementById('bdm-theme').value,content:document.getElementById('bdm-content').value,color:document.getElementById('bdm-color').value,link:document.getElementById('bdm-link').value,image_url,duration_seconds:document.getElementById('bdm-duration').value}});toast('Message ajouté au bandeau.','ok');render();}catch(e){toast(e.message,'err');busy(btn,false);} },
  async bandeauEditFull(id) { try {const a=(await api('/admin/annonces')).find(x=>Number(x.id)===Number(id));if(!a)return;openModal(`<h3>✏️ Modifier le message</h3><div class="frow"><div><label>Type</label><select id="bde-type"><option value="pub" ${a.type==='pub'?'selected':''}>📢 Publicité</option><option value="info" ${a.type==='info'?'selected':''}>ℹ️ Information</option><option value="urgence" ${a.type==='urgence'?'selected':''}>🚨 Urgence</option></select></div><div><label>Icône</label><input id="bde-icon" value="${esc(a.icon||'')}" maxlength="16"></div><div><label>Thème</label><input id="bde-theme" value="${esc(a.theme||'')}" maxlength="80"></div></div><label>Message</label><textarea id="bde-content" maxlength="1000">${esc(a.content||a.title||'')}</textarea><div class="frow"><div><label>Couleur</label><input id="bde-color" type="color" value="${esc(a.color||'#ffffff')}"></div><div><label>Lien</label><input id="bde-link" value="${esc(a.link||'')}" maxlength="500"></div><div><label>Durée fondu</label><input id="bde-duration" type="number" value="${Number(a.duration_seconds)||8}" min="3" max="60"></div></div><label>Remplacer l’image (facultatif)</label><input id="bde-image" type="file" accept="image/*">${a.image_url?`<div class="small muted mt">Image actuelle : ${esc(a.image_url)}</div>`:''}<div class="btn-row mt"><button class="btn" onclick="A.bandeauSaveFull(${a.id},this)">Enregistrer</button><button class="btn sec" onclick="closeModal()">Annuler</button></div>`);}catch(e){toast(e.message,'err');} },
  async bandeauSaveFull(id,btn) {try{busy(btn,true);const file=document.getElementById('bde-image').files[0],body={type:document.getElementById('bde-type').value,icon:document.getElementById('bde-icon').value,theme:document.getElementById('bde-theme').value,content:document.getElementById('bde-content').value,color:document.getElementById('bde-color').value,link:document.getElementById('bde-link').value,duration_seconds:document.getElementById('bde-duration').value};if(file)body.image_url=await uploadImageForCategory(file);await api('/admin/annonces/'+id,{method:'PUT',body});closeModal();toast('Message mis à jour.','ok');render();}catch(e){toast(e.message,'err');busy(btn,false);}},
  async saveVoiceSearchConfig(){try{await api('/admin/voice-search/config',{method:'PUT',body:{enabled:!!document.getElementById('vs-enabled').checked,home_visible:!!document.getElementById('vs-home-visible').checked,store_text:!!document.getElementById('vs-store-text').checked,max_seconds:document.getElementById('vs-max').value}});toast('Réglages de recherche vocale enregistrés.','ok');render();}catch(e){toast(e.message,'err');}},

  bradSubPeriod(period){window._bradSubscriptionPeriod=period;render();},
  async bradPlanEdit(id){try{const plans=await api('/admin/braderie/plans'),p=id?plans.find(x=>Number(x.id)===Number(id)):null,d=p||{name:'',description:'',price_quarterly:'',price_annual:'',publication_quota:1,active_items_quota:1,photos_per_item:1,videos_allowed:false,videos_per_item:0,video_max_seconds:0,video_max_bytes:0,video_formats:[],benefits:'',restrictions:'',visible:true,active:false,promo_start_at:'',promo_end_at:'',promo_quarterly:'',promo_annual:''};openModal(`<h3>${p?'Modifier':'Créer'} une formule Braderie</h3><div class="field"><label>Nom</label><input id="bp-name" maxlength="100" value="${esc(d.name)}"></div><div class="field"><label>Description</label><textarea id="bp-desc" maxlength="2000">${esc(d.description||'')}</textarea></div><div class="frow"><div><label>Tarif trimestriel (FCFA)</label><input id="bp-pq" type="number" min="0" value="${Number(d.price_quarterly)||''}"></div><div><label>Tarif annuel (FCFA)</label><input id="bp-pa" type="number" min="0" value="${Number(d.price_annual)||''}"></div></div><div class="small muted">Les deux tarifs sont obligatoires pour activer la formule. L’économie annuelle est calculée à partir de quatre trimestres.</div><div class="frow"><div><label>Quota publications / abonnement</label><input id="bp-pub" type="number" min="0" value="${Number(d.publication_quota)||0}"></div><div><label>Articles actifs max.</label><input id="bp-active-items" type="number" min="0" value="${Number(d.active_items_quota)||0}"></div><div><label>Photos / article</label><input id="bp-photos" type="number" min="1" max="8" value="${Number(d.photos_per_item)||1}"></div></div><label class="check-line"><input id="bp-videos" type="checkbox" ${d.videos_allowed?'checked':''}> Autoriser les vidéos</label><div class="frow"><div><label>Vidéos / article</label><input id="bp-video-count" type="number" min="0" max="8" value="${Number(d.videos_per_item)||0}"></div><div><label>Durée max. (secondes)</label><input id="bp-video-duration" type="number" min="0" max="7200" value="${Number(d.video_max_seconds)||0}"></div><div><label>Taille max. (Mo, ≤15)</label><input id="bp-video-mb" type="number" min="0" max="15" value="${d.video_max_bytes?Number(d.video_max_bytes)/1048576:0}"></div></div><div class="field"><label>Formats vidéo MIME, séparés par virgules</label><input id="bp-video-formats" value="${esc((d.video_formats||[]).join(', '))}" placeholder="video/mp4, video/webm"></div><div class="field"><label>Avantages</label><textarea id="bp-benefits" maxlength="4000">${esc(d.benefits||'')}</textarea></div><div class="field"><label>Restrictions</label><textarea id="bp-restrictions" maxlength="4000">${esc(d.restrictions||'')}</textarea></div><div class="frow"><div><label>Début promotion (facultatif)</label><input id="bp-promo-start" type="datetime-local" value="${esc(String(d.promo_start_at||'').slice(0,16))}"></div><div><label>Fin promotion (facultatif)</label><input id="bp-promo-end" type="datetime-local" value="${esc(String(d.promo_end_at||'').slice(0,16))}"></div><div><label>Prix promo 3 mois</label><input id="bp-promo-q" type="number" min="0" value="${d.promo_quarterly??''}"></div><div><label>Prix promo 12 mois</label><input id="bp-promo-a" type="number" min="0" value="${d.promo_annual??''}"></div></div><label class="check-line"><input id="bp-visible" type="checkbox" ${d.visible?'checked':''}> Visible dans l’application</label><label class="check-line"><input id="bp-active" type="checkbox" ${d.active?'checked':''}> Formule active et souscriptible</label><div class="field"><label>Note d’historique (facultative)</label><input id="bp-note" maxlength="600"></div><div class="btn-row"><button class="btn" onclick="A.bradPlanSave(${p?p.id:'null'},this)">Enregistrer</button><button class="btn sec" onclick="closeModal()">Annuler</button></div>`);}catch(e){toast(e.message,'err');}},
  async bradPlanSave(id,btn){const v=k=>(document.getElementById(k)||{}).value||'',num=k=>v(k)===''?0:Number(v(k));const body={name:v('bp-name'),description:v('bp-desc'),price_quarterly:num('bp-pq'),price_annual:num('bp-pa'),publication_quota:num('bp-pub'),active_items_quota:num('bp-active-items'),photos_per_item:num('bp-photos'),videos_allowed:!!document.getElementById('bp-videos').checked,videos_per_item:num('bp-video-count'),video_max_seconds:num('bp-video-duration'),video_max_bytes:Math.round(num('bp-video-mb')*1048576),video_formats:v('bp-video-formats').split(',').map(x=>x.trim()).filter(Boolean),benefits:v('bp-benefits'),restrictions:v('bp-restrictions'),promo_start_at:v('bp-promo-start')||null,promo_end_at:v('bp-promo-end')||null,promo_quarterly:v('bp-promo-q')===''?0:num('bp-promo-q'),promo_annual:v('bp-promo-a')===''?0:num('bp-promo-a'),visible:!!document.getElementById('bp-visible').checked,active:!!document.getElementById('bp-active').checked,note:v('bp-note')};busy(btn,true);try{await api('/admin/braderie/plans'+(id?'/'+id:''),{method:id?'PUT':'POST',body});closeModal();toast('Formule enregistrée.','ok');render();}catch(e){toast(e.message,'err');busy(btn,false);}},
  async bradPlanHistory(id){try{const h=await api('/admin/braderie/plans/'+id+'/history');openModal(`<h3>Historique de formule</h3>${h.length?h.map(x=>{const d=(()=>{try{return JSON.parse(x.snapshot)}catch{return {}}})();return `<div class="card"><b>${esc(x.action)}</b> · ${fmtD(x.created_at)}<div class="small">${esc(x.actor_name||'Klean Services')}<br>${esc(d.name||'')} · ${d.price_quarterly!==undefined?fcfa(d.price_quarterly):'—'} / 3 mois · ${d.price_annual!==undefined?fcfa(d.price_annual):'—'} / an${x.note?`<br>${esc(x.note)}`:''}</div></div>`}).join(''):'<div class="muted">Aucun historique.</div>'}<button class="btn sec mt" onclick="closeModal()">Fermer</button>`);}catch(e){toast(e.message,'err');}},
  async bradConfirmPayment(transactionId){if(!confirm('Confirmer le paiement réel reçu ? Cette action active ou programme automatiquement l’abonnement côté serveur.'))return;try{await api('/admin/transactions/'+transactionId+'/statut',{method:'POST',body:{status:'confirme'}});toast('Paiement confirmé et abonnement synchronisé.','ok');render();}catch(e){toast(e.message,'err');}},
  async bradSpaceAction(id,action){const labels={suspend:'suspendre',reactivate:'réactiver',cancel:'annuler'};if(!confirm(`Confirmer : ${labels[action]} cet espace vendeur ?`))return;const note=prompt('Motif / note traçable (facultatif) :','');if(note===null)return;try{await api('/admin/braderie/spaces/'+id+'/status',{method:'PUT',body:{action,note}});toast('Espace mis à jour.','ok');render();}catch(e){toast(e.message,'err');}},
  async bradGrant(spaceId){try{const plans=(await api('/admin/braderie/plans')).filter(p=>p.active);if(!plans.length){toast('Activez d’abord une formule configurée.','err');return;}openModal(`<h3>Attribuer une formule</h3><p class="small muted">Attribution gratuite ou promotionnelle, historisée. Si un abonnement est déjà actif, la formule confirmée prendra effet à son terme.</p><div class="field"><label>Formule</label><select id="bpg-plan">${plans.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div><div class="field"><label>Période</label><select id="bpg-period"><option value="quarterly">Trimestrielle · 3 mois</option><option value="annual">Annuelle · 12 mois</option></select></div><div class="field"><label>Type</label><select id="bpg-source"><option value="admin_grant">Attribution gratuite</option><option value="promotion">Attribution promotionnelle</option></select></div><div class="field"><label>Note</label><textarea id="bpg-note" maxlength="1000"></textarea></div><div class="btn-row"><button class="btn" onclick="A.bradGrantSave(${spaceId},this)">Attribuer</button><button class="btn sec" onclick="closeModal()">Annuler</button></div>`);}catch(e){toast(e.message,'err');}},
  async bradGrantSave(spaceId,btn){busy(btn,true);try{await api('/admin/braderie/spaces/'+spaceId+'/grant',{method:'POST',body:{plan_id:document.getElementById('bpg-plan').value,period:document.getElementById('bpg-period').value,source:document.getElementById('bpg-source').value,note:document.getElementById('bpg-note').value}});closeModal();toast('Attribution enregistrée et tracée.','ok');render();}catch(e){toast(e.message,'err');busy(btn,false);}},
  async bradExtend(id){const raw=prompt('Nombre de jours de prolongation (1 à 365) :','30');if(raw===null)return;const days=Number(raw),note=prompt('Motif / note traçable (facultatif) :','');if(note===null)return;try{await api('/admin/braderie/subscriptions/'+id+'/extend',{method:'POST',body:{days,note}});toast('Abonnement prolongé.','ok');render();}catch(e){toast(e.message,'err');}},
  async saveBraderieConfig() { const v=id=>(document.getElementById(id)||{}).value;try{await api('/admin/braderie/config',{method:'PUT',body:{enabled:!!document.getElementById('br-enabled').checked,home_visible:!!document.getElementById('br-home-visible').checked,require_conditions:!!document.getElementById('br-require').checked,hide_external_link:!!document.getElementById('br-hide-link').checked,quartier_required:!!document.getElementById('br-quartier-required').checked,alerts_enabled:!!document.getElementById('br-alerts-enabled').checked,purchase_conditions_enabled:!!document.getElementById('br-purchase-enabled').checked,purchase_confirmation_required:!!document.getElementById('br-purchase-require').checked,purchase_conditions:v('br-purchase-conditions'),geo_modes:{city:!!document.getElementById('br-geo-city').checked,national:!!document.getElementById('br-geo-national').checked,abidjan:!!document.getElementById('br-geo-abidjan').checked,commune:!!document.getElementById('br-geo-commune').checked},max_per_client:v('br-client-max'),max_platform:v('br-platform-max'),limit_period:v('br-period'),max_photos:v('br-photos-max'),offer_limit:v('br-offer-max'),offer_period:v('br-offer-period'),expiry_days:v('br-expiry'),contact_mode:v('br-contact'),conditions:v('br-conditions')}});toast('Règles de la Braderie enregistrées.','ok');render();}catch(e){toast(e.message,'err');}},
  async bradCategoryCreate(){try{await api('/admin/braderie/categories',{method:'POST',body:{name:document.getElementById('brc-name').value,parent_id:document.getElementById('brc-parent').value||null,icon:document.getElementById('brc-icon').value,image_url:document.getElementById('brc-image').value||null}});toast('Référence ajoutée.','ok');render();}catch(e){toast(e.message,'err');}},
  async bradCategoryEdit(id){try{const cs=await api('/admin/braderie/categories'),c=cs.find(x=>Number(x.id)===Number(id));if(!c)return;openModal(`<h3>Modifier la référence</h3><div class="field"><label>Nom</label><input id="brce-name" maxlength="120" value="${esc(c.name)}"></div><div class="field"><label>Description</label><textarea id="brce-desc" maxlength="800">${esc(c.description||'')}</textarea></div><div class="field"><label>URL image (facultatif)</label><input id="brce-image" maxlength="500" value="${esc(c.image_url||'')}"></div><div class="frow"><div><label>Icône</label><input id="brce-icon" maxlength="16" value="${esc(c.icon||'🏷️')}"></div><div><label>Ordre</label><input id="brce-sort" type="number" min="0" value="${Number(c.sort||0)}"></div></div><div class="small bold mt">Diffusions autorisées pour cette référence <span class="muted">(aucune cochée = réglage global)</span></div><div class="frow"><label class="check-line"><input class="brce-mode" type="checkbox" value="city" ${(c.visibility_modes||[]).includes('city')?'checked':''}> Ville</label><label class="check-line"><input class="brce-mode" type="checkbox" value="national" ${(c.visibility_modes||[]).includes('national')?'checked':''}> Côte d’Ivoire</label><label class="check-line"><input class="brce-mode" type="checkbox" value="abidjan" ${(c.visibility_modes||[]).includes('abidjan')?'checked':''}> Abidjan</label><label class="check-line"><input class="brce-mode" type="checkbox" value="commune" ${(c.visibility_modes||[]).includes('commune')?'checked':''}> Commune</label></div><label class="check-line"><input id="brce-active" type="checkbox" ${c.active?'checked':''}> Référence active</label><div class="btn-row"><button class="btn" onclick="A.bradCategoryEditSave(${c.id},this)">Enregistrer</button><button class="btn sec" onclick="closeModal()">Annuler</button></div>`);}catch(e){toast(e.message,'err');}},
  async bradCategoryEditSave(id,btn){busy(btn,true);try{await api('/admin/braderie/categories/'+id,{method:'PUT',body:{name:document.getElementById('brce-name').value,description:document.getElementById('brce-desc').value,icon:document.getElementById('brce-icon').value,image_url:document.getElementById('brce-image').value||null,sort:document.getElementById('brce-sort').value,visibility_modes:[...document.querySelectorAll('.brce-mode:checked')].map(x=>x.value),active:!!document.getElementById('brce-active').checked}});closeModal();toast('Référence mise à jour.','ok');render();}catch(e){toast(e.message,'err');busy(btn,false);}},
  async bradCategoryDelete(id){if(!confirm('Supprimer cette référence ? Les références liées doivent d’abord être réaffectées ou désactivées.'))return;try{await api('/admin/braderie/categories/'+id,{method:'DELETE'});toast('Référence supprimée.','ok');render();}catch(e){toast(e.message,'err');}},
  async bradAdminEdit(id){try{const [all,cfg,cats,villes,communes]=await Promise.all([api('/admin/braderie/items'),api('/admin/braderie/config'),api('/admin/braderie/categories'),api('/admin/villes'),api('/admin/communes')]);const item=all.find(x=>Number(x.id)===Number(id));if(!item)return;const modes=[['city','Ville sélectionnée'],['national','Toute la Côte d’Ivoire'],['abidjan','Abidjan uniquement'],['commune','Commune sélectionnée']].filter(([m])=>cfg.geo_modes[m]);openModal(`<h3>✏️ Modifier l’article</h3><div class="field"><label>Catégorie</label><select id="bre-category">${cats.map(c=>`<option value="${c.id}" ${Number(item.category_id)===Number(c.id)?'selected':''}>${esc(c.parent_name?'↳ ':'')}${esc(c.icon||'🏷️')} ${esc(c.name)}</option>`).join('')}</select></div><div class="field"><label>Titre</label><input id="bre-title" maxlength="120" value="${esc(item.title)}"></div><div class="field"><label>Description</label><textarea id="bre-desc" maxlength="2500">${esc(item.description)}</textarea></div><div class="frow"><div><label>Prix FCFA</label><input id="bre-price" type="number" min="0" value="${Number(item.price)}"></div><div><label>Ville centrale</label><select id="bre-city" onchange="A.bradAdminCityChanged()">${villes.filter(v=>v.active).map(v=>`<option value="${esc(v.name)}" ${v.name===item.city?'selected':''}>${esc(v.name)}</option>`).join('')}</select></div><div><label>Commune Abidjan</label><select id="bre-commune"><option value="">Toutes / non précisée</option>${communes.filter(c=>c.active&&c.city_name==='Abidjan').map(c=>`<option value="${esc(c.name)}" ${c.name===item.commune?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div><div><label>Quartier</label><input id="bre-quartier" maxlength="120" value="${esc(item.quartier||'')}"></div></div><div class="frow"><div><label>État</label><select id="bre-condition">${[['neuf','Neuf'],['tres_bon','Très bon état'],['bon','Bon état'],['a_reparer','À réparer']].map(([v,l])=>`<option value="${v}" ${item.item_condition===v?'selected':''}>${l}</option>`).join('')}</select></div><div><label>Diffusion</label><select id="bre-visibility">${modes.map(([v,l])=>`<option value="${v}" ${(item.visibility_mode||item.visibility)===v?'selected':''}>${l}</option>`).join('')}</select></div></div><div class="btn-row mt"><button class="btn" onclick="A.bradAdminEditSave(${Number(id)},this)">Enregistrer</button><button class="btn sec" onclick="closeModal()">Annuler</button></div>`);}catch(e){toast(e.message,'err');}},
  bradAdminCityChanged(){const city=(document.getElementById('bre-city')||{}).value,commune=document.getElementById('bre-commune');if(commune){commune.disabled=city!=='Abidjan';if(city!=='Abidjan')commune.value='';}}, 
  async bradAdminEditSave(id,btn){busy(btn,true);try{await api('/admin/braderie/items/'+id,{method:'PUT',body:{title:document.getElementById('bre-title').value,description:document.getElementById('bre-desc').value,price:document.getElementById('bre-price').value,category_id:document.getElementById('bre-category').value,city:document.getElementById('bre-city').value,commune:document.getElementById('bre-commune').value,quartier:document.getElementById('bre-quartier').value,item_condition:document.getElementById('bre-condition').value,visibility_mode:document.getElementById('bre-visibility').value}});closeModal();toast('Article modifié et historisé.','ok');render();}catch(e){toast(e.message,'err');busy(btn,false);}},
  async bradAdminStatus(id,status){const note=prompt(status==='available'?'Note de validation (facultative) :':'Motif / note PDG :','');if(note===null)return;try{await api('/admin/braderie/items/'+id,{method:'PUT',body:{status,moderation_note:note}});toast('Article mis à jour.','ok');render();}catch(e){toast(e.message,'err');}},
  async bradAdminReactivate(id){if(!confirm('Réactiver cet article ?'))return;try{await api('/admin/braderie/items/'+id+'/reactivate',{method:'POST'});toast('Article réactivé.','ok');render();}catch(e){toast(e.message,'err');}},
  async bradAdminReport(id,status){const note=prompt('Note de traitement (facultative) :','');if(note===null)return;try{await api('/admin/braderie/reports/'+id,{method:'PUT',body:{status,admin_note:note}});toast('Signalement mis à jour.','ok');render();}catch(e){toast(e.message,'err');}},
  async bradAdminContact(id,status){const note=prompt(status==='approved'?'Note interne / message de transmission :':'Motif de refus :','');if(note===null)return;try{await api('/admin/braderie/contacts/'+id,{method:'PUT',body:{status,admin_note:note}});toast('Demande de contact mise à jour.','ok');render();}catch(e){toast(e.message,'err');}},
  annFiltre(f) { window._annFiltre = f; render(); },
  async annAdd() {
    try {
      await api('/admin/annonces', {
        method: 'POST', body: {
          type: document.getElementById('an-type').value, theme: document.getElementById('an-theme').value,
          content: document.getElementById('an-content').value, color: document.getElementById('an-color').value,
          link: document.getElementById('an-link').value
        }
      });
      toast('Publication ajoutée ✓ — elle défile déjà sur l\u2019accueil.', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async annToggle(id, v) { try { await api('/admin/annonces/' + id, { method: 'PUT', body: { active: v } }); render(); } catch (e) { toast(e.message, 'err'); } },
  async annDel(id) { if (!confirm('Supprimer cette publication du bandeau ?')) return; try { await api('/admin/annonces/' + id, { method: 'DELETE' }); render(); } catch (e) { toast(e.message, 'err'); } },
  async annMove(id, dir) {
    try {
      const list = await api('/admin/annonces');
      const i = list.findIndex(a => a.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return;
      await api('/admin/annonces/' + list[i].id, { method: 'PUT', body: { sort: list[j].sort } });
      await api('/admin/annonces/' + list[j].id, { method: 'PUT', body: { sort: list[i].sort } });
      render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async annEdit(id) {
    try {
      const a = (await api('/admin/annonces')).find(x => x.id === id);
      if (!a) return;
      openModal(`<h3>✏️ Modifier la publication</h3>
        <div class="frow"><div><label>Type</label><select id="ae-type">
          <option value="pub" ${a.type === 'pub' ? 'selected' : ''}>📢 Publicité</option>
          <option value="info" ${a.type === 'urgence' || a.type === 'pub' ? '' : 'selected'}>ℹ️ Information</option>
          <option value="urgence" ${a.type === 'urgence' ? 'selected' : ''}>🚨 Urgence</option></select></div>
        <div style="flex:1"><label>Thème (entre parenthèses)</label><input id="ae-theme" value="${esc(a.theme || '')}" style="width:100%" placeholder="Sport, Éducation, Paiement…"></div></div>
        <div><label>Message</label><input id="ae-content" value="${esc(a.content)}" style="width:100%"></div>
        <div class="frow" style="margin-top:6px"><div><label>Couleur</label><input type="color" id="ae-color" value="${esc(a.color)}" style="width:50px;height:34px;padding:2px"></div>
        <div style="flex:1"><label>Lien (optionnel)</label><input id="ae-link" value="${esc(a.link || '')}" style="width:100%"></div></div>
        <div style="margin-top:10px"><button class="btn" onclick="A._annSave(${a.id})">Enregistrer</button>
        <button class="btn sec" onclick="closeModal()">Annuler</button></div>`);
    } catch (e) { toast(e.message, 'err'); }
  },
  async _annSave(id) {
    try {
      await api('/admin/annonces/' + id, {
        method: 'PUT', body: {
          type: document.getElementById('ae-type').value, theme: document.getElementById('ae-theme').value,
          content: document.getElementById('ae-content').value, color: document.getElementById('ae-color').value,
          link: document.getElementById('ae-link').value
        }
      });
      toast('Publication modifiée ✓', 'ok'); closeModal(); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  async toggleAd(id, v) { try { await api('/admin/ads/' + id, { method: 'PUT', body: { active: v } }); render(); } catch (e) { toast(e.message, 'err'); } },
  async delAd(id) { if (!confirm('Supprimer cette publicité ?')) return; try { await api('/admin/ads/' + id, { method: 'DELETE' }); render(); } catch (e) { toast(e.message, 'err'); } },
  previewGeneralMessage() {
    const title=(document.getElementById('gm-title')||{}).value||'', body=(document.getElementById('gm-body')||{}).value||'';
    const types=[...(document.getElementById('gm-clients')?.checked?['Clients']:[]),...(document.getElementById('gm-pros')?.checked?['Professionnels validés']:[])];
    const cities=[...((document.getElementById('gm-cities')||{}).selectedOptions||[])].map(o=>o.value);
    openModal(`<h3>👁️ Aperçu du message</h3><div class="card"><b>${esc(title || 'Sans titre')}</b><div class="small" style="white-space:pre-wrap;margin-top:8px">${esc(body || 'Sans contenu')}</div></div><p class="small muted">Destinataires : ${esc(types.join(' et ') || 'Tous les utilisateurs')}<br>Villes : ${esc(cities.join(', ') || 'Toutes les villes')}</p><button class="btn sec" onclick="closeModal()">Fermer</button>`);
  },
  async generalMessage(mode) {
    const cities = [...document.getElementById('gm-cities').selectedOptions].map(o => o.value);
    try { const r = await api('/admin/general-messages', { method:'POST', body:{ title:document.getElementById('gm-title').value, body:document.getElementById('gm-body').value, account_types:[...(document.getElementById('gm-clients').checked?['clients']:[]),...(document.getElementById('gm-pros').checked?['pros']:[])], cities, mode, scheduled_at:document.getElementById('gm-date').value } }); toast(mode==='immediate' ? `Message envoyé : ${r.sent||0} notification(s) enregistrée(s).` : mode==='scheduled' ? 'Message programmé ✓' : 'Brouillon enregistré ✓','ok'); render(); } catch(e){ toast(e.message,'err'); }
  },
  async sendGeneralMessage(id) { if (!confirm('Envoyer ce brouillon maintenant ?')) return; try { const r=await api('/admin/general-messages/'+id+'/send',{method:'POST'}); toast(`${r.delivered} notification(s) enregistrée(s).`,'ok');render(); } catch(e){toast(e.message,'err');} },
  async deleteGeneralMessage(id) { if (!confirm('Supprimer ce brouillon ?')) return; try { await api('/admin/general-messages/'+id,{method:'DELETE'});toast('Brouillon supprimé.','ok');render(); } catch(e){toast(e.message,'err');} },
  async editGeneralMessage(id) { try { const [all,villes]=await Promise.all([api('/admin/general-messages'),api('/admin/villes')]); const m=all.find(x=>x.id===id); if(!m)return; openModal(`<h3>Modifier le brouillon</h3><label>Titre</label><input id="eg-title" style="width:100%" value="${esc(m.title)}"><label>Message</label><textarea id="eg-body">${esc(m.body||'')}</textarea><label class="check-line"><input id="eg-clients" type="checkbox" ${m.account_types.includes('clients')?'checked':''}> Clients</label><label class="check-line"><input id="eg-pros" type="checkbox" ${m.account_types.includes('pros')?'checked':''}> Professionnels validés</label><label>Villes</label><select id="eg-cities" multiple size="6" style="width:100%">${villes.map(v=>`<option value="${esc(v.name)}" ${m.cities.includes(v.name)?'selected':''}>${esc(v.name)}</option>`).join('')}</select><div class="btn-row mt"><button class="btn" onclick="A.updateGeneralMessage(${id})">Enregistrer</button><button class="btn sec" onclick="closeModal()">Annuler</button></div>`); } catch(e){toast(e.message,'err');} },
  async updateGeneralMessage(id) { try { await api('/admin/general-messages/'+id,{method:'PUT',body:{title:document.getElementById('eg-title').value,body:document.getElementById('eg-body').value,account_types:[...(document.getElementById('eg-clients').checked?['clients']:[]),...(document.getElementById('eg-pros').checked?['pros']:[])],cities:[...document.getElementById('eg-cities').selectedOptions].map(o=>o.value)}});closeModal();toast('Brouillon modifié ✓','ok');render(); }catch(e){toast(e.message,'err');} },
  addAboutParagraph() { const box=document.getElementById('about-paragraphs'); if(box) box.insertAdjacentHTML('beforeend',aboutParagraphHtml({},box.children.length)); },
  aboutData() { return { title:(document.getElementById('about-title')||{}).value||'', paragraphs:[...document.querySelectorAll('.about-row')].map(r=>({heading:r.querySelector('.about-heading').value,text:r.querySelector('.about-text').value})).filter(p=>p.heading.trim()||p.text.trim()) }; },
  async previewAbout() { const d=A.aboutData(); openModal(`<h3>${esc(d.title)}</h3>${d.paragraphs.map(p=>`<div class="mb"><b>${esc(p.heading)}</b><div class="small" style="white-space:pre-wrap">${esc(p.text)}</div></div>`).join('')}<button class="btn sec" onclick="closeModal()">Fermer</button>`); },
  async saveAbout(publish) { try { await api('/admin/about',{method:'PUT',body:A.aboutData()}); if(publish){if(!confirm('Publier ce brouillon dans l’application ?'))return;await api('/admin/about/publish',{method:'POST'});}toast(publish?'Contenu publié ✓':'Brouillon enregistré ✓','ok');render(); }catch(e){toast(e.message,'err');} },
  async saveShareSettings() { try { await api('/admin/settings',{method:'PUT',body:{share_official_url:document.getElementById('share-url').value,share_text:document.getElementById('share-text').value}});toast('Réglages de partage enregistrés ✓','ok'); }catch(e){toast(e.message,'err');} },
  frequencyPeriod(days) { FREQ_QUERY='days='+days; FREQ_PRESET=String(days)+'jours'; render(); },
  frequencyPreset(name) {
    const today = new Date(), iso = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0,10); };
    const shift = (d,n) => { const x=new Date(d); x.setDate(x.getDate()+n); return x; };
    let from, to;
    if (name==='today') from=to=iso(today);
    else if (name==='yesterday') from=to=iso(shift(today,-1));
    else if (name==='week' || name==='lastweek') { const day=(today.getDay()+6)%7; const monday=shift(today,-day-(name==='lastweek'?7:0)); from=iso(monday); to=iso(shift(monday,name==='lastweek'?6:0)); }
    else if (name==='month') { from=iso(new Date(today.getFullYear(),today.getMonth(),1)); to=iso(today); }
    else { const first=new Date(today.getFullYear(),today.getMonth()-1,1), last=new Date(today.getFullYear(),today.getMonth(),0); from=iso(first); to=iso(last); }
    FREQ_QUERY='from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to); FREQ_PRESET=name; render();
  },
  frequencyCustom() { const from=(document.getElementById('fq-from')||{}).value, to=(document.getElementById('fq-to')||{}).value; if(!from||!to) return toast('Choisissez les deux dates.','err'); FREQ_QUERY='from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to); FREQ_PRESET='custom'; render(); },
  async saveRules(key, elId) { try { await api('/admin/settings', { method: 'PUT', body: { [key]: document.getElementById(elId).value } }); toast('Règles enregistrées ✓ (appliquées immédiatement dans l\u2019application)', 'ok'); } catch (e) { toast(e.message, 'err'); } },
  async treatReport(id) { try { await api(`/admin/signalements/${id}/traiter`, { method: 'POST' }); render(); } catch (e) { toast(e.message, 'err'); } },
  async treatUrg(id) { try { await api(`/admin/urgences/${id}/traiter`, { method: 'POST' }); render(); } catch (e) { toast(e.message, 'err'); } },
  filesSearch() {
    sessionStorage.setItem('adm_fq', (document.getElementById('files-q') || {}).value || '');
    sessionStorage.setItem('adm_ft', (document.getElementById('files-type') || {}).value || 'all');
    sessionStorage.setItem('adm_ffrom', (document.getElementById('files-from') || {}).value || '');
    sessionStorage.setItem('adm_fto', (document.getElementById('files-to') || {}).value || '');
    sessionStorage.setItem('adm_fp', '1'); render();
  },
  filesReset() { ['adm_fq','adm_ft','adm_ffrom','adm_fto','adm_fp'].forEach(k => sessionStorage.removeItem(k)); render(); },
  filesPage(n) { sessionStorage.setItem('adm_fp', String(Math.max(1, n))); render(); },
  async downloadAdminFile(pathname, filename) {
    try {
      const r = await fetch('/api/admin' + pathname, { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Téléchargement impossible.'); }
      const cd = r.headers.get('content-disposition') || '';
      const utfName = (cd.match(/filename\*=UTF-8''([^;]+)/i) || [])[1];
      const normalName = (cd.match(/filename="([^"]+)"/i) || [])[1];
      let serverName = ''; try { serverName = utfName ? decodeURIComponent(utfName) : (normalName || ''); } catch { serverName = normalName || ''; }
      const total = Number(r.headers.get('content-length') || 0);
      const progress = document.createElement('div'); progress.className = 'download-progress';
      progress.innerHTML = `<b>Préparation du téléchargement…</b><div class="small muted" id="download-progress-text">${total ? '0 %' : 'Réception en cours…'}</div><div class="download-progress-bar"><i></i></div>`;
      document.body.appendChild(progress);
      let blob;
      try {
        if (r.body && r.body.getReader) {
          const reader = r.body.getReader(), chunks = []; let received = 0;
          for (;;) { const part = await reader.read(); if (part.done) break; chunks.push(part.value); received += part.value.length;
            const pct = total ? Math.min(100, Math.round(received * 100 / total)) : null;
            const text = progress.querySelector('#download-progress-text'), bar = progress.querySelector('i');
            if (text) text.textContent = pct === null ? `${Math.round(received / 1024)} Ko reçus…` : pct + ' %';
            if (bar && pct !== null) bar.style.width = pct + '%';
          }
          blob = new Blob(chunks, { type: r.headers.get('content-type') || 'application/octet-stream' });
        } else blob = await r.blob();
      } finally { progress.remove(); }
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = serverName || filename || 'klean-services-fichier'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Téléchargement lancé ✓', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  downloadClient(id) { A.downloadAdminFile('/files/clients/' + id + '/download', 'klean-services-echanges-client-' + id + '.zip'); },
  async openClientFiles(id) {
    try {
      const d = await api('/admin/files/clients/' + id); const c = d.client;
      const itemHtml = i => {
        const date = fmtD(i.created_at), title = esc(i.label || 'Échange');
        const mediaName = i.file ? encodeURIComponent(i.file.split('/').pop()) : '';
        const download = i.file
          ? `<button class="btn sm" onclick="A.downloadAdminFile('/files/clients/${c.id}/media/${mediaName}/download')">⬇ Télécharger</button>`
          : `<button class="btn sm" onclick="A.downloadAdminFile('/files/clients/${c.id}/text/${i.source}/${encodeURIComponent(i.id)}/download')">⬇ Télécharger</button>`;
        let body = '';
        if (i.type === 'audio') body = `<audio controls preload="metadata" src="${esc(mediaUrl(i.file))}" style="max-width:100%"></audio>`;
        else if (i.type === 'image') body = `<a href="${esc(mediaUrl(i.file))}" target="_blank" rel="noopener"><img src="${esc(mediaUrl(i.file))}" alt="Photo" style="display:block;max-width:160px;max-height:115px;border-radius:8px;object-fit:cover"></a>`;
        else body = `<div style="white-space:pre-wrap;word-break:break-word">${esc(i.content || '')}</div>`;
        return `<div style="border:1px solid #e2e8e6;border-radius:10px;padding:10px;margin:8px 0"><div class="small muted">${i.type === 'audio' ? '🎤 Vocal' : i.type === 'image' ? '🖼️ Photo' : '💬 Texte'} • ${title} • ${date}</div><div style="margin:6px 0">${body}</div>${download}</div>`;
      };
      openModal(`<h3>📂 ${esc(c.name)}</h3><div class="small muted">${esc(c.phone || '')} • ${esc(c.ville || '')}${c.quartier ? ' / ' + esc(c.quartier) : ''}</div>
        <div class="frow" style="margin:10px 0"><span class="pill info">💬 ${d.texts} texte(s)</span><span class="pill warn">🎤 ${d.audios} vocal(aux)</span><span class="pill ok">🖼️ ${d.images} photo(s)</span><button class="btn sm" onclick="A.downloadClient(${c.id})">⬇ Tout télécharger (.zip)</button></div>
        <div style="max-height:55vh;overflow:auto">${d.items.length ? d.items.map(itemHtml).join('') : '<div class="muted">Aucun élément associé.</div>'}</div><button class="btn sec mt" onclick="closeModal()">Fermer</button>`);
    } catch (e) { toast(e.message, 'err'); }
  },
  async fileRegistry() {
    try {
      const d = await api('/admin/files/records');
      const fmtBytes = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' Mo' : n > 1024 ? (n / 1024).toFixed(1) + ' Ko' : (n || 0) + ' o';
      const stateLabel = { active: 'Actif', hidden: 'Masqué', archived: 'Archivé', recovery: 'Récupération', purged: 'Supprimé' };
      const rows = d.records.map(f => `<tr><td><input type="checkbox" class="fr-check" value="${esc(f.name)}" ${f.state === 'purged' ? 'disabled' : ''}></td><td class="small" style="max-width:180px;word-break:break-all"><b>${esc(f.name)}</b><br><span class="muted">${esc(f.uploader_name || 'Ancien fichier')} • ${fmtBytes(f.size)} • ${esc(f.mime || 'type inconnu')}</span></td><td><span class="pill ${f.state === 'purged' ? 'bad' : f.state === 'recovery' ? 'warn' : f.state === 'archived' ? 'info' : 'ok'}">${stateLabel[f.state] || f.state}</span>${f.delete_after ? `<br><span class="small muted">purge : ${fmtD(f.delete_after)}</span>` : ''}</td><td class="small">${fmtD(f.created_at)}</td><td style="white-space:nowrap">${f.state !== 'purged' ? `${f.state !== 'active' ? `<button class="btn sm" onclick="A.fileState('${esc(f.name)}','active')">Restaurer</button> ` : ''}<button class="btn sm sec" onclick="A.fileState('${esc(f.name)}','hidden')">Masquer</button> <button class="btn sm sec" onclick="A.fileState('${esc(f.name)}','archived')">Archiver</button> <button class="btn sm warn" onclick="A.fileState('${esc(f.name)}','recovery')">À supprimer</button>${f.state === 'recovery' ? ` <button class="btn sm warn" onclick="A.filePermanentDelete('${esc(f.name)}')">Purger définitivement</button>` : ''}` : ''}</td></tr>`).join('');
      openModal(`<h3>🗃️ Registre des fichiers</h3><p class="small muted">Cochez les fichiers pour télécharger une sélection ZIP. « À supprimer » les rend récupérables pendant ${d.recovery_days} jour(s), puis la purge retire réellement le binaire local et Render/PostgreSQL.</p><div class="frow"><button class="btn sm" onclick="A.fileDownload(false)">⬇ Télécharger la sélection</button><button class="btn sm sec" onclick="A.fileDownload(true)">⬇ Tous les fichiers disponibles</button><button class="btn sm warn" onclick="A.fileBulkRecovery()">Mettre la sélection à supprimer</button></div><div style="max-height:55vh;overflow:auto"><table><tr><th></th><th>Fichier</th><th>État</th><th>Date</th><th>Actions</th></tr>${rows || '<tr><td colspan="5" class="muted">Aucun fichier enregistré.</td></tr>'}</table></div><button class="btn sec mt" onclick="closeModal()">Fermer</button>`);
    } catch (e) { toast(e.message, 'err'); }
  },
  _selectedRecords() { return [...document.querySelectorAll('.fr-check:checked')].map(x => x.value); },
  async fileState(name, state) {
    const isPurge = state === 'recovery';
    const note = prompt(isPurge ? 'Motif (facultatif) — le fichier sera récupérable avant la suppression réelle :' : 'Note interne (facultative) :');
    if (note === null) return;
    if (isPurge && !confirm('Placer ce fichier en récupération ? Il sera réellement supprimé après le délai configuré.')) return;
    try { await api('/admin/files/' + encodeURIComponent(name) + '/state', { method: 'POST', body: { state, note } }); toast(isPurge ? 'Fichier placé en récupération.' : 'État du fichier mis à jour.', 'ok'); A.fileRegistry(); } catch (e) { toast(e.message, 'err'); }
  },
  async filePermanentDelete(name) {
    if (!confirm('SUPPRESSION DÉFINITIVE : « ' + name + ' » sera retiré du stockage serveur et ne pourra plus être récupéré. Continuer ?')) return;
    const note = prompt('Motif de suppression définitive (facultatif) :'); if (note === null) return;
    try { await api('/admin/files/' + encodeURIComponent(name) + '/state', { method: 'POST', body: { state: 'purged', confirmed: true, note } }); toast('Fichier supprimé définitivement du stockage.', 'ok'); A.fileRegistry(); }
    catch (e) { toast(e.message, 'err'); }
  },
  async fileBulkRecovery() {
    const names = A._selectedRecords(); if (!names.length) return toast('Sélectionnez au moins un fichier.', 'err');
    if (!confirm(`Placer ${names.length} fichier(s) en récupération avant suppression réelle ?`)) return;
    try { for (const name of names) await api('/admin/files/' + encodeURIComponent(name) + '/state', { method: 'POST', body: { state: 'recovery', note: 'Sélection du tableau de bord' } }); toast(`${names.length} fichier(s) placé(s) en récupération.`, 'ok'); A.fileRegistry(); } catch (e) { toast(e.message, 'err'); }
  },
  fileDownload(all) {
    const names = A._selectedRecords(); if (!all && !names.length) return toast('Sélectionnez au moins un fichier.', 'err');
    const query = all ? '?all=1' : '?names=' + encodeURIComponent(names.join(','));
    A.downloadAdminFile('/files/records/download' + query, all ? 'klean-services-tous-fichiers.zip' : 'klean-services-selection.zip');
  },
  async cleanup() { try { const r = await api('/admin/files/cleanup', { method: 'POST' }); toast(`Nettoyage terminé : ${r.deleted} fichier(s) récupérables supprimé(s).`, 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async avisStatus(id, st) { try { await api(`/admin/avis-recherche/${id}/status`, { method: 'POST', body: { status: st } }); toast('Statut mis à jour ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async jobStatus(id, st) { try { await api(`/admin/jobs/${id}/status`, { method: 'POST', body: { status: st } }); toast('Statut mis à jour ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async jobOfferStatus(id, st) { try { await api(`/admin/job-offers/${id}/status`, { method:'POST', body:{status:st} }); toast('Statut mis à jour ✓','ok'); render(); } catch(e){toast(e.message,'err');} },
  avisCategoryForm(id) { const c=id && window._avisCategories && window._avisCategories.find(x=>x.id===id); openModal(`<h3>${c?'Modifier':'Ajouter'} une catégorie d’avis</h3><div class="field"><label>Nom</label><input id="ac-name" value="${esc(c?c.name:'')}"></div><div class="field"><label>Description</label><textarea id="ac-desc">${esc(c?c.description:'')}</textarea></div><div class="field"><label>Ordre</label><input type="number" id="ac-sort" value="${c?c.sort:99}"></div><button class="btn" onclick="A.saveAvisCategory(${id||0},this)">Enregistrer</button>`); },
  async saveAvisCategory(id,btn) { try { const body={name:document.getElementById('ac-name').value,description:document.getElementById('ac-desc').value,sort:document.getElementById('ac-sort').value}; await api('/admin/avis-categories'+(id?'/'+id:''),{method:id?'PUT':'POST',body}); closeModal();toast('Catégorie enregistrée ✓','ok');render();}catch(e){toast(e.message,'err');} },
  async avisCategoryState(id,active) { try {await api('/admin/avis-categories/'+id,{method:'PUT',body:{active}});toast('Catégorie mise à jour ✓','ok');render();}catch(e){toast(e.message,'err');} },
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
  async quizPause(id) { if (!confirm('Mettre le quiz en pause ? Le chronomètre serveur sera figé pour tous.')) return; try { await api(`/admin/quiz-sessions/${id}/pause`, { method: 'POST' }); toast('Quiz en pause ⏸️', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async quizReprendre(id) { try { await api(`/admin/quiz-sessions/${id}/reprendre`, { method: 'POST' }); toast('Quiz repris ▶️', 'ok'); render(); } catch (e) { toast(e.message, 'err'); } },
  async quizRejouer(id) {
    if (!confirm('Rejouer cette série ? Les réponses et les statuts des participants seront réinitialisés, et la série redémarrera immédiatement pour tout le monde. (Les messages des anciens gagnants sont conservés dans les détails.)')) return;
    try { await api(`/admin/quiz-sessions/${id}/rejouer`, { method: 'POST', body: { confirmed: true } }); toast('Série relancée 🔄 — la question 1 s\u2019affiche sur les accueils.', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  },
  async quizSessionDel(id) {
    if (!confirm('Supprimer ce quiz ? Les réponses, participants et messages liés seront définitivement effacés.')) return;
    try { await api('/admin/quiz-sessions/' + id, { method: 'DELETE' }); render(); } catch (e) { toast(e.message, 'err'); }
  },
  async quizArchive(id) { try { const a = await api('/admin/quiz-archives/' + id); const s = a.snapshot || {}; openModal(`<h3>🗄️ Archive — ${esc(a.title)}</h3><div class="small muted">${fmtD(a.archived_at)} • ${esc(s.reason || '')}</div><div class="frow mt"><span class="pill info">👥 ${(s.participants || []).length} participant(s)</span><span class="pill info">📝 ${(s.answers || []).length} réponse(s)</span></div><div style="max-height:300px;overflow:auto;margin-top:10px"><table><tr><th>Utilisateur</th><th>Statut</th><th>Score</th><th>Temps</th></tr>${(s.participants || []).map(p => `<tr><td>#${p.user_id}</td><td>${esc(p.status)}</td><td>${p.score}</td><td>${Math.round((p.total_ms || 0)/1000)} s</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Aucun participant.</td></tr>'}</table></div><button class="btn sec mt" onclick="closeModal()">Fermer</button>`); } catch (e) { toast(e.message, 'err'); } },
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
          dispatch_initial_alert_count: document.getElementById('st-wave1').value,
          dispatch_expand_alert_count: document.getElementById('st-wave2').value,
          dispatch_reminder_seconds: document.getElementById('st-reminder').value,
          dispatch_auto_enabled: document.getElementById('st-auto').checked ? '1' : '0',
          dispatch_geo_enabled: document.getElementById('st-geo').checked ? '1' : '0',
          dispatch_alert_sound: document.getElementById('st-sound').checked ? '1' : '0',
          dispatch_allow_particulier: document.getElementById('st-particulier').checked ? '1' : '0',
          dispatch_allow_entreprise: document.getElementById('st-entreprise').checked ? '1' : '0',
          dispatch_max_reminders: document.getElementById('st-maxrem').value,
          dispatch_search_max_seconds: document.getElementById('st-searchmax').value,
          chat_text_limit: document.getElementById('st-chattext').value,
          chat_image_limit: document.getElementById('st-chatimages').value,
          chat_audio_max_seconds: document.getElementById('st-chataudio').value,
          file_recovery_days: document.getElementById('st-recovery').value,
          file_retention_days: document.getElementById('st-ret').value,
          request_image_limit: document.getElementById('st-reqphotos').value,
          request_audio_max_seconds: document.getElementById('st-reqaudio').value,
          activity_active_minutes: document.getElementById('st-activity').value
        }
      });
      toast('Paramètres enregistrés ✓ (appliqués immédiatement)', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  async saveUrgence() {
    const contacts = document.getElementById('st-urgc').value.split('\n').map(l => { const [nom,tel,verified] = l.split('|').map(s=>(s||'').trim()); return nom&&tel ? {nom,tel,verified:/^(oui|yes|true|1)$/i.test(verified||'')} : null; }).filter(Boolean);
    const categories = document.getElementById('st-urgcats').value.split('\n').map(l => { const [name,description] = l.split('|').map(s=>(s||'').trim()); return name ? {name,description,active:true} : null; }).filter(Boolean);
    try { await api('/admin/settings',{method:'PUT',body:{urgence_info:document.getElementById('st-urginfo').value,urgence_contacts:JSON.stringify(contacts),urgence_categories:JSON.stringify(categories),urgence_assistance_enabled:document.getElementById('st-urgavailable').checked?'1':'0'}});toast('Configuration d’urgence enregistrée ✓','ok');render(); } catch(e){toast(e.message,'err');}
  },
  async cabineSettings(){try{await api('/admin/cabine/settings',{method:'PUT',body:{cabine_enabled:document.getElementById('cab-enabled').checked,cabine_title:document.getElementById('cab-title').value,cabine_icon:document.getElementById('cab-icon').value,cabine_color:document.getElementById('cab-color').value,cabine_description:document.getElementById('cab-description').value,cabine_unavailable_message:document.getElementById('cab-unavailable').value,cabine_conditions:document.getElementById('cab-conditions').value,cabine_operator_detection:document.getElementById('cab-detect').checked,cabine_manual_operator:document.getElementById('cab-manual').checked,cabine_custom_amount:document.getElementById('cab-custom').checked}});toast('Paramètres Klean Cabine enregistrés. Le paiement reste verrouillé.','ok');render();}catch(e){toast(e.message,'err');}},
  async cabineOperatorEdit(id){try{const d=await api('/admin/cabine/overview'),o=id?d.operators.find(x=>Number(x.id)===Number(id)):null,x=o||{code:'',name:'',description:'',color:'#166534',enabled:false,transfer_enabled:false,bundles_enabled:false,min_amount:'',max_amount:'',conditions:'',sort:0};openModal(`<h3>${o?'Modifier':'Ajouter'} un opérateur</h3><div class="hint">La configuration du catalogue ne connecte pas l’opérateur. L’état API reste contrôlé par une intégration officielle vérifiée.</div><div class="frow"><div><label>Code</label><input id="co-code" maxlength="30" value="${esc(x.code)}"></div><div><label>Nom</label><input id="co-name" maxlength="100" value="${esc(x.name)}"></div><div><label>Couleur</label><input id="co-color" maxlength="20" value="${esc(x.color||'#166534')}"></div></div><label>Description</label><textarea id="co-desc" maxlength="500">${esc(x.description||'')}</textarea><div class="frow"><div><label>Minimum FCFA</label><input id="co-min" type="number" min="0" value="${x.min_amount??''}"></div><div><label>Maximum FCFA</label><input id="co-max" type="number" min="0" value="${x.max_amount??''}"></div><div><label>Ordre</label><input id="co-sort" type="number" min="0" value="${Number(x.sort||0)}"></div></div><label>Conditions</label><textarea id="co-conditions" maxlength="3000">${esc(x.conditions||'')}</textarea><label class="check-line"><input id="co-enabled" type="checkbox" ${x.enabled?'checked':''}> Afficher au catalogue</label><label class="check-line"><input id="co-transfer" type="checkbox" ${x.transfer_enabled?'checked':''}> Préparer la catégorie transfert</label><label class="check-line"><input id="co-bundles" type="checkbox" ${x.bundles_enabled?'checked':''}> Préparer les catégories forfait</label><div class="btn-row"><button class="btn" onclick="A.cabineOperatorSave(${o?o.id:'null'},this)">Enregistrer</button><button class="btn sec" onclick="closeModal()">Annuler</button></div>`);}catch(e){toast(e.message,'err');}},
  async cabineOperatorSave(id,btn){busy(btn,true);try{const body={code:document.getElementById('co-code').value,name:document.getElementById('co-name').value,color:document.getElementById('co-color').value,description:document.getElementById('co-desc').value,min_amount:document.getElementById('co-min').value,max_amount:document.getElementById('co-max').value,sort:document.getElementById('co-sort').value,conditions:document.getElementById('co-conditions').value,enabled:document.getElementById('co-enabled').checked,transfer_enabled:document.getElementById('co-transfer').checked,bundles_enabled:document.getElementById('co-bundles').checked};await api('/admin/cabine/operators'+(id?'/'+id:''),{method:id?'PUT':'POST',body});closeModal();toast('Opérateur administré. API non connectée.','ok');render();}catch(e){toast(e.message,'err');busy(btn,false);}},
  async cabineServiceEdit(id){try{const d=await api('/admin/cabine/overview'),x=id?d.services.find(s=>Number(s.id)===Number(id)):null,o=x||{code:'',name:'',description:'',icon:'📱',color:'#166534',service_type:'bundle',enabled:true,sort:0};openModal(`<h3>${x?'Modifier':'Ajouter'} un service</h3><div class="frow"><div><label>Code</label><input id="cs-code" maxlength="30" value="${esc(o.code)}"></div><div><label>Nom</label><input id="cs-name" maxlength="100" value="${esc(o.name)}"></div><div><label>Icône</label><input id="cs-icon" maxlength="20" value="${esc(o.icon||'📱')}"></div></div><label>Description</label><textarea id="cs-desc" maxlength="500">${esc(o.description||'')}</textarea><div class="frow"><div><label>Type</label><select id="cs-type"><option value="bundle" ${o.service_type==='bundle'?'selected':''}>Forfait</option><option value="transfer" ${o.service_type==='transfer'?'selected':''}>Transfert</option></select></div><div><label>Couleur</label><input id="cs-color" maxlength="20" value="${esc(o.color||'#166534')}"></div><div><label>Ordre</label><input id="cs-sort" type="number" min="0" value="${Number(o.sort||0)}"></div></div><label class="check-line"><input id="cs-enabled" type="checkbox" ${o.enabled?'checked':''}> Visible</label><div class="btn-row"><button class="btn" onclick="A.cabineServiceSave(${x?x.id:'null'},this)">Enregistrer</button><button class="btn sec" onclick="closeModal()">Annuler</button></div>`);}catch(e){toast(e.message,'err');}},
  async cabineServiceSave(id,btn){busy(btn,true);try{const body={code:document.getElementById('cs-code').value,name:document.getElementById('cs-name').value,icon:document.getElementById('cs-icon').value,description:document.getElementById('cs-desc').value,service_type:document.getElementById('cs-type').value,color:document.getElementById('cs-color').value,sort:document.getElementById('cs-sort').value,enabled:document.getElementById('cs-enabled').checked};await api('/admin/cabine/services'+(id?'/'+id:''),{method:id?'PUT':'POST',body});closeModal();toast('Catégorie enregistrée.','ok');render();}catch(e){toast(e.message,'err');busy(btn,false);}},
  async cabineOfferEdit(id){try{const d=await api('/admin/cabine/overview'),x=id?d.offers.find(o=>Number(o.id)===Number(id)):null,o=x||{operator_id:'',service_id:'',name:'',description:'',benefit:'',validity_text:'',provider_price:0,customer_price:0,fee_fixed:0,fee_percent:0,visible:true,enabled:false,conditions:'',sort:0};openModal(`<h3>${x?'Modifier':'Ajouter'} une offre</h3><div class="hint">Aucune offre ne peut être achetée ou exécutée sans intégration officielle ultérieure.</div><div class="frow"><div><label>Opérateur</label><select id="cf-operator">${d.operators.map(q=>`<option value="${q.id}" ${Number(o.operator_id)===Number(q.id)?'selected':''}>${esc(q.name)}</option>`).join('')}</select></div><div><label>Catégorie</label><select id="cf-service">${d.services.map(q=>`<option value="${q.id}" ${Number(o.service_id)===Number(q.id)?'selected':''}>${esc(q.name)}</option>`).join('')}</select></div></div><label>Nom</label><input id="cf-name" maxlength="160" value="${esc(o.name)}"><label>Description</label><textarea id="cf-desc" maxlength="1000">${esc(o.description||'')}</textarea><div class="frow"><div><label>Avantage</label><input id="cf-benefit" maxlength="500" value="${esc(o.benefit||'')}"></div><div><label>Validité texte</label><input id="cf-validity" maxlength="200" value="${esc(o.validity_text||'')}"></div></div><div class="frow"><div><label>Prix fournisseur FCFA</label><input id="cf-provider" type="number" min="0" value="${Number(o.provider_price||0)}"></div><div><label>Prix client FCFA</label><input id="cf-customer" type="number" min="0" value="${Number(o.customer_price||0)}"></div><div><label>Frais fixes FCFA</label><input id="cf-fixed" type="number" min="0" value="${Number(o.fee_fixed||0)}"></div><div><label>Frais %</label><input id="cf-pct" type="number" min="0" max="100" step="0.01" value="${Number(o.fee_percent||0)}"></div></div><label>Conditions</label><textarea id="cf-conditions" maxlength="3000">${esc(o.conditions||'')}</textarea><div class="frow"><div><label>Ordre</label><input id="cf-sort" type="number" min="0" value="${Number(o.sort||0)}"></div></div><label class="check-line"><input id="cf-visible" type="checkbox" ${o.visible?'checked':''}> Afficher dans le catalogue</label><label class="check-line"><input id="cf-enabled" type="checkbox" ${o.enabled?'checked':''}> Préparer lorsque le connecteur sera validé</label><div class="btn-row"><button class="btn" onclick="A.cabineOfferSave(${x?x.id:'null'},this)">Enregistrer</button><button class="btn sec" onclick="closeModal()">Annuler</button></div>`);}catch(e){toast(e.message,'err');}},
  async cabineOfferSave(id,btn){busy(btn,true);try{const body={operator_id:document.getElementById('cf-operator').value,service_id:document.getElementById('cf-service').value,name:document.getElementById('cf-name').value,description:document.getElementById('cf-desc').value,benefit:document.getElementById('cf-benefit').value,validity_text:document.getElementById('cf-validity').value,provider_price:document.getElementById('cf-provider').value,customer_price:document.getElementById('cf-customer').value,fee_fixed:document.getElementById('cf-fixed').value,fee_percent:document.getElementById('cf-pct').value,conditions:document.getElementById('cf-conditions').value,sort:document.getElementById('cf-sort').value,visible:document.getElementById('cf-visible').checked,enabled:document.getElementById('cf-enabled').checked};await api('/admin/cabine/offers'+(id?'/'+id:''),{method:id?'PUT':'POST',body});closeModal();toast('Offre enregistrée ; exécution toujours bloquée.','ok');render();}catch(e){toast(e.message,'err');busy(btn,false);}},
  async cabineDelete(kind,id){if(!confirm('Supprimer cet élément ? Les éléments liés à un historique seront protégés.'))return;try{await api('/admin/cabine/'+kind+'/'+id,{method:'DELETE'});toast('Élément supprimé.','ok');render();}catch(e){toast(e.message,'err');}},
  async cabineTemplateEdit(code){try{const d=await api('/admin/cabine/overview'),x=d.templates.find(t=>t.code===code);if(!x)return;openModal(`<h3>Modèle ${esc(code)}</h3><label>Titre</label><input id="ct-title" maxlength="160" value="${esc(x.title)}"><label>Contenu</label><textarea id="ct-body" maxlength="2000">${esc(x.body)}</textarea><label class="check-line"><input id="ct-enabled" type="checkbox" ${x.enabled?'checked':''}> Actif</label><div class="btn-row"><button class="btn" onclick="A.cabineTemplateSave('${esc(code)}',this)">Enregistrer</button><button class="btn sec" onclick="closeModal()">Annuler</button></div>`);}catch(e){toast(e.message,'err');}},
  async cabineTemplateSave(code,btn){busy(btn,true);try{await api('/admin/cabine/templates/'+encodeURIComponent(code),{method:'PUT',body:{title:document.getElementById('ct-title').value,body:document.getElementById('ct-body').value,enabled:document.getElementById('ct-enabled').checked}});closeModal();toast('Modèle enregistré.','ok');render();}catch(e){toast(e.message,'err');busy(btn,false);}},

};
window.A = A;

/* ---------- Rendu ---------- */
async function render() {
  // Un rendu complet remplace la vue : seules les modifications encore présentes à l’écran sont protégées ensuite.
  adminResetDirty();
  if (!TOKEN) { renderLogin(); return; }
  try {
    if (!ME) ME = await api('/me');
    STATS = await api('/admin/stats');
    const f = parseInt(STATS.admin_font_size || 16, 10); // taille du tableau de bord définie par le PDG
    document.body.style.zoom = f === 16 ? '' : String(f / 16);
  } catch (e) { return; }
  const fn = views[VIEW] || views.dashboard;
  try { await fn(); if(['settings','commerce','estimates','catalog','questions','rules','maintenance','prooptions','staff','ads'].includes(VIEW)) adminArmDraft(document.getElementById('root'),true); }
  catch (e) { shell(`<h1>Erreur</h1><div class="panel">${esc(e.message)}<br><button class="btn" style="margin-top:10px" onclick="render()">Réessayer</button></div>`); }
}
window.render = render;
// Balayage arrière tactile du tableau de bord : bord gauche uniquement, sans interférer avec les champs/tableaux.
let adminTouchX=null, adminTouchY=null, adminTouchBlocked=false, adminTouchAt=0;
const adminIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
function adminGestureBlocked(target){return !!(target&&target.closest&&target.closest('input,textarea,select,button,a,table,.tabs,[data-horizontal-scroll]'));}
document.addEventListener('touchstart',e=>{if(e.touches.length!==1)return;const t=e.touches[0];adminTouchX=t.clientX;adminTouchY=t.clientY;adminTouchAt=Date.now();adminTouchBlocked=adminGestureBlocked(e.target);},{passive:true});
document.addEventListener('touchcancel',()=>{adminTouchX=null;adminTouchBlocked=false;},{passive:true});
document.addEventListener('touchend',e=>{if(adminTouchX===null)return;const t=e.changedTouches[0],dx=t.clientX-adminTouchX,dy=t.clientY-adminTouchY,x=adminTouchX,elapsed=Date.now()-adminTouchAt;adminTouchX=null;if(adminIOS||adminTouchBlocked||x>44||elapsed>900||dx<78||Math.abs(dy)>Math.min(56,dx*.45))return;adminBack();},{passive:true});
window.addEventListener('hashchange', () => {
  const view=location.hash.replace('#','')||'dashboard';
  if(ADMIN_RESTORING && view===ADMIN_CURRENT){ADMIN_RESTORING=false;const p=ADMIN_CONFIRM_MOVE;ADMIN_CONFIRM_MOVE=null;if(p)adminLeaveConfirm(()=>{ADMIN_ALLOW_ONCE=true;ADMIN_PENDING_MOVE=p;history.go(p);});return;}
  if(view===ADMIN_CURRENT)return;
  if(!ADMIN_ALLOW_ONCE&&ADMIN_DIRTY.enabled&&ADMIN_DIRTY.dirty&&!ADMIN_WRITES){const delta=ADMIN_STACK[ADMIN_CURSOR-1]===view?-1:(ADMIN_STACK[ADMIN_CURSOR+1]===view?1:0);if(delta){ADMIN_CONFIRM_MOVE=delta;ADMIN_RESTORING=true;history.go(-delta);return;}const target=view;ADMIN_ALLOW_ONCE=true;location.hash=ADMIN_CURRENT;adminLeaveConfirm(()=>go(target));return;}
  ADMIN_ALLOW_ONCE=false;adminCommit(view);
});
render();
