/* ============================================================
   KLEAN-SERVICES CI — Application (SPA)
   ============================================================ */
'use strict';
const $app = document.getElementById('app');
let TOKEN = localStorage.getItem('ks_token') || null;
let USER = null;
let BADGES = { notifications: 0, messages: 0 };
let SERVICES = null;        // cache catalogue
let POPULAIRES = [];        // services populaires (accueil)
let CATALOGUE = null;       // catalogue complet métiers → sous-catégories → services → tâches
let GAMES = { quiz: false, flipfizz: false, kdo: false };
let MAINT = { active: false }; // état de maintenance de la plateforme
let ADS = [];
let navStack = [];
let suppressPush = false;
let sse = null;
let currentChat = null;     // mission id du chat ouvert

/* ---------- Utilitaires ---------- */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtDate(s) { if (!s) return ''; const d = new Date(s.replace(' ', 'T') + (s.includes('Z') || s.includes('+') ? '' : 'Z')); return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function fmtFCFA(n) { return (n ?? 0).toLocaleString('fr-FR') + ' FCFA'; }
function initials(name) { return (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase(); }
function avatar(u, cls) { return `<div class="avatar ${cls || ''}">${u && u.photo ? `<img src="${esc(u.photo)}" alt="">` : esc(initials(u && u.name))}</div>`; }

function toast(msg, cls, title) {
  const z = document.getElementById('toast-zone');
  const t = document.createElement('div');
  t.className = 'toast ' + (cls || '');
  t.innerHTML = (title ? `<div class="t-title">${esc(title)}</div>` : '') + esc(msg);
  t.onclick = () => t.remove();
  z.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData) && opts.body) headers['Content-Type'] = 'application/json';
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  let res;
  try {
    res = await fetch('/api' + path, { ...opts, headers, body: opts.body instanceof FormData ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined) });
  } catch {
    throw new Error('Connexion impossible. Vérifiez votre connexion internet puis réessayez.');
  }
  let data = {};
  try { data = await res.json(); } catch { }
  if (!res.ok) {
    if (res.status === 401 && TOKEN) { logout(false); }
    throw new Error(data.error || 'Une erreur est survenue. Veuillez réessayer.');
  }
  return data;
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.l = btn.textContent; btn.disabled = true; btn.textContent = label || 'Veuillez patienter…'; }
  else { btn.disabled = false; btn.textContent = btn.dataset.l || btn.textContent; }
}

/* ---------- Son + vibration de notification ---------- */
function notifFeedback() {
  if (localStorage.getItem('ks_sound') !== '0') {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; g.gain.setValueAtTime(.12, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .4);
      o.start(); o.stop(ctx.currentTime + .4);
      setTimeout(() => ctx.close(), 600);
    } catch { }
  }
  if (navigator.vibrate) try { navigator.vibrate([120, 60, 120]); } catch { }
}

/* ---------- SSE temps réel ---------- */
function connectSSE() {
  if (sse) { sse.close(); sse = null; }
  if (!TOKEN) return;
  sse = new EventSource('/api/stream?token=' + encodeURIComponent(TOKEN));
  sse.addEventListener('notification', e => {
    const n = JSON.parse(e.data);
    BADGES.notifications = n.unread;
    updateBadges();
    notifFeedback();
    if (n.category !== 'message' || currentChat === null) {
      const t = document.createElement('div');
      t.className = 'toast notif';
      t.innerHTML = `<div class="t-title">${esc(n.title)}</div>${esc(n.body || '')}`;
      t.onclick = () => { t.remove(); if (n.link && n.link.startsWith('#/')) nav(n.link); };
      document.getElementById('toast-zone').appendChild(t);
      setTimeout(() => t.remove(), 6500);
    }
    refreshBadges();
  });
  sse.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (currentChat === m.mission_id) { appendChatMsg(m); api('/missions/' + m.mission_id + '/messages').catch(() => { }); }
    refreshBadges();
  });
  sse.addEventListener('mission', e => {
    const d = JSON.parse(e.data);
    const h = location.hash;
    if (h === '#/mission/' + d.id || h === '#/missions' || h === '#/pro' || h === '#/home') render();
  });
  sse.addEventListener('account', async () => { try { USER = await api('/me'); } catch { } render(); });
}

async function refreshBadges() {
  try { BADGES = await api('/badges'); updateBadges(); } catch { }
}
function updateBadges() {
  document.querySelectorAll('.js-bell-badge').forEach(el => {
    el.innerHTML = BADGES.notifications > 0 ? `<span class="badge">${BADGES.notifications > 99 ? '99+' : BADGES.notifications}</span>` : '';
  });
  document.querySelectorAll('.js-msg-badge').forEach(el => {
    el.innerHTML = BADGES.messages > 0 ? `<span class="badge nbadge">${BADGES.messages}</span>` : '';
  });
}

/* ---------- Navigation ---------- */
function nav(hash) { location.hash = hash; }
function back() {
  if (navStack.length > 1) { navStack.pop(); suppressPush = true; location.hash = navStack[navStack.length - 1]; }
  else nav('#/home');
}
window.addEventListener('hashchange', () => {
  if (!suppressPush) {
    const h = location.hash || '#/home';
    if (navStack[navStack.length - 1] !== h) navStack.push(h);
    if (navStack.length > 30) navStack.shift();
  }
  suppressPush = false;
  render();
});
/* Navigation gestuelle (balayage) */
let touchX = null, touchY = null;
document.addEventListener('touchstart', e => { if (e.touches.length === 1) { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; } }, { passive: true });
document.addEventListener('touchend', e => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
  touchX = null;
  if (Math.abs(dx) > 70 && Math.abs(dy) < 50 && !['#/home', '#/login', '#/register', ''].includes(location.hash)) {
    if (dx > 0) back();
  }
}, { passive: true });

function logout(manual = true) {
  TOKEN = null; USER = null; localStorage.removeItem('ks_token');
  if (sse) { sse.close(); sse = null; }
  if (manual) toast('Vous êtes déconnecté.', 'ok');
  nav('#/login'); render();
}

/* ---------- Gabarits ---------- */
function header(title, opts = {}) {
  return `<div class="hdr">
    ${opts.back !== false ? `<button class="back-btn" onclick="back()">←<span>Retour</span></button>` : ''}
    ${opts.brand ? `<div class="brand">Klean-Services CI</div>` : `<div class="title">${esc(title)}</div>`}
    ${opts.bell !== false ? `<button class="bell" onclick="nav('#/notifications')">🔔<span class="js-bell-badge"></span></button>` : ''}
  </div>`;
}
function bottomNav(active) {
  const items = [
    ['home', '🏠', 'Accueil'], ['search', '🔍', 'Rechercher'], ['missions', '📋', 'Demandes'],
    ['messages', '💬', 'Messages'], ['account', '👤', 'Compte']
  ];
  return `<div class="bottomnav">` + items.map(([id, ic, lb]) =>
    `<button class="${active === id ? 'on' : ''}" onclick="nav('#/${id}')"><span class="ni">${ic}</span>${lb}${id === 'messages' ? '<span class="js-msg-badge"></span>' : ''}</button>`
  ).join('') + `</div>`;
}
function emptyState(ic, msg) { return `<div class="empty"><div class="e-ic">${ic}</div>${esc(msg)}</div>`; }
function statusPill(s) {
  const L = { recherche: '🔎 Recherche en cours', sans_pro: 'Sans professionnel', acceptee: 'Acceptée', confirmee: 'Programmée', en_cours: 'En cours', terminee: 'Terminée', payee: 'Payée', annulee: 'Annulée', litige: 'Litige' };
  return `<span class="pill ${s}">${L[s] || s}</span>`;
}

function openModal(html) {
  closeModal();
  const bg = document.createElement('div');
  bg.className = 'modal-bg'; bg.id = 'modal';
  bg.innerHTML = `<div class="modal">${html}</div>`;
  bg.onclick = e => { if (e.target === bg) closeModal(); };
  document.body.appendChild(bg);
}
function closeModal() { const m = document.getElementById('modal'); if (m) m.remove(); }

/* ============================================================
   ÉCRANS
   ============================================================ */
const routes = {};

/* ---------- Connexion / Inscription ---------- */
routes.login = () => {
  $app.innerHTML = `
  <div class="content no-nav" style="padding-top:52px">
    <div class="center mb"><div class="splash-logo" style="margin:0 auto;background:var(--p);color:#fff">K</div>
      <h2 style="margin:14px 0 2px">Klean-Services CI</h2>
      <div class="muted">Tous vos services à portée de main</div></div>
    <div class="card">
      <div class="field"><label>Numéro de téléphone</label><input type="tel" id="f-phone" placeholder="Ex : 07 00 00 00 00" autocomplete="tel"></div>
      ${pwField('f-pass', 'Mot de passe', 'Votre mot de passe')}
      <button class="btn" id="b-login">Se connecter</button>
      <button class="btn ghost" onclick="A.forgot(document.getElementById('f-phone').value)">Mot de passe oublié ?</button>
      <button class="btn ghost mt" onclick="nav('#/register')">Pas encore de compte ? <b>Créer un compte</b></button>
    </div>
  </div>`;
  document.getElementById('b-login').onclick = async e => {
    busy(e.target, true);
    try {
      const r = await api('/auth/login', { method: 'POST', body: { phone: document.getElementById('f-phone').value, password: document.getElementById('f-pass').value } });
      TOKEN = r.token; USER = r.user; localStorage.setItem('ks_token', TOKEN);
      if (USER.font_size) applyFont(USER.font_size);
      connectSSE(); refreshBadges();
      nav(['pdg', 'admin', 'gestionnaire', 'agent'].includes(USER.role) ? '#/account' : '#/home');
    } catch (err) { toast(err.message, 'err'); busy(e.target, false); }
  };
  document.getElementById('f-pass').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('b-login').click(); });
};

routes.register = async () => {
  let rules = { client: '' };
  try { rules = await api('/rules'); } catch { }
  let villes = [];
  try { villes = await api('/villes'); } catch { }
  $app.innerHTML = `
  ${header('Créer un compte', { bell: false })}
  <div class="content no-nav">
    <div class="card">
      <div class="field"><label>Nom complet <span class="req">*</span></label><input type="text" id="f-name" placeholder="Ex : John Sery Michael"></div>
      <div class="field"><label>Numéro de téléphone <span class="req">*</span></label><input type="tel" id="f-phone" placeholder="Ex : 07 00 00 00 00"></div>
      ${pwField('f-pass', 'Mot de passe <span class="req">*</span> <span class="muted small">(6 caractères min.)</span>')}
      <div class="field"><label>Ville <span class="req">*</span></label>
        <input type="text" id="f-ville" list="villes-ci" placeholder="Tapez pour chercher votre ville…" autocomplete="off">
        <datalist id="villes-ci">${villes.map(v => `<option value="${esc(v)}">`).join('')}</datalist>
      </div>
      <div class="field"><label>Quartier</label><input type="text" id="f-quartier" placeholder="Ex : Air France, Cocody Angré…"></div>
      <div class="sec-title">Règles d'utilisation</div>
      <div class="rules-box">${esc(rules.client || '')}</div>
      <label class="check-line"><input type="checkbox" id="f-accept"> J'ai lu et j'accepte les règles d'utilisation de Klean-Services CI.</label>
      <button class="btn" id="b-reg">Créer mon compte</button>
      <div class="muted small center mt">Un seul compte par numéro de téléphone. Vous pourrez l'utiliser comme client et, si vous le souhaitez, devenir aussi professionnel.</div>
    </div>
  </div>`;
  document.getElementById('b-reg').onclick = async e => {
    const ville = document.getElementById('f-ville').value.trim();
    if (ville && villes.length && !villes.some(v => v.toLowerCase() === ville.toLowerCase())) {
      toast('Choisissez votre ville dans la liste (tapez les premières lettres).', 'err'); return;
    }
    busy(e.target, true);
    try {
      const r = await api('/auth/register', {
        method: 'POST', body: {
          name: document.getElementById('f-name').value, phone: document.getElementById('f-phone').value,
          password: document.getElementById('f-pass').value,
          ville, quartier: document.getElementById('f-quartier').value,
          accept_rules: document.getElementById('f-accept').checked
        }
      });
      TOKEN = r.token; USER = r.user; localStorage.setItem('ks_token', TOKEN);
      connectSSE(); refreshBadges();
      toast('Bienvenue sur Klean-Services CI !', 'ok');
      nav('#/home');
    } catch (err) {
      busy(e.target, false);
      if (err.message === 'Ce numéro est déjà associé à un compte.') {
        const ph = document.getElementById('f-phone').value;
        openModal(`<h3>📱 Numéro déjà utilisé</h3>
          <p>Ce numéro est déjà associé à un compte.</p>
          <button class="btn" onclick="closeModal();nav('#/login')">Se connecter</button>
          <button class="btn sec mt" onclick="closeModal();A.forgot('${esc(ph)}')">Réinitialiser mon accès</button>
          <button class="btn ghost" onclick="closeModal()">Annuler</button>`);
      } else toast(err.message, 'err');
    }
  };
};

/* ---------- Accueil ---------- */
routes.home = async () => {
  if (!SERVICES) try { SERVICES = await api('/services'); } catch (e) { $app.innerHTML = header('Accueil', { brand: true }) + `<div class="content">${emptyState('📶', e.message)}<button class="btn" onclick="render()">Réessayer</button></div>` + bottomNav('home'); return; }
  if (!POPULAIRES.length) try { POPULAIRES = await api('/services/populaires'); } catch { }
  try { GAMES = await api('/games/config'); } catch { }
  try { ADS = await api('/ads'); } catch { }
  const homeAds = ADS.filter(a => a.placement === 'accueil');
  const cats = SERVICES;
  $app.innerHTML = `
  ${header('', { brand: true, back: false })}
  <div class="content">
    ${MAINT.active && MAINT.scope !== 'F' ? `<div class="card" style="border-left:4px solid #e67e22;background:#fff8f0">
      <div class="bold">🛠️ Maintenance partielle en cours</div>
      <div class="small muted">${esc(MAINT.message || 'Certaines fonctions sont temporairement suspendues. Merci de votre patience.')}</div>
    </div>` : ''}
    <div class="searchbar">
      <input type="text" id="home-q" placeholder="🔎 Que recherchez-vous ?" enterkeyhint="search">
      <button onclick="A.goSearch()" aria-label="Rechercher">🔍</button>
    </div>
    <div class="hint">Ex : « Je cherche un plombier », « Nettoyer mon fauteuil », « Cours d'anglais à domicile »…</div>
    ${homeAds.map(a => `<div class="ad-card"><div class="ad-tag">INFORMATION</div><div class="bold">${esc(a.title || '')}</div><div class="small">${esc(a.content || '')}</div>
      ${a.file && a.type === 'image' ? `<img src="${esc(a.file)}" alt="">` : ''}${a.file && a.type === 'video' ? `<video src="${esc(a.file)}" controls muted></video>` : ''}</div>`).join('')}
    ${POPULAIRES.length ? `<div class="sec-title">Services populaires</div>
    <div class="svc-grid">
      ${POPULAIRES.map(s => `<div class="svc-card" onclick="nav('#/request/${s.id}')"><span class="ic">${esc(s.icon || '🔹')}</span><span class="nm">${esc(s.name)}</span></div>`).join('')}
    </div>` : ''}
    <div class="sec-title">Métiers</div>
    <div class="svc-grid">
      ${cats.slice(0, 7).map(c => `<div class="svc-card" onclick="A.openCat(${c.id})"><span class="ic">${esc(c.icon || '🔹')}</span><span class="nm">${esc(c.name)}</span></div>`).join('')}
      <div class="svc-card" onclick="nav('#/services')"><span class="ic">➕</span><span class="nm">Tous les métiers</span></div>
    </div>
    <button class="btn sec mt" onclick="nav('#/services')">Voir tous les services</button>
    ${(GAMES.quiz || GAMES.flipfizz || GAMES.kdo) ? `
      <div class="sec-title">Divertissement</div>
      <div class="svc-grid">
        ${GAMES.quiz ? `<div class="svc-card" onclick="nav('#/quiz')"><span class="ic">🧠</span><span class="nm">Quiz</span></div>` : ''}
        ${GAMES.flipfizz ? `<div class="svc-card" onclick="nav('#/flip')"><span class="ic">🎲</span><span class="nm">Flip Fizz</span></div>` : ''}
        ${GAMES.kdo ? `<div class="svc-card" onclick="nav('#/kdo')"><span class="ic">🎁</span><span class="nm">Kdo</span></div>` : ''}
      </div>` : ''}
  </div>${bottomNav('home')}`;
  updateBadges();
  const q = document.getElementById('home-q');
  q.addEventListener('keydown', e => { if (e.key === 'Enter') A.goSearch(); });
};

/* ---------- Recherche ---------- */
routes.search = async (params) => {
  const q = decodeURIComponent(params || '');
  $app.innerHTML = `
  ${header('Rechercher')}
  <div class="content">
    <div class="searchbar">
      <input type="text" id="s-q" placeholder="🔎 Que recherchez-vous ?" value="${esc(q)}" enterkeyhint="search">
      <button onclick="A.doSearch()">🔍</button>
    </div>
    <div id="s-results"><div class="hint">Décrivez simplement votre besoin : « réparer ma télévision », « un électricien », « je cherche un employé »…</div></div>
  </div>${bottomNav('search')}`;
  const inp = document.getElementById('s-q');
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') A.doSearch(); });
  if (q) A.doSearch(); else inp.focus();
  updateBadges();
};

/* ---------- Tous les services (catalogue complet par métier) ---------- */
routes.services = async (params) => {
  try { if (!CATALOGUE) CATALOGUE = await api('/catalogue'); }
  catch (e) { $app.innerHTML = header('Tous les services') + `<div class="content">${emptyState('📶', e.message)}<button class="btn" onclick="render()">Réessayer</button></div>` + bottomNav('search'); return; }
  const openId = parseInt(params || sessionStorage.getItem('ks_cat_open') || 0, 10);
  const q = (sessionStorage.getItem('ks_cat_q') || '').toLowerCase().trim();
  const hit = x => (x || '').toLowerCase().includes(q);

  let listHtml;
  if (q) {
    // Recherche : liste à plat des services correspondants (nom, sous-catégorie, tâches, métier)
    const out = [];
    CATALOGUE.forEach(c => c.sous_categories.forEach(sc => sc.services.forEach(s => {
      if (hit(s.name) || hit(sc.name) || hit(c.name) || s.taches.some(t => hit(t.name)))
        out.push({ ...s, icon: c.icon, path: `${c.name} › ${sc.name}` });
    })));
    listHtml = out.length
      ? out.map(s => `<div class="menu-item" onclick="nav('#/request/${s.id}')"><span class="mi-ic">${esc(s.icon || '🔹')}</span><div><div>${esc(s.name)}</div><div class="muted small">${esc(s.path)}</div></div><span class="mi-arr">›</span></div>`).join('')
      : emptyState('🔍', 'Aucun service trouvé pour « ' + esc(q) + ' ».');
  } else {
    // Accordéon par métier
    listHtml = CATALOGUE.map(c => `
      <div class="menu-item" onclick="A.catOpen(${c.id})" style="font-weight:700">
        <span class="mi-ic">${esc(c.icon || '🔹')}</span>${esc(c.name)}
        <span class="mi-arr">${openId === c.id ? '▾' : '›'}</span></div>
      ${openId === c.id ? c.sous_categories.map(sc => `
        <div class="sec-title" style="margin-left:10px">${esc(sc.name)}</div>
        ${sc.services.map(s => `<div class="menu-item" style="margin-left:10px" onclick="nav('#/request/${s.id}')">
          <span class="mi-ic">${esc(c.icon || '🔹')}</span><div><div>${esc(s.name)}</div>
          ${s.taches.length ? `<div class="muted small">${s.taches.slice(0, 3).map(t => esc(t.name)).join(' · ')}${s.taches.length > 3 ? '…' : ''}</div>` : ''}</div>
          <span class="mi-arr">›</span></div>`).join('')}`).join('') : ''}`).join('');
  }

  $app.innerHTML = `
  ${header('Tous les services')}
  <div class="content">
    <div class="searchbar">
      <input type="text" id="cat-q" placeholder="🔎 Filtrer : plomberie, coiffure, réparer…" value="${esc(sessionStorage.getItem('ks_cat_q') || '')}" enterkeyhint="search">
      <button onclick="A.catFilter()" aria-label="Filtrer">🔍</button>
    </div>
    ${listHtml}
  </div>${bottomNav('search')}`;
  updateBadges();
  const inp = document.getElementById('cat-q');
  inp.addEventListener('input', () => { sessionStorage.setItem('ks_cat_q', inp.value); });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') A.catFilter(); });
  if (q) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
};

/* ---------- Demande de service (formulaire adaptatif) ---------- */
let REQ = { photos: [], audio: null, lat: null, lng: null };
routes.request = async (serviceId) => {
  if (!USER) { nav('#/login'); return; }
  let data;
  try { data = await api('/services/' + serviceId + '/questions'); }
  catch (e) { toast(e.message, 'err'); back(); return; }
  REQ = { photos: [], audio: null, lat: USER.lat, lng: USER.lng, service_id: data.service.id };
  const taches = data.taches || [];
  const sug = sessionStorage.getItem('ks_sug_tache') || '';
  sessionStorage.removeItem('ks_sug_tache');
  $app.innerHTML = `
  ${header(data.service.name)}
  <div class="content">
    <div class="card">
      <div class="muted small mb">Répondez à ces quelques questions pour que le professionnel comprenne bien votre besoin.</div>
      ${taches.length ? `<div class="field"><label>Que faut-il faire ?</label>
        <div class="choices" id="r-tache">${taches.map(t => `<button type="button" class="chip ${sug && t.name === sug ? 'on' : ''}" onclick="A.pickChip(this,'${esc(t.name).replace(/'/g, "\\'")}')">${esc(t.name)}</button>`).join('')}
        <button type="button" class="chip" onclick="A.pickChip(this,'Autre')">Autre / je ne sais pas</button></div></div>` : ''}
      ${data.questions.map(qst => renderQuestion(qst)).join('')}
      <div class="field"><label>Message (facultatif)</label><textarea id="r-desc" placeholder="Autre précision utile…"></textarea></div>
      <div class="field"><label>Photos (facultatif)</label>
        <div class="photo-strip" id="r-photos"><button class="ph-add" onclick="A.pickPhotos('r-photos')">＋</button></div>
        <input type="file" id="file-input" accept="image/*" multiple style="display:none">
      </div>
      <div class="field"><label>Message vocal (facultatif)</label>
        <div id="r-audio-zone"><button class="btn sec sm" id="r-rec" onclick="A.toggleRec('r-audio-zone')">🎤 Enregistrer un message vocal</button></div>
      </div>
      <div class="sec-title">Localisation</div>
      <div class="gps-row mb">
        <button class="btn outline sm" onclick="A.useGPS()" id="b-gps">📍 Utiliser ma position</button>
      </div>
      <div class="field"><label>Adresse / Quartier <span class="req">*</span></label><input type="text" id="r-addr" placeholder="Ex : Bouaké, quartier Air France, près de…" value="${esc(USER.address || '')}"></div>
      <div class="field"><label>Date souhaitée</label><input type="datetime-local" id="r-date"></div>
      <label class="check-line"><input type="checkbox" id="r-urgent"> 🔥 C'est urgent</label>
      <button class="btn" id="b-send">Envoyer ma demande</button>
    </div>
  </div>${bottomNav('search')}`;
  updateBadges();
  if (sug && taches.some(t => t.name === sug)) { const tz = document.getElementById('r-tache'); if (tz) tz.dataset.val = sug; }
  document.getElementById('b-send').onclick = async e => {
    const answers = {};
    let missing = null;
    document.querySelectorAll('[data-q]').forEach(el => {
      const id = el.dataset.q;
      let v = '';
      if (el.dataset.type === 'bool') v = el.dataset.val || '';
      else if (el.dataset.type === 'select') v = el.dataset.val || '';
      else v = el.value;
      if (el.dataset.req === '1' && !String(v).trim() && !missing) missing = el.dataset.label;
      if (String(v).trim()) answers[id] = el.dataset.type === 'bool' ? (v === '1') : v;
    });
    if (missing) { toast('Veuillez répondre à : « ' + missing + ' »', 'err'); return; }
    const addr = document.getElementById('r-addr').value;
    if (!addr.trim()) { toast('Indiquez votre localisation (bouton GPS ou saisie manuelle).', 'err'); return; }
    busy(e.target, true, 'Envoi en cours…');
    try {
      const tz = document.getElementById('r-tache');
      const r = await api('/missions', {
        method: 'POST', body: {
          service_id: REQ.service_id, answers,
          tache: tz && tz.dataset.val && tz.dataset.val !== 'Autre' ? tz.dataset.val : null,
          description: document.getElementById('r-desc').value,
          address: addr, lat: REQ.lat, lng: REQ.lng,
          urgence: document.getElementById('r-urgent').checked,
          date_souhaitee: document.getElementById('r-date').value || null,
          photos: REQ.photos, audio: REQ.audio
        }
      });
      toast('Demande envoyée ! Recherche de professionnels en cours…', 'ok');
      navStack = ['#/home', '#/missions'];
      nav('#/mission/' + r.id);
    } catch (err) {
      toast(err.message, 'err'); busy(e.target, false);
    }
  };
};
function renderQuestion(q) {
  const req = q.required ? '<span class="req">*</span>' : '';
  const attrs = `data-q="${q.id}" data-req="${q.required}" data-label="${esc(q.label)}" data-type="${q.type}"`;
  if (q.type === 'select') return `<div class="field"><label>${esc(q.label)} ${req}</label>
    <div class="choices" ${attrs}>${q.options.map(o => `<button type="button" class="chip" onclick="A.pickChip(this,'${esc(o).replace(/'/g, "\\'")}')">${esc(o)}</button>`).join('')}</div></div>`;
  if (q.type === 'bool') return `<div class="field"><label>${esc(q.label)} ${req}</label>
    <div class="choices" ${attrs}><button type="button" class="chip" onclick="A.pickChip(this,'1')">Oui</button><button type="button" class="chip" onclick="A.pickChip(this,'0')">Non</button></div></div>`;
  if (q.type === 'number') return `<div class="field"><label>${esc(q.label)} ${req}</label><input type="number" min="0" ${attrs}></div>`;
  if (q.type === 'date') return `<div class="field"><label>${esc(q.label)} ${req}</label><input type="date" ${attrs}></div>`;
  return `<div class="field"><label>${esc(q.label)} ${req}</label><input type="text" ${attrs}></div>`;
}

/* ---------- Mes demandes / missions ---------- */
routes.missions = async () => {
  if (!USER) { nav('#/login'); return; }
  let d;
  try { d = await api('/missions'); } catch (e) { toast(e.message, 'err'); return; }
  const isPro = USER.pro_status === 'approved';
  const tab = sessionStorage.getItem('ks_mtab') || 'client';
  const missionCard = m => `
    <div class="card tap" onclick="nav('#/mission/${m.id}')">
      <div class="row"><span class="mi-ic" style="font-size:24px">${esc(m.icon || '📋')}</span>
        <div class="grow"><div class="bold">${esc(m.service)}</div>
        ${m.tache ? `<div class="small">🛠️ ${esc(m.tache)}</div>` : ''}
        <div class="muted small">${esc(m.address || '')} • ${fmtDate(m.created_at)}</div></div>
        ${statusPill(m.status)}</div>
      ${m.urgence ? '<div class="small" style="color:var(--danger);font-weight:700;margin-top:6px">🔥 Urgent</div>' : ''}
    </div>`;
  $app.innerHTML = `
  ${header(isPro ? 'Demandes & Missions' : 'Mes demandes', { back: false })}
  <div class="content">
    ${isPro ? `<div class="tabs">
      <button class="tab ${tab === 'client' ? 'on' : ''}" onclick="A.mTab('client')">Mes demandes (client)</button>
      <button class="tab ${tab === 'pro' ? 'on' : ''}" onclick="A.mTab('pro')">Mes missions (pro) ${d.offers.length ? `<span class="badge">${d.offers.length}</span>` : ''}</button>
    </div>` : ''}
    <div id="m-list">
    ${tab === 'pro' && isPro ? `
      ${d.offers.length ? `<div class="sec-title">🔔 Nouvelles missions à traiter</div>` + d.offers.map(missionCard).join('') : ''}
      ${d.pro.length ? `<div class="sec-title">Mes missions</div>` + d.pro.map(missionCard).join('') : (!d.offers.length ? emptyState('🧰', 'Aucune mission pour le moment. Restez disponible pour en recevoir !') : '')}
    ` : `
      ${d.client.length ? d.client.map(missionCard).join('') : emptyState('📋', 'Aucune demande pour le moment.') + `<button class="btn" onclick="nav('#/home')">Faire une demande</button>`}
    `}
    </div>
  </div>${bottomNav('missions')}`;
  updateBadges();
};

/* ---------- Détail mission ---------- */
routes.mission = async (id) => {
  if (!USER) { nav('#/login'); return; }
  let m;
  try { m = await api('/missions/' + id); } catch (e) { toast(e.message, 'err'); nav('#/missions'); return; }
  const isClient = m.role === 'client', isPro = m.role === 'pro', isCand = m.role === 'candidat';
  const STEPS = [['recherche', 'Demande créée'], ['acceptee', 'Professionnel trouvé'], ['confirmee', 'Mission programmée'], ['en_cours', 'Mission en cours'], ['terminee', 'Mission terminée'], ['payee', 'Paiement validé']];
  const orderIdx = { recherche: 0, sans_pro: 0, acceptee: 1, confirmee: 2, en_cours: 3, terminee: 4, payee: 5 };
  const curIdx = orderIdx[m.status] ?? -1;

  let banner = '';
  if (m.status === 'recherche') banner = isClient
    ? `<div class="status-banner search"><div class="spinner"></div>Recherche de professionnels disponibles… Vous serez notifié dès qu'un professionnel accepte.</div>`
    : (isCand && m.offer_pending ? `<div class="status-banner info">🔔 Cette mission vous est proposée. Répondez rapidement !</div>` : `<div class="status-banner search"><div class="spinner"></div>En attente de réponse…</div>`);
  if (m.status === 'sans_pro') banner = `<div class="status-banner bad">😕 Aucun professionnel n'a répondu pour le moment.</div>`;
  if (m.status === 'acceptee') banner = isClient
    ? `<div class="status-banner ok">✅ ${esc(m.pro ? m.pro.name : 'Un professionnel')} a accepté ! Consultez son profil puis confirmez.</div>`
    : `<div class="status-banner info">En attente de la confirmation du client.</div>`;
  if (m.status === 'confirmee') banner = `<div class="status-banner ok">📅 Mission programmée.${isPro ? ' Vous pouvez la démarrer le moment venu.' : ''}</div>`;
  if (m.status === 'en_cours') banner = `<div class="status-banner info">🛠️ Mission en cours de réalisation.</div>`;
  if (m.status === 'terminee') banner = `<div class="status-banner search">💵 Mission terminée — paiement en attente de confirmation.</div>`;
  if (m.status === 'payee') banner = `<div class="status-banner ok">🎉 Mission terminée et payée. Merci !</div>`;
  if (m.status === 'annulee') banner = `<div class="status-banner bad">Cette mission a été annulée.</div>`;
  if (m.status === 'litige') banner = `<div class="status-banner bad">⚠️ Un litige est ouvert sur cette mission. L'administration vous contactera.</div>`;

  /* Fiche contact de l'autre partie */
  const other = isClient ? m.pro : m.client;
  const contactCard = other ? `
    <div class="card"><div class="row" ${isClient && m.pro ? `onclick="nav('#/pros/${m.pro.id}')" style="cursor:pointer"` : ''}>
      ${avatar(other)}
      <div class="grow"><div class="bold">${esc(other.name)} ${other.verified ? '✅' : ''}</div>
        <div class="muted small">${other.rating ? `<span class="star-inline">★ ${other.rating}</span> (${other.reviews_count} avis)` : 'Nouveau'}
        ${other.phone ? ` • 📞 <a href="tel:${esc(other.phone)}">${esc(other.phone)}</a>` : ''}</div></div>
      ${isClient && m.pro ? '<span class="mi-arr">›</span>' : ''}</div>
      ${(m.pro || isPro) && !['annulee'].includes(m.status) ? `<button class="btn sec sm mt" onclick="nav('#/chat/${m.id}')">💬 Ouvrir la discussion ${m.unread_messages ? `<span class="badge">${m.unread_messages}</span>` : ''}</button>` : ''}
    </div>` : '';

  /* Candidats (client, pendant la recherche) */
  let candBlock = '';
  if (isClient && m.candidates && m.candidates.length && ['recherche', 'sans_pro'].includes(m.status)) {
    candBlock = `<div class="sec-title">Professionnels correspondants</div>` + m.candidates.map(c => `
      <div class="card"><div class="row">
        ${avatar(c)}
        <div class="grow"><div class="bold">${esc(c.name)} ${c.verified ? '✅' : ''}</div>
          <div class="muted small">${esc(c.profession || '')} • ${esc(c.zone || '')}</div>
          <div class="small">${c.available ? '🟢 Disponible' : '⚪ Indisponible'} ${c.rating ? ` • <span class="star-inline">★ ${c.rating}</span>` : ''}</div></div>
      </div>
      <div class="btn-row mt">
        <button class="btn outline sm" onclick="nav('#/pros/${c.id}')">Voir le profil</button>
        <button class="btn sm" onclick="A.choosePro(${m.id},${c.id},this)">${c.cstatus === 'offered' ? 'Sollicité ✓' : 'Contacter'}</button>
      </div></div>`).join('');
  }

  /* Paiement */
  let payBlock = '';
  if (m.payment) {
    const p = m.payment;
    const meConfirmed = isClient ? p.client_confirmed_at : p.pro_confirmed_at;
    payBlock = `<div class="sec-title">Paiement</div><div class="card">
      <div class="row"><div class="grow">
        <div class="bold">${fmtFCFA(p.amount)} <span class="muted small">• Espèces</span></div>
        ${!isClient ? `<div class="muted small">Commission Klean-Services (${p.commission_rate}%) : ${fmtFCFA(p.commission_amount)}<br><b>Votre part : ${fmtFCFA(p.pro_amount)}</b></div>` : ''}
      </div>
      <span class="pill ${p.status === 'valide' ? 'ok' : 'warn'}">${p.status === 'valide' ? 'Payé ✓' : p.status === 'en_attente' ? 'En attente' : 'Confirmation partielle'}</span></div>
      ${p.status !== 'valide' ? (meConfirmed
        ? `<div class="muted small mt">✓ Vous avez confirmé. En attente de la confirmation de l'autre partie.</div>`
        : `<button class="btn mt" onclick="A.confirmPay(${m.id},this)">${isClient ? '💵 J\u2019ai remis le paiement en espèces' : '💵 J\u2019ai bien reçu le paiement en espèces'}</button>`) : ''}
    </div>`;
  } else if (isPro && ['acceptee', 'confirmee', 'en_cours'].includes(m.status)) {
    payBlock = `<div class="sec-title">Montant de la mission</div><div class="card">
      <div class="field"><label>Montant (FCFA) ${m.amount ? `<span class="muted small">— actuel : ${fmtFCFA(m.amount)}</span>` : '<span class="req">*</span>'}</label>
      <input type="number" id="m-amount" min="100" step="100" value="${m.amount || ''}" placeholder="Ex : 10000"></div>
      <div class="muted small mb">Commission Klean-Services CI : ${m.commission_rate}% — elle sera déduite de ce montant.</div>
      <button class="btn sec sm" onclick="A.setAmount(${m.id},this)">Enregistrer le montant</button></div>`;
  } else if (isClient && m.amount) {
    payBlock = `<div class="sec-title">Montant</div><div class="card"><div class="bold">${fmtFCFA(m.amount)} <span class="muted small">• paiement en espèces à la fin de la mission</span></div></div>`;
  }

  /* Avis */
  let reviewBlock = '';
  if (['terminee', 'payee'].includes(m.status) && (isClient || isPro)) {
    reviewBlock = m.my_review
      ? `<div class="sec-title">Votre évaluation</div><div class="card"><div class="star-inline">${'★'.repeat(m.my_review.rating)}${'☆'.repeat(5 - m.my_review.rating)}</div><div class="small mt">${esc(m.my_review.comment || '')}</div></div>`
      : `<div class="sec-title">Évaluer ${isClient ? 'le professionnel' : 'le client'}</div><div class="card">
          <div class="stars" id="rv-stars">${[1, 2, 3, 4, 5].map(i => `<span onclick="A.setStar(${i})">★</span>`).join('')}</div>
          <div class="field"><textarea id="rv-comment" placeholder="Votre commentaire (facultatif)"></textarea></div>
          <button class="btn" onclick="A.sendReview(${m.id},this)">Envoyer mon évaluation</button></div>`;
  }

  /* Actions principales */
  let actions = '';
  if (isCand && m.offer_pending) actions = `<div class="btn-row mt"><button class="btn warn" onclick="A.refuseMission(${m.id},this)">Refuser</button><button class="btn" onclick="A.acceptMission(${m.id},this)">✅ Accepter la mission</button></div>`;
  if (isClient && m.status === 'acceptee') actions = `<button class="btn mt" onclick="A.confirmMission(${m.id},this)">✅ Confirmer ce professionnel</button>`;
  if (isClient && m.status === 'sans_pro') actions = `<button class="btn mt" onclick="A.relancer(${m.id},this)">🔄 Relancer la recherche</button>`;
  if (isPro && m.status === 'confirmee') actions = `<button class="btn mt" onclick="A.startMission(${m.id},this)">🛠️ Démarrer la mission</button>`;
  if (isPro && m.status === 'en_cours') actions = `<button class="btn mt" onclick="A.completeMission(${m.id},this)">✅ Terminer la mission</button>`;
  const cancellable = ['recherche', 'sans_pro', 'acceptee', 'confirmee', 'en_cours'].includes(m.status) && (isClient || isPro);

  $app.innerHTML = `
  ${header(m.service)}
  <div class="content">
    ${banner}
    <div class="card">
      <div class="row"><span style="font-size:26px">${esc(m.icon || '📋')}</span>
        <div class="grow"><div class="bold">${esc(m.service)}</div><div class="muted small">N° ${esc(m.code)} • ${fmtDate(m.created_at)}</div></div>
        ${statusPill(m.status)}</div>
      ${m.tache ? `<div class="small mt"><b>🛠️ Tâche demandée :</b> ${esc(m.tache)}</div>` : ''}
      ${m.urgence ? '<div class="small mt" style="color:var(--danger);font-weight:700">🔥 Demande urgente</div>' : ''}
      ${m.date_souhaitee ? `<div class="small mt">📅 Souhaité : ${fmtDate(m.date_souhaitee)}</div>` : ''}
      <div class="small mt">📍 ${esc(m.address || '')}</div>
      ${m.detail.length ? `<div class="sec-title" style="margin-top:14px">Détails</div>` + m.detail.map(d => `<div class="small"><b>${esc(d.label)} :</b> ${esc(d.value)}</div>`).join('') : ''}
      ${m.description ? `<div class="small mt"><b>Message :</b> ${esc(m.description)}</div>` : ''}
      ${m.photos.length ? `<div class="photo-strip">${m.photos.map(p => `<img src="${esc(p)}" onclick="A.viewPhoto('${esc(p)}')" onerror="this.classList.add('msg-missing')">`).join('')}</div>` : ''}
      ${m.audio ? `<div class="mt"><audio controls src="${esc(m.audio)}"></audio></div>` : ''}
    </div>
    ${actions}
    ${contactCard}
    ${candBlock}
    ${payBlock}
    ${reviewBlock}
    <div class="sec-title">Suivi</div>
    <div class="card"><ul class="timeline">
      ${STEPS.map(([s, lb], i) => {
        const ev = m.events.filter(e => e.status === s).pop();
        return `<li class="${i <= curIdx ? 'done' : ''}"><div class="tl-t">${lb}</div>${ev ? `<div class="tl-d">${fmtDate(ev.created_at)}${ev.note ? ' — ' + esc(ev.note) : ''}</div>` : ''}</li>`;
      }).join('')}
      ${['annulee', 'litige'].includes(m.status) ? `<li class="done"><div class="tl-t">${m.status === 'annulee' ? 'Annulée' : 'Litige'}</div></li>` : ''}
    </ul></div>
    ${cancellable ? `<button class="btn ghost" onclick="A.cancelMission(${m.id})">Annuler cette ${isClient ? 'demande' : 'mission'}</button>` : ''}
    ${(isClient || isPro) && other ? `<button class="btn ghost" onclick="A.report(${m.id},${other.id})">⚠️ Signaler un problème</button>` : ''}
  </div>${bottomNav('missions')}`;
  updateBadges();
};

/* ---------- Chat ---------- */
routes.chat = async (id) => {
  if (!USER) { nav('#/login'); return; }
  let m, msgs;
  try { m = await api('/missions/' + id); msgs = await api('/missions/' + id + '/messages'); }
  catch (e) { toast(e.message, 'err'); back(); return; }
  currentChat = parseInt(id, 10);
  const other = m.role === 'client' ? (m.pro ? m.pro.name : 'Professionnel') : m.client.name;
  $app.innerHTML = `
  ${header(other + ' — ' + m.service, { bell: false })}
  <div class="chat-wrap">
    <div class="chat-msgs" id="chat-msgs">
      <div class="center muted small">Conversation liée à la mission n° ${esc(m.code)}</div>
      ${msgs.map(x => chatBubble(x)).join('')}
    </div>
    <div class="chat-input">
      <button class="icon-btn" onclick="A.chatPhoto(${m.id})" title="Envoyer une photo">📷</button>
      <button class="icon-btn" id="chat-rec" onclick="A.chatAudio(${m.id})" title="Message vocal">🎤</button>
      <textarea id="chat-text" rows="1" placeholder="Votre message…"></textarea>
      <button class="icon-btn main" onclick="A.chatSend(${m.id})">➤</button>
    </div>
    <input type="file" id="file-input" accept="image/*" style="display:none">
  </div>`;
  const box = document.getElementById('chat-msgs');
  box.scrollTop = box.scrollHeight;
  const ta = document.getElementById('chat-text');
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); A.chatSend(m.id); } });
  refreshBadges();
};
function chatBubble(x) {
  const me = USER && x.sender_id === USER.id;
  let inner = '';
  if (x.type === 'text') inner = esc(x.content);
  if (x.type === 'photo') inner = `<img src="${esc(x.file)}" onclick="A.viewPhoto('${esc(x.file)}')" onerror="this.outerHTML='<i>📷 Photo expirée</i>'">` + (x.content ? `<div>${esc(x.content)}</div>` : '');
  if (x.type === 'audio') inner = `<audio controls src="${esc(x.file)}"></audio>`;
  return `<div class="bubble ${me ? 'me' : 'them'}">${inner}<div class="b-time">${fmtDate(x.created_at)}</div></div>`;
}
function appendChatMsg(x) {
  const box = document.getElementById('chat-msgs');
  if (!box) return;
  box.insertAdjacentHTML('beforeend', chatBubble(x));
  box.scrollTop = box.scrollHeight;
}

/* ---------- Messages (conversations) ---------- */
routes.messages = async () => {
  if (!USER) { nav('#/login'); return; }
  let convs = [];
  try { convs = await api('/conversations'); } catch (e) { toast(e.message, 'err'); }
  $app.innerHTML = `
  ${header('Messages', { back: false })}
  <div class="content">
    ${convs.length ? convs.map(c => `
      <div class="card tap" onclick="nav('#/chat/${c.id}')"><div class="row">
        ${avatar(c.other)}
        <div class="grow"><div class="bold">${esc(c.other.name)} <span class="muted small">• ${esc(c.service_name)}</span></div>
        <div class="conv-prev">${c.last_type === 'photo' ? '📷 Photo' : c.last_type === 'audio' ? '🎤 Message vocal' : esc(c.last_content || '')}</div></div>
        <div style="text-align:right"><div class="muted small">${fmtDate(c.last_at)}</div>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>
      </div></div>`).join('') : emptyState('💬', 'Aucune conversation. Les discussions sont liées à vos demandes et missions.')}
  </div>${bottomNav('messages')}`;
  updateBadges();
};

/* ---------- Notifications ---------- */
routes.notifications = async () => {
  if (!USER) { nav('#/login'); return; }
  let d;
  try { d = await api('/notifications'); } catch (e) { toast(e.message, 'err'); return; }
  const icons = { mission: '🧰', message: '💬', paiement: '💰', compte: '👤', information: 'ℹ️', urgence: '🚨', systeme: '⚙️' };
  $app.innerHTML = `
  ${header('Notifications', { bell: false })}
  <div class="content">
    ${d.unread ? `<button class="btn sec sm mb" onclick="A.readAll()">Tout marquer comme lu (${d.unread})</button>` : ''}
    ${d.notifications.length ? d.notifications.map(n => `
      <div class="notif-item ${n.read ? '' : 'unread'}" onclick="A.openNotif(${n.id},'${esc(n.link || '')}')">
        <div class="notif-ic">${icons[n.category] || '🔔'}</div>
        <div class="grow"><div class="bold small">${esc(n.title)}</div><div class="small muted">${esc(n.body || '')}</div>
        <div class="small muted">${fmtDate(n.created_at)}</div></div>
      </div>`).join('') : emptyState('🔔', 'Aucune notification.')}
  </div>${bottomNav('home')}`;
};

/* ---------- Mon compte ---------- */
routes.account = async () => {
  if (!USER) { nav('#/login'); return; }
  try { USER = await api('/me'); } catch { }
  const statut = USER.pro_status === 'approved' ? 'Client • Professionnel' : 'Client';
  $app.innerHTML = `
  ${header('Mon compte', { back: false })}
  <div class="content">
    <div class="card"><div class="row">
      ${avatar(USER, 'lg')}
      <div class="grow">
        <div class="bold" style="font-size:18px">${esc(USER.name)} ${USER.verified ? '✅' : ''}</div>
        <div class="muted small">📞 ${esc(USER.phone)}</div>
        <div class="muted small">📍 ${esc(USER.address || 'Localisation non renseignée')}</div>
        <span class="pill ok" style="margin-top:5px">${statut}</span>
      </div></div></div>

    <div class="sec-title">Mes activités</div>
    <div class="menu-item" onclick="nav('#/missions')"><span class="mi-ic">📋</span>Mes demandes<span class="mi-arr">›</span></div>
    <div class="menu-item" onclick="nav('#/pro')"><span class="mi-ic">💼</span>Mon espace professionnel
      ${USER.pro_status === 'pending' ? '<span class="pill warn">En validation</span>' : USER.pro_status === 'approved' ? '' : '<span class="pill ok">Devenir pro</span>'}<span class="mi-arr">›</span></div>
    <div class="menu-item" onclick="nav('#/messages')"><span class="mi-ic">💬</span>Mes messages<span class="mi-arr">›</span></div>
    <div class="menu-item" onclick="nav('#/my-reviews')"><span class="mi-ic">⭐</span>Mes avis<span class="mi-arr">›</span></div>

    <div class="collap" id="c-autres">
      <div class="collap-head" onclick="A.collap('c-autres')">Autres services <span class="arr">›</span></div>
      <div class="collap-body">
        <div class="menu-item" onclick="nav('#/avis-recherche')"><span class="mi-ic">📢</span>Avis de recherche<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/jobs')"><span class="mi-ic">💼</span>Je cherche un job<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/ecole-famille')"><span class="mi-ic">🏫</span>École & famille<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/urgence')"><span class="mi-ic">🚨</span>Urgence<span class="mi-arr">›</span></div>
      </div>
    </div>

    <div class="collap" id="c-compte">
      <div class="collap-head" onclick="A.collap('c-compte')">Compte & paramètres <span class="arr">›</span></div>
      <div class="collap-body">
        <div class="menu-item" onclick="nav('#/infos')"><span class="mi-ic">✏️</span>Mes informations<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/addresses')"><span class="mi-ic">📍</span>Mes adresses<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/payments')"><span class="mi-ic">💳</span>Paiements<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/notifications')"><span class="mi-ic">🔔</span>Notifications<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/security')"><span class="mi-ic">🔒</span>Sécurité<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/settings')"><span class="mi-ic">⚙️</span>Paramètres<span class="mi-arr">›</span></div>
      </div>
    </div>
    ${['pdg', 'admin', 'gestionnaire', 'agent'].includes(USER.role) ? `<a class="menu-item" href="/admin" style="text-decoration:none;color:inherit"><span class="mi-ic">🖥️</span>Tableau de bord administrateur<span class="mi-arr">›</span></a>` : ''}
    <button class="btn ghost mt" onclick="logout()">Se déconnecter</button>
  </div>${bottomNav('account')}`;
  updateBadges();
};

/* ---------- Espace professionnel ---------- */
routes.pro = async () => {
  if (!USER) { nav('#/login'); return; }
  try { USER = await api('/me'); } catch { }
  if (USER.pro_status === 'approved') return renderProDashboard();
  if (USER.pro_status === 'pending') {
    $app.innerHTML = `${header('Espace professionnel')}
    <div class="content">
      <div class="status-banner search"><div class="spinner"></div>Votre demande est en cours de validation par l'administration. Vous serez notifié dès qu'elle sera traitée.</div>
      <div class="card"><div class="bold mb">Récapitulatif</div>
        <div class="small">Profession : ${esc(USER.pro ? USER.pro.profession : '')}</div>
        <div class="small">Zone : ${esc(USER.pro ? USER.pro.zone : '')}</div></div>
    </div>${bottomNav('account')}`;
    return;
  }
  // Devenir professionnel
  if (!SERVICES) SERVICES = await api('/services');
  let rules = { pro: '' };
  try { rules = await api('/rules'); } catch { }
  const rejected = USER.pro_status === 'rejected';
  $app.innerHTML = `${header('Devenir professionnel')}
  <div class="content">
    ${rejected ? `<div class="status-banner bad">Votre précédente demande a été refusée${USER.pro && USER.pro.rejected_reason ? ' : ' + esc(USER.pro.rejected_reason) : ''}. Vous pouvez compléter et renvoyer votre dossier.</div>` : ''}
    <div class="card">
      <div class="bold mb">Avec un seul compte, proposez aussi vos services 💼</div>
      <div class="muted small mb">Conditions : informations exactes, respect des règles professionnelles, validation par l'administration. Votre compte restera aussi un compte client.</div>
      <div class="field"><label>Votre profession <span class="req">*</span></label><input type="text" id="p-prof" placeholder="Ex : Plombier, Électricien, Agent d'entretien…" value="${esc(USER.pro ? USER.pro.profession : '')}"></div>
      <div class="field"><label>Services que vous proposez <span class="req">*</span></label>
        <div class="choices" id="p-services">
          ${SERVICES.flatMap(c => c.services).map(s => `<button type="button" class="chip ${USER.pro && USER.pro.services.includes(s.id) ? 'on' : ''}" data-sid="${s.id}" onclick="this.classList.toggle('on')">${esc(s.name)}</button>`).join('')}
        </div></div>
      <div class="field"><label>Zone d'intervention <span class="req">*</span></label><input type="text" id="p-zone" placeholder="Ex : Bouaké et environs" value="${esc(USER.pro ? USER.pro.zone : '')}"></div>
      <div class="field"><label>Expérience</label><input type="text" id="p-exp" placeholder="Ex : 5 ans d'expérience" value="${esc(USER.pro ? USER.pro.experience : '')}"></div>
      <div class="field"><label>Description</label><textarea id="p-desc" placeholder="Présentez-vous en quelques lignes…">${esc(USER.pro ? USER.pro.description : '')}</textarea></div>
      <div class="field"><label>Documents (CNI, diplômes… — facultatif mais recommandé)</label>
        <div class="photo-strip" id="p-docs"><button class="ph-add" onclick="A.pickPhotos('p-docs')">＋</button></div>
        <input type="file" id="file-input" accept="image/*,.pdf" multiple style="display:none">
      </div>
      <div class="sec-title">Règles professionnelles</div>
      <div class="rules-box">${esc(rules.pro || '')}</div>
      <label class="check-line"><input type="checkbox" id="p-accept"> J'ai lu et j'accepte les règles professionnelles de Klean-Services CI.</label>
      <button class="btn" id="b-apply">Envoyer ma demande</button>
    </div>
  </div>${bottomNav('account')}`;
  REQ = { photos: [] };
  document.getElementById('b-apply').onclick = async e => {
    const services = [...document.querySelectorAll('#p-services .chip.on')].map(c => parseInt(c.dataset.sid, 10));
    busy(e.target, true);
    try {
      await api('/pro/apply', {
        method: 'POST', body: {
          profession: document.getElementById('p-prof').value, services,
          zone: document.getElementById('p-zone').value, experience: document.getElementById('p-exp').value,
          description: document.getElementById('p-desc').value, documents: REQ.photos,
          accept_rules: document.getElementById('p-accept').checked
        }
      });
      toast('Demande envoyée ! L\u2019administration va la valider.', 'ok');
      render();
    } catch (err) { toast(err.message, 'err'); busy(e.target, false); }
  };
};

async function renderProDashboard() {
  let d;
  try { d = await api('/pro/dashboard'); } catch (e) { toast(e.message, 'err'); return; }
  const upcoming = d.missions.filter(m => ['confirmee', 'acceptee'].includes(m.status));
  $app.innerHTML = `${header('Mon espace professionnel')}
  <div class="content">
    ${USER.kp_code ? `<div class="card" style="text-align:center;padding:10px"><span class="muted small">Votre code professionnel</span><div class="bold" style="font-size:20px;letter-spacing:2px">${esc(USER.kp_code)}</div></div>` : ''}
    <div class="avail-toggle" onclick="A.toggleAvail(${d.available ? 0 : 1})">
      <div class="dot ${d.available ? 'on' : ''}"></div>
      <div class="grow"><div class="bold">${d.available ? '🟢 Disponible' : '⚪ Indisponible'}</div>
      <div class="muted small">${d.available ? 'Vous recevez les nouvelles missions.' : 'Touchez pour redevenir disponible et recevoir des missions.'}</div></div>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="v">${d.stats.en_cours}</div><div class="l">Missions en cours</div></div>
      <div class="stat"><div class="v">${d.stats.terminees}</div><div class="l">Missions terminées</div></div>
      <div class="stat"><div class="v">${(d.stats.revenus).toLocaleString('fr-FR')}</div><div class="l">Revenus (FCFA)</div></div>
      <div class="stat"><div class="v">${d.stats.rating ? d.stats.rating + ' ★' : '—'}</div><div class="l">${d.stats.reviews} évaluation(s)</div></div>
    </div>
    <div class="muted small center mb">Commission Klean-Services CI : ${d.stats.commission_rate}% par mission</div>
    ${d.offers.length ? `<div class="sec-title">🔔 Missions à traiter (${d.offers.length})</div>` + d.offers.map(m => `
      <div class="card tap" onclick="nav('#/mission/${m.id}')"><div class="row"><div class="grow">
        <div class="bold">${esc(m.service_name)}</div><div class="muted small">📍 ${esc(m.address || '')} ${m.urgence ? ' • 🔥 Urgent' : ''}</div></div>
        <span class="pill recherche">À traiter</span></div></div>`).join('') : ''}
    ${upcoming.length ? `<div class="sec-title">📅 Mon planning</div>` + upcoming.map(m => `
      <div class="card tap" onclick="nav('#/mission/${m.id}')"><div class="row"><div class="grow">
        <div class="bold">${esc(m.service_name)}</div><div class="muted small">${m.date_souhaitee ? '📅 ' + fmtDate(m.date_souhaitee) : 'Date à convenir'} • 📍 ${esc(m.address || '')}</div></div>
        ${statusPill(m.status)}</div></div>`).join('') : ''}
    <div class="sec-title">Gestion</div>
    <div class="menu-item" onclick="sessionStorage.setItem('ks_mtab','pro');nav('#/missions')"><span class="mi-ic">🧰</span>Toutes mes missions<span class="mi-arr">›</span></div>
    <div class="menu-item" onclick="nav('#/messages')"><span class="mi-ic">💬</span>Messages<span class="mi-arr">›</span></div>
    <div class="menu-item" onclick="nav('#/pro-revenus')"><span class="mi-ic">💰</span>Mes revenus<span class="mi-arr">›</span></div>
    <div class="menu-item" onclick="nav('#/my-reviews')"><span class="mi-ic">⭐</span>Mes évaluations<span class="mi-arr">›</span></div>
    <div class="menu-item" onclick="nav('#/pro-edit')"><span class="mi-ic">✏️</span>Mon profil professionnel<span class="mi-arr">›</span></div>
  </div>${bottomNav('account')}`;
  updateBadges();
}

routes['pro-edit'] = async () => {
  if (!USER || USER.pro_status !== 'approved') { nav('#/pro'); return; }
  if (!SERVICES) SERVICES = await api('/services');
  const p = USER.pro;
  $app.innerHTML = `${header('Mon profil professionnel')}
  <div class="content"><div class="card">
    <div class="field"><label>Profession</label><input type="text" id="p-prof" value="${esc(p.profession)}"></div>
    <div class="field"><label>Mes services</label><div class="choices" id="p-services">
      ${SERVICES.flatMap(c => c.services).map(s => `<button type="button" class="chip ${p.services.includes(s.id) ? 'on' : ''}" data-sid="${s.id}" onclick="this.classList.toggle('on')">${esc(s.name)}</button>`).join('')}</div></div>
    <div class="field"><label>Zone d'intervention</label><input type="text" id="p-zone" value="${esc(p.zone)}"></div>
    <div class="field"><label>Expérience</label><input type="text" id="p-exp" value="${esc(p.experience || '')}"></div>
    <div class="field"><label>Description</label><textarea id="p-desc">${esc(p.description || '')}</textarea></div>
    <button class="btn" id="b-save">Enregistrer</button>
  </div></div>${bottomNav('account')}`;
  document.getElementById('b-save').onclick = async e => {
    busy(e.target, true);
    try {
      USER = await api('/pro/profile', {
        method: 'PUT', body: {
          profession: document.getElementById('p-prof').value,
          services: [...document.querySelectorAll('#p-services .chip.on')].map(c => parseInt(c.dataset.sid, 10)),
          zone: document.getElementById('p-zone').value, experience: document.getElementById('p-exp').value,
          description: document.getElementById('p-desc').value
        }
      });
      toast('Profil mis à jour ✓', 'ok'); back();
    } catch (err) { toast(err.message, 'err'); busy(e.target, false); }
  };
};

routes['pro-revenus'] = async () => {
  if (!USER) { nav('#/login'); return; }
  let d;
  try { d = await api('/pro/dashboard'); } catch (e) { toast(e.message, 'err'); return; }
  const paid = d.missions.filter(m => m.status === 'payee');
  $app.innerHTML = `${header('Mes revenus')}
  <div class="content">
    <div class="stat-grid">
      <div class="stat"><div class="v">${d.stats.revenus.toLocaleString('fr-FR')}</div><div class="l">Total reçu (FCFA)</div></div>
      <div class="stat"><div class="v">${d.stats.commission_rate}%</div><div class="l">Commission plateforme</div></div>
    </div>
    ${paid.length ? paid.map(m => `<div class="card tap" onclick="nav('#/mission/${m.id}')"><div class="row"><div class="grow">
      <div class="bold">${esc(m.service_name)}</div><div class="muted small">${fmtDate(m.updated_at)}</div></div>
      <div class="bold" style="color:var(--ok)">${fmtFCFA(Math.round((m.amount || 0) * (1 - d.stats.commission_rate / 100)))}</div></div></div>`).join('')
      : emptyState('💰', 'Aucun revenu pour le moment. Vos missions payées apparaîtront ici.')}
  </div>${bottomNav('account')}`;
};

/* ---------- Profil public professionnel ---------- */
routes.pros = async (id) => {
  if (!USER) { nav('#/login'); return; }
  let p;
  try { p = await api('/pros/' + id); } catch (e) { toast(e.message, 'err'); back(); return; }
  $app.innerHTML = `${header(p.name)}
  <div class="content">
    <div class="card center">
      <div style="display:flex;justify-content:center">${avatar(p, 'lg')}</div>
      <div class="bold" style="font-size:19px;margin-top:8px">${esc(p.name)} ${p.verified ? '✅' : ''}</div>
      <div class="muted">${esc(p.profession || '')}</div>
      <div class="mt">${p.available ? '<span class="pill ok">🟢 Disponible</span>' : '<span class="pill warn">⚪ Indisponible</span>'}
      ${p.documents_valides ? '<span class="pill ok">📄 Documents fournis</span>' : ''}</div>
      <div class="stat-grid mt">
        <div class="stat"><div class="v">${p.rating ? p.rating + ' ★' : '—'}</div><div class="l">${p.reviews_count} avis</div></div>
        <div class="stat"><div class="v">${p.missions_done}</div><div class="l">Missions réalisées</div></div>
      </div>
    </div>
    <div class="card">
      <div class="small"><b>Zone d'intervention :</b> ${esc(p.zone || '')}</div>
      ${p.experience ? `<div class="small mt"><b>Expérience :</b> ${esc(p.experience)}</div>` : ''}
      ${p.services.length ? `<div class="small mt"><b>Services :</b> ${p.services.map(esc).join(' • ')}</div>` : ''}
      ${p.description ? `<div class="small mt">${esc(p.description)}</div>` : ''}
    </div>
    ${p.reviews.length ? `<div class="sec-title">Avis reçus</div>` + p.reviews.map(r => `
      <div class="card"><div class="row"><div class="grow"><b class="small">${esc(r.author)}</b>
      <span class="star-inline small">${'★'.repeat(r.rating)}</span></div><span class="muted small">${fmtDate(r.created_at)}</span></div>
      ${r.comment ? `<div class="small mt">${esc(r.comment)}</div>` : ''}</div>`).join('') : ''}
  </div>${bottomNav('search')}`;
};

/* ---------- Avis de recherche ---------- */
routes['avis-recherche'] = async () => {
  if (!USER) { nav('#/login'); return; }
  let list = [];
  try { list = await api('/avis-recherche'); } catch (e) { toast(e.message, 'err'); }
  $app.innerHTML = `${header('Avis de recherche')}
  <div class="content">
    <button class="btn mb" onclick="A.avisForm()">📢 Publier un avis de recherche</button>
    ${list.length ? list.map(a => `<div class="card">
      ${a.status === 'pending' && a.publisher ? '<span class="pill warn">En attente de validation</span>' : ''}
      <div class="row">${a.photo ? `<img src="${esc(a.photo)}" style="width:72px;height:72px;border-radius:10px;object-fit:cover">` : ''}
        <div class="grow"><div class="bold">${esc(a.nom)}</div>
        ${a.date_disparition ? `<div class="small">Disparu(e) le : ${esc(a.date_disparition)} ${esc(a.heure_disparition || '')}</div>` : ''}
        ${a.dernier_lieu ? `<div class="small">Dernier lieu connu : ${esc(a.dernier_lieu)}</div>` : ''}</div></div>
      ${a.derniere_vue ? `<div class="small mt">Vu(e) pour la dernière fois : ${esc(a.derniere_vue)}</div>` : ''}
      ${a.description_physique ? `<div class="small mt">Description : ${esc(a.description_physique)}</div>` : ''}
      ${a.vetements ? `<div class="small">Vêtements : ${esc(a.vetements)}</div>` : ''}
      ${a.description ? `<div class="small mt">${esc(a.description)}</div>` : ''}
      ${a.infos ? `<div class="small mt">${esc(a.infos)}</div>` : ''}
      <div class="small mt bold">📞 Contact : <a href="tel:${esc(a.contact)}">${esc(a.contact)}</a></div>
    </div>`).join('') : emptyState('📢', 'Aucun avis de recherche publié.')}
  </div>${bottomNav('account')}`;
};

/* ---------- Je cherche un job ---------- */
routes.jobs = async () => {
  if (!USER) { nav('#/login'); return; }
  const q = sessionStorage.getItem('ks_jobq') || '';
  let list = [];
  try { list = await api('/jobs' + (q ? '?q=' + encodeURIComponent(q) : '')); } catch (e) { toast(e.message, 'err'); }
  $app.innerHTML = `${header('Je cherche un job')}
  <div class="content">
    <button class="btn mb" onclick="A.jobForm()">💼 Publier mon profil</button>
    <div class="searchbar"><input type="text" id="job-q" placeholder="🔎 Rechercher un profil (ex : chauffeur)" value="${esc(q)}"><button onclick="A.jobSearch()">🔍</button></div>
    ${list.length ? list.map(j => `<div class="card">
      ${j.status === 'pending' ? '<span class="pill warn">En attente de validation</span>' : ''}
      <div class="row">${avatar({ name: j.publisher, photo: j.photo })}
        <div class="grow"><div class="bold">${esc(j.metier)}</div><div class="muted small">${esc(j.publisher)} • ${esc(j.localisation || '')}</div></div></div>
      ${j.competences ? `<div class="small mt"><b>Compétences :</b> ${esc(j.competences)}</div>` : ''}
      ${j.experience ? `<div class="small"><b>Expérience :</b> ${esc(j.experience)}</div>` : ''}
      ${j.disponibilite ? `<div class="small"><b>Disponibilité :</b> ${esc(j.disponibilite)}</div>` : ''}
      ${j.description ? `<div class="small mt">${esc(j.description)}</div>` : ''}
      ${j.cv ? `<div class="small mt"><a href="${esc(j.cv)}" target="_blank">📄 Voir le CV</a></div>` : ''}
      <div class="small mt bold">📞 <a href="tel:${esc(j.contact)}">${esc(j.contact)}</a></div>
    </div>`).join('') : emptyState('💼', 'Aucun profil publié pour le moment.')}
  </div>${bottomNav('account')}`;
  document.getElementById('job-q').addEventListener('keydown', e => { if (e.key === 'Enter') A.jobSearch(); });
};

/* ---------- École & famille ---------- */
routes['ecole-famille'] = async () => {
  if (!USER) { nav('#/login'); return; }
  let mine = [];
  try { mine = await api('/ecole-famille'); } catch { }
  $app.innerHTML = `${header('École & famille')}
  <div class="content">
    <div class="card">
      <div class="bold mb">🏫 Dites-nous ce dont vous avez besoin</div>
      <div class="field"><label>Type de demande <span class="req">*</span></label>
        <div class="choices" id="ef-type">
          ${['Soutien scolaire', 'Garde d\u2019enfants', 'Inscription / orientation', 'Accompagnement familial', 'Autre'].map(t => `<button type="button" class="chip" onclick="A.pickChip(this,'${t.replace(/'/g, "\\'")}')">${t}</button>`).join('')}
        </div></div>
      <div class="field"><label>Décrivez votre besoin <span class="req">*</span></label><textarea id="ef-details" placeholder="Ex : Je cherche un répétiteur de maths pour mon fils en 3e…"></textarea></div>
      <div class="field"><label>Contact</label><input type="tel" id="ef-contact" value="${esc(USER.phone)}"></div>
      <button class="btn" id="b-ef">Envoyer ma demande</button>
    </div>
    ${mine.length ? `<div class="sec-title">Mes demandes</div>` + mine.map(x => `<div class="card"><div class="row"><div class="grow">
      <div class="bold small">${esc(x.type)}</div><div class="small muted">${esc(x.details)}</div></div>
      <span class="pill ${x.status === 'traite' ? 'ok' : 'warn'}">${x.status === 'nouveau' ? 'Envoyée' : x.status === 'en_traitement' ? 'En traitement' : 'Traitée'}</span></div></div>`).join('') : ''}
  </div>${bottomNav('account')}`;
  document.getElementById('b-ef').onclick = async e => {
    const typeEl = document.querySelector('#ef-type');
    busy(e.target, true);
    try {
      await api('/ecole-famille', { method: 'POST', body: { type: typeEl.dataset.val, details: document.getElementById('ef-details').value, contact: document.getElementById('ef-contact').value } });
      toast('Demande envoyée ! Nous vous recontacterons.', 'ok'); render();
    } catch (err) { toast(err.message, 'err'); busy(e.target, false); }
  };
};

/* ---------- Urgence ---------- */
routes.urgence = async () => {
  if (!USER) { nav('#/login'); return; }
  let cfg = { info: '', contacts: [] };
  try { cfg = await api('/urgence/config'); } catch { }
  $app.innerHTML = `${header('Urgence')}
  <div class="content">
    <div class="status-banner bad">🚨 ${esc(cfg.info)}</div>
    <div class="sec-title">Numéros utiles</div>
    ${cfg.contacts.map(c => `<a class="menu-item" href="tel:${esc(c.tel)}" style="text-decoration:none;color:inherit"><span class="mi-ic">📞</span>${esc(c.nom)}<span class="mi-arr bold">${esc(c.tel)}</span></a>`).join('')}
    <button class="sos-btn" onclick="A.sosConfirm()">🚨 ENVOYER UNE ALERTE</button>
    <div class="muted small center">Une confirmation vous sera demandée pour éviter tout déclenchement accidentel.</div>
  </div>${bottomNav('account')}`;
};

/* ---------- Mes informations / adresses / sécurité / paramètres ---------- */
routes.infos = async () => {
  if (!USER) { nav('#/login'); return; }
  let villes = [];
  try { villes = await api('/villes'); } catch { }
  $app.innerHTML = `${header('Mes informations')}
  <div class="content"><div class="card">
    <div class="center mb">${avatar(USER, 'lg')}<br><button class="btn sec sm mt" onclick="A.pickAvatar()">📷 Changer la photo</button>
    <input type="file" id="file-input" accept="image/*" style="display:none"></div>
    ${USER.profile_incomplete ? '<div class="card" style="border-left:4px solid #e67e22;background:#fff8f0"><div class="small">👋 Votre compte a été créé par notre équipe : complétez vos informations ci-dessous.</div></div>' : ''}
    <div class="field"><label>Nom complet</label><input type="text" id="i-name" placeholder="Ex : John Sery Michael" value="${esc(USER.name)}"></div>
    <div class="field"><label>Téléphone</label><input type="tel" value="${esc(USER.phone)}" disabled style="background:#f1f5f9"></div>
    <div class="field"><label>E-mail</label><input type="email" id="i-email" placeholder="facultatif" value="${esc(USER.email || '')}"></div>
    <div class="field"><label>Ville</label>
      <input type="text" id="i-ville" list="villes-ci" placeholder="Tapez pour chercher votre ville…" autocomplete="off" value="${esc(USER.ville || '')}">
      <datalist id="villes-ci">${villes.map(v => `<option value="${esc(v)}">`).join('')}</datalist>
    </div>
    <div class="field"><label>Quartier</label><input type="text" id="i-quartier" placeholder="Ex : Air France, Cocody Angré…" value="${esc(USER.quartier || '')}"></div>
    <div class="field"><label>Adresse / précisions</label><input type="text" id="i-addr" value="${esc(USER.address || '')}"></div>
    <button class="btn" id="b-save">Enregistrer</button>
  </div></div>${bottomNav('account')}`;
  document.getElementById('b-save').onclick = async e => {
    busy(e.target, true);
    try {
      USER = await api('/me', { method: 'PUT', body: {
        name: document.getElementById('i-name').value, email: document.getElementById('i-email').value,
        ville: document.getElementById('i-ville').value, quartier: document.getElementById('i-quartier').value,
        address: document.getElementById('i-addr').value } });
      toast('Informations mises à jour ✓', 'ok'); back();
    } catch (err) { toast(err.message, 'err'); busy(e.target, false); }
  };
};

routes.addresses = async () => {
  if (!USER) { nav('#/login'); return; }
  let list = [];
  try { list = await api('/addresses'); } catch { }
  $app.innerHTML = `${header('Mes adresses')}
  <div class="content">
    <div class="card">
      <div class="field"><label>Libellé</label><input type="text" id="a-label" placeholder="Ex : Maison, Bureau…"></div>
      <div class="field"><label>Adresse</label><input type="text" id="a-addr" placeholder="Ex : Bouaké, quartier Broukro…"></div>
      <button class="btn sec" id="b-add">＋ Ajouter cette adresse</button>
    </div>
    ${list.map(a => `<div class="card"><div class="row"><span class="mi-ic">📍</span><div class="grow">
      <div class="bold small">${esc(a.label || 'Adresse')}</div><div class="small muted">${esc(a.address)}</div></div>
      <button class="btn ghost sm" onclick="A.delAddr(${a.id})">🗑️</button></div></div>`).join('')}
  </div>${bottomNav('account')}`;
  document.getElementById('b-add').onclick = async e => {
    busy(e.target, true);
    try {
      await api('/addresses', { method: 'POST', body: { label: document.getElementById('a-label').value, address: document.getElementById('a-addr').value } });
      toast('Adresse ajoutée ✓', 'ok'); render();
    } catch (err) { toast(err.message, 'err'); busy(e.target, false); }
  };
};

routes.security = async () => {
  if (!USER) { nav('#/login'); return; }
  $app.innerHTML = `${header('Sécurité')}
  <div class="content">
    <div class="card">
      <div class="bold mb">Changer mon mot de passe</div>
      ${pwField('s-cur', 'Mot de passe actuel')}
      ${pwField('s-new', 'Nouveau mot de passe')}
      <button class="btn" id="b-pass">Mettre à jour</button>
    </div>
    <div class="card">
      <div class="bold mb">⚠️ Signaler un problème</div>
      <div class="field"><textarea id="s-report" placeholder="Décrivez le problème rencontré…"></textarea></div>
      <button class="btn warn" id="b-report">Envoyer le signalement</button>
    </div>
  </div>${bottomNav('account')}`;
  document.getElementById('b-pass').onclick = async e => {
    busy(e.target, true);
    try {
      await api('/me/password', { method: 'PUT', body: { current: document.getElementById('s-cur').value, password: document.getElementById('s-new').value } });
      toast('Mot de passe mis à jour ✓', 'ok'); back();
    } catch (err) { toast(err.message, 'err'); busy(e.target, false); }
  };
  document.getElementById('b-report').onclick = async e => {
    busy(e.target, true);
    try {
      await api('/signalements', { method: 'POST', body: { reason: document.getElementById('s-report').value } });
      toast('Signalement envoyé. L\u2019administration va le traiter.', 'ok'); document.getElementById('s-report').value = '';
    } catch (err) { toast(err.message, 'err'); }
    busy(e.target, false);
  };
};

routes.settings = () => {
  if (!USER) { nav('#/login'); return; }
  const sound = localStorage.getItem('ks_sound') !== '0';
  const font = parseInt(USER.font_size || localStorage.getItem('ks_font') || 16, 10);
  $app.innerHTML = `${header('Paramètres')}
  <div class="content">
    <div class="card">
      <div class="bold small mb">🔠 Taille du texte</div>
      <div class="muted small mb">Toute l'application s'adapte proportionnellement, sans débordement.</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${FONT_SIZES.map(s => `<button class="chip ${font === s ? 'on' : ''}" style="font-size:${Math.min(s, 20)}px" onclick="A.setFont(${s})">${s === 16 ? s + ' (normal)' : s}</button>`).join('')}
      </div>
      <div class="small muted mt">Aperçu : <span style="font-size:${font}px">Klean-Services CI — tous vos services à portée de main.</span></div>
    </div>
    <div class="card">
      <div class="switch"><div><div class="bold small">🔊 Son des notifications</div><div class="muted small">Jouer un son à chaque notification</div></div>
      <button class="chip ${sound ? 'on' : ''}" onclick="A.toggleSound(this)">${sound ? 'Activé' : 'Désactivé'}</button></div>
    </div>
    <div class="card muted small">
      <b>Klean-Services CI</b><br>Version 2.0 — Tous vos services à portée de main.<br>
      JE CHERCHE → JE DEMANDE → JE SUIS MIS EN RELATION → JE COMMUNIQUE → JE RÉALISE → JE PAIE → J'ÉVALUE
    </div>
  </div>${bottomNav('account')}`;
};

routes['my-reviews'] = async () => {
  if (!USER) { nav('#/login'); return; }
  let d = { received: [], given: [] };
  try { d = await api('/reviews/mine'); } catch { }
  $app.innerHTML = `${header('Mes avis')}
  <div class="content">
    <div class="sec-title">Avis reçus (${d.received.length})</div>
    ${d.received.length ? d.received.map(r => `<div class="card"><div class="row"><div class="grow"><b class="small">${esc(r.author)}</b>
      <span class="star-inline small">${'★'.repeat(r.rating)}</span></div><span class="muted small">${fmtDate(r.created_at)}</span></div>
      ${r.comment ? `<div class="small mt">${esc(r.comment)}</div>` : ''}</div>`).join('') : '<div class="muted small mb">Aucun avis reçu.</div>'}
    <div class="sec-title">Avis donnés (${d.given.length})</div>
    ${d.given.length ? d.given.map(r => `<div class="card"><div class="row"><div class="grow"><b class="small">Pour ${esc(r.target)}</b>
      <span class="star-inline small">${'★'.repeat(r.rating)}</span></div><span class="muted small">${fmtDate(r.created_at)}</span></div>
      ${r.comment ? `<div class="small mt">${esc(r.comment)}</div>` : ''}</div>`).join('') : '<div class="muted small">Aucun avis donné.</div>'}
  </div>${bottomNav('account')}`;
};

routes.payments = async () => {
  if (!USER) { nav('#/login'); return; }
  let d;
  try { d = await api('/missions'); } catch (e) { toast(e.message, 'err'); return; }
  const all = [...d.client, ...d.pro].filter(m => ['terminee', 'payee'].includes(m.status) && m.amount);
  $app.innerHTML = `${header('Paiements')}
  <div class="content">
    <div class="muted small mb">Les paiements s'effectuent en espèces à la fin de la mission, puis sont confirmés par les deux parties dans l'application.</div>
    ${all.length ? all.map(m => `<div class="card tap" onclick="nav('#/mission/${m.id}')"><div class="row"><div class="grow">
      <div class="bold small">${esc(m.service)}</div><div class="muted small">${fmtDate(m.updated_at)} • Espèces</div></div>
      <div style="text-align:right"><div class="bold">${fmtFCFA(m.amount)}</div>
      <span class="pill ${m.status === 'payee' ? 'ok' : 'warn'}">${m.status === 'payee' ? 'Payé ✓' : 'En attente'}</span></div></div></div>`).join('')
      : emptyState('💳', 'Aucun paiement pour le moment.')}
  </div>${bottomNav('account')}`;
};

/* ---------- Jeux ---------- */
routes.quiz = async () => {
  if (!USER) { nav('#/login'); return; }
  let qs;
  try { qs = await api('/games/quiz'); } catch (e) { toast(e.message, 'err'); back(); return; }
  let answers = {};
  window._quizAnswers = answers;
  $app.innerHTML = `${header('Quiz')}
  <div class="content">
    ${qs.map((q, i) => `<div class="card"><div class="bold mb">${i + 1}. ${esc(q.question)}</div>
      <div class="choices" data-qid="${q.id}">${q.options.map((o, j) => `<button type="button" class="chip" onclick="A.quizPick(this,${q.id},${j})">${esc(o)}</button>`).join('')}</div></div>`).join('')}
    <button class="btn" id="b-quiz">Valider mes réponses</button>
  </div>${bottomNav('home')}`;
  document.getElementById('b-quiz').onclick = async e => {
    busy(e.target, true);
    try {
      const r = await api('/games/quiz', { method: 'POST', body: { answers: window._quizAnswers } });
      openModal(`<h3>Résultat</h3><div class="center" style="font-size:40px">${r.score === r.total ? '🏆' : r.score > r.total / 2 ? '🎉' : '🙂'}</div>
      <div class="center bold" style="font-size:22px">${r.score} / ${r.total}</div>
      <button class="btn mt" onclick="closeModal();back()">Fermer</button>`);
    } catch (err) { toast(err.message, 'err'); }
    busy(e.target, false);
  };
};
routes.flip = async () => {
  if (!USER) { nav('#/login'); return; }
  $app.innerHTML = `${header('Flip Fizz')}
  <div class="content center">
    <div class="card"><div style="font-size:60px">🎲</div>
      <div class="bold mb">Tentez votre chance ! (3 essais par jour)</div>
      <button class="btn" id="b-flip">Jouer</button>
      <div id="flip-result" class="mt"></div></div>
  </div>${bottomNav('home')}`;
  document.getElementById('b-flip').onclick = async e => {
    busy(e.target, true, '🎲 …');
    try {
      const r = await api('/games/flipfizz', { method: 'POST' });
      document.getElementById('flip-result').innerHTML = r.win
        ? `<div class="status-banner ok">🎉 GAGNÉ ! L'équipe Klean-Services CI vous contactera pour votre récompense.</div>`
        : `<div class="status-banner info">Pas de chance cette fois. Essais restants aujourd'hui : ${r.essais_restants}</div>`;
    } catch (err) { toast(err.message, 'err'); }
    busy(e.target, false);
  };
};
routes.kdo = async () => {
  if (!USER) { nav('#/login'); return; }
  $app.innerHTML = `${header('Kdo')}
  <div class="content">
    <div class="card center"><div style="font-size:50px">🎁</div>
      <div class="bold mb">Vous avez un code cadeau ?</div>
      <div class="field"><input type="text" id="kdo-code" placeholder="Entrez votre code" style="text-transform:uppercase;text-align:center"></div>
      <button class="btn" id="b-kdo">Valider le code</button></div>
  </div>${bottomNav('home')}`;
  document.getElementById('b-kdo').onclick = async e => {
    busy(e.target, true);
    try {
      const r = await api('/games/kdo', { method: 'POST', body: { code: document.getElementById('kdo-code').value } });
      openModal(`<h3>🎁 Félicitations !</h3><div class="center bold">${esc(r.reward)}</div><button class="btn mt" onclick="closeModal()">Fermer</button>`);
    } catch (err) { toast(err.message, 'err'); }
    busy(e.target, false);
  };
};

/* ============================================================
   ACTIONS GLOBALES
   ============================================================ */
const A = {
  goSearch() { const v = document.getElementById('home-q').value.trim(); nav('#/search/' + encodeURIComponent(v)); },
  catOpen(id) {
    const cur = parseInt(sessionStorage.getItem('ks_cat_open') || 0, 10);
    sessionStorage.setItem('ks_cat_open', cur === id ? 0 : id);
    render();
  },
  catFilter() { render(); },
  async maintRetry() { await checkMaintenance(); render(); },
  eye(id, btn) {
    const i = document.getElementById(id);
    i.type = i.type === 'password' ? 'text' : 'password';
    btn.textContent = i.type === 'password' ? '👁️' : '🙈';
  },
  async setFont(px) {
    const v = applyFont(px);
    if (USER) { try { await api('/me', { method: 'PUT', body: { font_size: v } }); USER.font_size = v; } catch { } }
    render();
  },
  /* Récupération sécurisée de l'accès (mot de passe oublié) */
  forgot(phone) {
    openModal(`<h3>🔑 Récupérer mon accès</h3>
      <p class="small muted">Indiquez le numéro de téléphone de votre compte. Un code de vérification à 6 chiffres sera généré : notre équipe vous le communique après vérification de votre identité. Votre ancien mot de passe n\u2019est jamais affiché.</p>
      <div class="field"><label>Numéro de téléphone</label><input type="tel" id="fg-phone" placeholder="Ex : 07 00 00 00 00" value="${esc(phone || '')}"></div>
      <button class="btn" onclick="A.forgotRequest()">Recevoir mon code</button>
      <button class="btn ghost" onclick="A.forgotStep2()">J\u2019ai déjà un code</button>
      <button class="btn ghost" onclick="closeModal()">Annuler</button>`);
  },
  async forgotRequest() {
    const phone = document.getElementById('fg-phone').value.trim();
    if (!phone) return toast('Indiquez votre numéro de téléphone.', 'err');
    try {
      const r = await api('/auth/reset-request', { method: 'POST', body: { phone } });
      toast(r.message, 'ok');
      A.forgotStep2(phone);
    } catch (e) { toast(e.message, 'err'); }
  },
  forgotStep2(phone) {
    const p = phone || (document.getElementById('fg-phone') ? document.getElementById('fg-phone').value : '');
    openModal(`<h3>🔑 Nouveau mot de passe</h3>
      <p class="small muted">Entrez le code à 6 chiffres qui vous a été communiqué, puis choisissez votre nouveau mot de passe.</p>
      <div class="field"><label>Numéro de téléphone</label><input type="tel" id="fg2-phone" value="${esc(p || '')}"></div>
      <div class="field"><label>Code de vérification (6 chiffres)</label><input type="tel" id="fg2-code" maxlength="6" placeholder="______" style="letter-spacing:6px;text-align:center;font-size:20px"></div>
      ${pwField('fg2-pass', 'Nouveau mot de passe (6 caractères min.)')}
      ${pwField('fg2-pass2', 'Confirmez le nouveau mot de passe')}
      <button class="btn" onclick="A.forgotConfirm()">Valider mon nouveau mot de passe</button>
      <button class="btn ghost" onclick="closeModal()">Annuler</button>`);
  },
  async forgotConfirm() {
    const p1 = document.getElementById('fg2-pass').value, p2 = document.getElementById('fg2-pass2').value;
    if (p1.length < 6) return toast('Le nouveau mot de passe doit contenir au moins 6 caractères.', 'err');
    if (p1 !== p2) return toast('Les deux mots de passe ne sont pas identiques.', 'err');
    try {
      const r = await api('/auth/reset-confirm', { method: 'POST', body: { phone: document.getElementById('fg2-phone').value, code: document.getElementById('fg2-code').value, password: p1 } });
      TOKEN = r.token; USER = r.user; localStorage.setItem('ks_token', TOKEN);
      if (USER.font_size) applyFont(USER.font_size);
      closeModal(); connectSSE(); refreshBadges();
      toast('Mot de passe modifié ✓ Vous êtes connecté.', 'ok');
      nav('#/home');
    } catch (e) { toast(e.message, 'err'); }
  },
  async forcePwdSave() {
    const cur = document.getElementById('fp-cur').value, nv = document.getElementById('fp-new').value, nv2 = document.getElementById('fp-new2').value;
    if (nv.length < 6) return toast('Le nouveau mot de passe doit contenir au moins 6 caractères.', 'err');
    if (nv !== nv2) return toast('Les deux mots de passe ne sont pas identiques.', 'err');
    try {
      await api('/me/password', { method: 'PUT', body: { current: cur, password: nv } });
      USER.must_change_password = false;
      closeModal(); toast('Mot de passe enregistré ✓ Bienvenue !', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  openCat(catId) {
    const c = SERVICES.find(x => x.id === catId);
    if (!c) return;
    if (c.services.length === 1) { nav('#/request/' + c.services[0].id); return; }
    openModal(`<h3>${esc(c.icon || '')} ${esc(c.name)}</h3>
      ${c.services.map(s => `<div class="menu-item" onclick="closeModal();nav('#/request/${s.id}')"><span class="mi-ic">${esc(c.icon || '🔹')}</span>${esc(s.name)}<span class="mi-arr">›</span></div>`).join('')}`);
  },
  async doSearch() {
    const q = document.getElementById('s-q').value.trim();
    const zone = document.getElementById('s-results');
    if (!q) { zone.innerHTML = '<div class="hint">Tapez votre besoin ci-dessus.</div>'; return; }
    zone.innerHTML = '<div class="center muted mt"><div class="spinner" style="margin:0 auto"></div></div>';
    try {
      const r = await api('/search?q=' + encodeURIComponent(q));
      zone.innerHTML = r.results.length
        ? `<div class="sec-title">Services correspondants</div>` + r.results.map(s =>
          `<div class="menu-item" onclick="${s.tache_suggeree ? `sessionStorage.setItem('ks_sug_tache','${esc(s.tache_suggeree).replace(/'/g, "\\'")}');` : ''}nav('#/request/${s.id}')">
            <span class="mi-ic">${esc(s.icon || '🔹')}</span>
            <div><div>${esc(s.name)}</div><div class="muted small">${esc(s.category)}${s.sous_categorie ? ' › ' + esc(s.sous_categorie) : ''}${s.tache_suggeree ? ` — <b>${esc(s.tache_suggeree)}</b>` : ''}</div></div>
            <span class="mi-arr">›</span></div>`).join('')
        : emptyState('🔍', 'Aucun service trouvé pour « ' + q + ' ».') + `<button class="btn sec" onclick="nav('#/services')">Voir tous les services</button>`;
    } catch (e) { zone.innerHTML = emptyState('📶', e.message); }
  },
  pickChip(el, val) {
    [...el.parentElement.children].forEach(c => c.classList.remove('on'));
    el.classList.add('on');
    el.parentElement.dataset.val = val;
  },
  collap(id) { document.getElementById(id).classList.toggle('open'); },
  mTab(t) { sessionStorage.setItem('ks_mtab', t); render(); },
  toggleSound(el) {
    const now = localStorage.getItem('ks_sound') !== '0';
    localStorage.setItem('ks_sound', now ? '0' : '1');
    render();
  },
  viewPhoto(src) { openModal(`<img src="${esc(src)}" style="width:100%;border-radius:12px"><button class="btn mt" onclick="closeModal()">Fermer</button>`); },

  /* Photos */
  pickPhotos(zoneId) {
    const input = document.getElementById('file-input');
    input.onchange = async () => {
      if (!input.files.length) return;
      const fd = new FormData();
      [...input.files].forEach(f => fd.append('files', f));
      toast('Envoi des fichiers…');
      try {
        const r = await api('/upload', { method: 'POST', body: fd });
        REQ.photos.push(...r.files);
        const zone = document.getElementById(zoneId);
        r.files.forEach(f => zone.insertAdjacentHTML('afterbegin', `<img src="${esc(f)}">`));
        toast('Fichier(s) ajouté(s) ✓', 'ok');
      } catch (e) { toast(e.message, 'err'); }
      input.value = '';
    };
    input.click();
  },
  pickAvatar() {
    const input = document.getElementById('file-input');
    input.onchange = async () => {
      if (!input.files.length) return;
      const fd = new FormData(); fd.append('files', input.files[0]);
      try {
        const r = await api('/upload', { method: 'POST', body: fd });
        USER = await api('/me', { method: 'PUT', body: { photo: r.files[0] } });
        toast('Photo mise à jour ✓', 'ok'); render();
      } catch (e) { toast(e.message, 'err'); }
    };
    input.click();
  },

  /* Audio */
  _rec: null, _recChunks: [],
  async toggleRec(zoneId) {
    const btn = document.getElementById('r-rec');
    if (A._rec && A._rec.state === 'recording') { A._rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      A._recChunks = [];
      A._rec = new MediaRecorder(stream);
      A._rec.ondataavailable = e => A._recChunks.push(e.data);
      A._rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(A._recChunks, { type: A._rec.mimeType || 'audio/webm' });
        const fd = new FormData(); fd.append('files', blob, 'vocal.webm');
        try {
          const r = await api('/upload', { method: 'POST', body: fd });
          REQ.audio = r.files[0];
          document.getElementById(zoneId).innerHTML = `<audio controls src="${esc(REQ.audio)}"></audio> <button class="btn ghost sm" onclick="REQ.audio=null;this.parentElement.innerHTML='<button class=\\'btn sec sm\\' id=\\'r-rec\\' onclick=\\'A.toggleRec(\\'${zoneId}\\')\\'>🎤 Enregistrer un message vocal</button>'">🗑️</button>`;
          toast('Message vocal enregistré ✓', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
      A._rec.start();
      btn.textContent = '⏹️ Arrêter l\u2019enregistrement';
      btn.classList.add('warn');
    } catch { toast('Microphone non autorisé. Autorisez l\u2019accès au micro ou envoyez un message texte.', 'err'); }
  },

  /* GPS */
  useGPS() {
    const btn = document.getElementById('b-gps');
    if (!navigator.geolocation) { toast('GPS non disponible sur cet appareil. Saisissez votre adresse manuellement.', 'err'); return; }
    btn.textContent = '📍 Localisation…'; btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      pos => {
        REQ.lat = pos.coords.latitude; REQ.lng = pos.coords.longitude;
        btn.textContent = '📍 Position enregistrée ✓'; btn.disabled = false;
        const addr = document.getElementById('r-addr');
        if (!addr.value.trim()) addr.placeholder = 'Position GPS enregistrée — précisez le quartier/repère';
        toast('Position GPS enregistrée ✓ Précisez le quartier si besoin.', 'ok');
      },
      () => {
        btn.textContent = '📍 Utiliser ma position'; btn.disabled = false;
        toast('Localisation refusée ou indisponible. Pas de souci : saisissez votre adresse manuellement.', 'err');
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  },

  /* Actions mission */
  async acceptMission(id, btn) {
    busy(btn, true);
    try { await api('/missions/' + id + '/accept', { method: 'POST' }); toast('Mission acceptée ! Le client a été notifié.', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); render(); }
  },
  async refuseMission(id, btn) {
    busy(btn, true);
    try { await api('/missions/' + id + '/refuse', { method: 'POST' }); toast('Mission refusée.', 'ok'); nav('#/missions'); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  async confirmMission(id, btn) {
    busy(btn, true);
    try { await api('/missions/' + id + '/confirm', { method: 'POST' }); toast('Professionnel confirmé ! La mission est programmée.', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  async startMission(id, btn) {
    busy(btn, true);
    try { await api('/missions/' + id + '/start', { method: 'POST' }); toast('Mission démarrée.', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  async completeMission(id, btn) {
    busy(btn, true);
    try { await api('/missions/' + id + '/complete', { method: 'POST' }); toast('Mission terminée ! En attente du paiement.', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  async setAmount(id, btn) {
    const v = document.getElementById('m-amount').value;
    busy(btn, true);
    try { await api('/missions/' + id + '/montant', { method: 'POST', body: { amount: v } }); toast('Montant enregistré ✓', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  async confirmPay(id, btn) {
    openModal(`<h3>💵 Confirmation du paiement</h3>
      <p class="small">Confirmez-vous que le paiement en espèces a bien été ${btn.textContent.includes('reçu') ? 'reçu' : 'remis'} ? Cette action est enregistrée.</p>
      <div class="btn-row"><button class="btn sec" onclick="closeModal()">Annuler</button>
      <button class="btn" onclick="A._doPay(${id},this)">Oui, je confirme</button></div>`);
  },
  async _doPay(id, btn) {
    busy(btn, true);
    try { await api('/missions/' + id + '/payment/confirm', { method: 'POST' }); closeModal(); toast('Paiement confirmé ✓', 'ok'); render(); }
    catch (e) { closeModal(); toast(e.message, 'err'); render(); }
  },
  async relancer(id, btn) {
    busy(btn, true);
    try { await api('/missions/' + id + '/relancer', { method: 'POST' }); toast('Recherche relancée !', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  async choosePro(mid, pid, btn) {
    busy(btn, true);
    try { await api('/missions/' + mid + '/choisir/' + pid, { method: 'POST' }); toast('Professionnel sollicité ! Il a été notifié.', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  cancelMission(id) {
    openModal(`<h3>Annuler ?</h3><p class="small">Voulez-vous vraiment annuler ? L'autre partie sera notifiée.</p>
      <div class="field"><input type="text" id="cancel-reason" placeholder="Raison (facultatif)"></div>
      <div class="btn-row"><button class="btn sec" onclick="closeModal()">Non</button>
      <button class="btn warn" onclick="A._doCancel(${id},this)">Oui, annuler</button></div>`);
  },
  async _doCancel(id, btn) {
    busy(btn, true);
    try { await api('/missions/' + id + '/cancel', { method: 'POST', body: { reason: document.getElementById('cancel-reason').value } }); closeModal(); toast('Annulé.', 'ok'); render(); }
    catch (e) { closeModal(); toast(e.message, 'err'); }
  },
  report(missionId, targetId) {
    openModal(`<h3>⚠️ Signaler un problème</h3>
      <div class="field"><textarea id="rep-reason" placeholder="Décrivez le problème…"></textarea></div>
      <div class="btn-row"><button class="btn sec" onclick="closeModal()">Annuler</button>
      <button class="btn warn" onclick="A._doReport(${missionId},${targetId},this)">Envoyer</button></div>`);
  },
  async _doReport(missionId, targetId, btn) {
    busy(btn, true);
    try { await api('/signalements', { method: 'POST', body: { mission_id: missionId, target_id: targetId, reason: document.getElementById('rep-reason').value } }); closeModal(); toast('Signalement envoyé à l\u2019administration.', 'ok'); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },

  /* Avis */
  _star: 0,
  setStar(n) {
    A._star = n;
    document.querySelectorAll('#rv-stars span').forEach((s, i) => s.classList.toggle('on', i < n));
  },
  async sendReview(id, btn) {
    if (!A._star) { toast('Choisissez une note (1 à 5 étoiles).', 'err'); return; }
    busy(btn, true);
    try {
      await api('/missions/' + id + '/review', { method: 'POST', body: { rating: A._star, comment: document.getElementById('rv-comment').value } });
      toast('Merci pour votre évaluation !', 'ok'); A._star = 0; render();
    } catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },

  /* Chat */
  async chatSend(id) {
    const ta = document.getElementById('chat-text');
    const v = ta.value.trim();
    if (!v) return;
    ta.value = '';
    try { await api('/missions/' + id + '/messages', { method: 'POST', body: { type: 'text', content: v } }); }
    catch (e) { toast(e.message, 'err'); ta.value = v; }
  },
  chatPhoto(id) {
    const input = document.getElementById('file-input');
    input.onchange = async () => {
      if (!input.files.length) return;
      const fd = new FormData(); fd.append('files', input.files[0]);
      toast('Envoi de la photo…');
      try {
        const r = await api('/upload', { method: 'POST', body: fd });
        await api('/missions/' + id + '/messages', { method: 'POST', body: { type: 'photo', file: r.files[0] } });
      } catch (e) { toast(e.message, 'err'); }
      input.value = '';
    };
    input.click();
  },
  async chatAudio(id) {
    const btn = document.getElementById('chat-rec');
    if (A._rec && A._rec.state === 'recording') { A._rec.stop(); btn.classList.remove('rec'); btn.textContent = '🎤'; return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      A._recChunks = [];
      A._rec = new MediaRecorder(stream);
      A._rec.ondataavailable = e => A._recChunks.push(e.data);
      A._rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(A._recChunks, { type: A._rec.mimeType || 'audio/webm' });
        const fd = new FormData(); fd.append('files', blob, 'vocal.webm');
        try {
          const r = await api('/upload', { method: 'POST', body: fd });
          await api('/missions/' + id + '/messages', { method: 'POST', body: { type: 'audio', file: r.files[0] } });
        } catch (e) { toast(e.message, 'err'); }
      };
      A._rec.start();
      btn.classList.add('rec'); btn.textContent = '⏹️';
      toast('Enregistrement… touchez ⏹️ pour envoyer.');
    } catch { toast('Microphone non autorisé.', 'err'); }
  },

  /* Notifications */
  async openNotif(id, link) {
    try { await api('/notifications/read', { method: 'POST', body: { id } }); refreshBadges(); } catch { }
    if (link && link.startsWith('#/')) nav(link); else render();
  },
  async readAll() {
    try { await api('/notifications/read', { method: 'POST', body: {} }); refreshBadges(); render(); } catch (e) { toast(e.message, 'err'); }
  },

  /* Pro */
  async toggleAvail(v) {
    try { await api('/pro/availability', { method: 'PUT', body: { available: !!v } }); toast(v ? 'Vous êtes maintenant disponible 🟢' : 'Vous êtes indisponible ⚪', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  },

  /* Avis de recherche / jobs */
  avisForm() {
    REQ = { photos: [] };
    openModal(`<h3>📢 Publier un avis de recherche</h3>
      <div class="field"><label>Nom de la personne <span class="req">*</span></label><input type="text" id="av-nom"></div>
      <div class="field"><label>Photo</label><div class="photo-strip" id="av-photo"><button class="ph-add" onclick="A.pickPhotos('av-photo')">＋</button></div>
      <input type="file" id="file-input" accept="image/*" style="display:none"></div>
      <div class="field"><label>Date de disparition</label><input type="date" id="av-date"></div>
      <div class="field"><label>Heure de disparition</label><input type="text" id="av-heure" placeholder="Ex : vers 18h"></div>
      <div class="field"><label>Dernier lieu connu</label><input type="text" id="av-lieu"></div>
      <div class="field"><label>Vu(e) pour la dernière fois</label><input type="text" id="av-vue" placeholder="Date/heure et circonstances"></div>
      <div class="field"><label>Description physique</label><textarea id="av-phys"></textarea></div>
      <div class="field"><label>Vêtements portés</label><input type="text" id="av-vet"></div>
      <div class="field"><label>Contact <span class="req">*</span></label><input type="tel" id="av-contact" value="${esc(USER.phone)}"></div>
      <div class="field"><label>Informations supplémentaires</label><textarea id="av-infos"></textarea></div>
      <div class="muted small mb">L'avis sera publié après validation par l'administration.</div>
      <button class="btn" onclick="A._sendAvis(this)">Publier</button>`);
  },
  async _sendAvis(btn) {
    busy(btn, true);
    try {
      await api('/avis-recherche', {
        method: 'POST', body: {
          nom: document.getElementById('av-nom').value, photo: REQ.photos[0] || null,
          date_disparition: document.getElementById('av-date').value, heure_disparition: document.getElementById('av-heure').value,
          dernier_lieu: document.getElementById('av-lieu').value, derniere_vue: document.getElementById('av-vue').value,
          description_physique: document.getElementById('av-phys').value, vetements: document.getElementById('av-vet').value,
          contact: document.getElementById('av-contact').value, infos: document.getElementById('av-infos').value
        }
      });
      closeModal(); toast('Avis envoyé pour validation ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  jobSearch() { sessionStorage.setItem('ks_jobq', document.getElementById('job-q').value); render(); },
  jobForm() {
    REQ = { photos: [] };
    openModal(`<h3>💼 Publier mon profil</h3>
      <div class="field"><label>Métier recherché <span class="req">*</span></label><input type="text" id="jb-metier" placeholder="Ex : Chauffeur, Ménagère…"></div>
      <div class="field"><label>Compétences</label><input type="text" id="jb-comp"></div>
      <div class="field"><label>Expérience</label><input type="text" id="jb-exp"></div>
      <div class="field"><label>Localisation</label><input type="text" id="jb-loc" value="${esc(USER.address || '')}"></div>
      <div class="field"><label>Disponibilité</label><input type="text" id="jb-dispo" placeholder="Ex : Immédiate"></div>
      <div class="field"><label>Contact <span class="req">*</span></label><input type="tel" id="jb-contact" value="${esc(USER.phone)}"></div>
      <div class="field"><label>CV ou photo</label><div class="photo-strip" id="jb-cv"><button class="ph-add" onclick="A.pickPhotos('jb-cv')">＋</button></div>
      <input type="file" id="file-input" accept="image/*,.pdf" style="display:none"></div>
      <div class="field"><label>Description</label><textarea id="jb-desc"></textarea></div>
      <div class="muted small mb">Le profil sera visible après validation par l'administration.</div>
      <button class="btn" onclick="A._sendJob(this)">Publier</button>`);
  },
  async _sendJob(btn) {
    busy(btn, true);
    try {
      await api('/jobs', {
        method: 'POST', body: {
          metier: document.getElementById('jb-metier').value, competences: document.getElementById('jb-comp').value,
          experience: document.getElementById('jb-exp').value, localisation: document.getElementById('jb-loc').value,
          disponibilite: document.getElementById('jb-dispo').value, contact: document.getElementById('jb-contact').value,
          cv: REQ.photos[0] || null, description: document.getElementById('jb-desc').value
        }
      });
      closeModal(); toast('Profil envoyé pour validation ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },

  /* Urgence */
  sosConfirm() {
    openModal(`<h3>🚨 Confirmer l'alerte</h3>
      <p class="small">Voulez-vous vraiment envoyer une alerte d'urgence à l'équipe Klean-Services CI ?</p>
      <div class="field"><input type="text" id="sos-msg" placeholder="Précisez la situation (facultatif)"></div>
      <div class="btn-row"><button class="btn sec" onclick="closeModal()">Annuler</button>
      <button class="btn warn" onclick="A._doSOS(this)">🚨 OUI, ENVOYER</button></div>`);
  },
  _doSOS(btn) {
    busy(btn, true);
    const send = (lat, lng) => api('/urgence', { method: 'POST', body: { message: document.getElementById('sos-msg').value, lat, lng } })
      .then(() => { closeModal(); toast('🚨 Alerte envoyée ! L\u2019équipe a été prévenue.', 'ok'); })
      .catch(e => { closeModal(); toast(e.message, 'err'); });
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(p => send(p.coords.latitude, p.coords.longitude), () => send(null, null), { timeout: 5000 });
    else send(null, null);
  },
  delAddr(id) { api('/addresses/' + id, { method: 'DELETE' }).then(() => { toast('Adresse supprimée.', 'ok'); render(); }).catch(e => toast(e.message, 'err')); },
  quizPick(el, qid, j) { A.pickChip(el, String(j)); window._quizAnswers[qid] = j; },
};
window.A = A; window.nav = nav; window.back = back; window.render = render; window.closeModal = closeModal; window.logout = logout; window.REQ = REQ;

/* ============================================================
   ROUTEUR
   ============================================================ */
// Changement de mot de passe OBLIGATOIRE (après réinitialisation d'accès ou création rapide par l'administration)
function forcePasswordModal() {
  openModal(`<h3>🔒 Nouveau mot de passe requis</h3>
    <p class="small muted">Pour votre sécurité, choisissez maintenant votre nouveau mot de passe personnel.</p>
    ${pwField('fp-cur', 'Mot de passe actuel (temporaire)')}
    ${pwField('fp-new', 'Nouveau mot de passe (6 caractères minimum)')}
    ${pwField('fp-new2', 'Confirmez le nouveau mot de passe')}
    <button class="btn" onclick="A.forcePwdSave()">Enregistrer mon nouveau mot de passe</button>
    <button class="btn ghost" onclick="logout()">Se déconnecter</button>`);
  const bg = document.getElementById('modal');
  if (bg) bg.onclick = null; // fenêtre non refermable : le changement est obligatoire
}

/* ---------- Champ mot de passe avec œil 👁 (masqué par défaut) ---------- */
function pwField(id, label, ph) {
  return `<div class="field"><label>${label}</label>
    <div style="position:relative">
      <input type="password" id="${id}" style="width:100%;padding-right:48px" ${ph ? `placeholder="${ph}"` : ''}>
      <button type="button" onclick="A.eye('${id}',this)" aria-label="Afficher / masquer le mot de passe"
        style="position:absolute;right:2px;top:50%;transform:translateY(-50%);background:none;border:none;font-size:19px;padding:8px 10px;cursor:pointer">👁️</button>
    </div></div>`;
}

/* ---------- Taille du texte (14–26 px, proportionnelle) ---------- */
const FONT_SIZES = [14, 16, 18, 20, 22, 24, 26];
function applyFont(px) {
  px = parseInt(px, 10);
  if (!FONT_SIZES.includes(px)) px = 16;
  document.body.style.zoom = px === 16 ? '' : String(px / 16);
  localStorage.setItem('ks_font', px);
  return px;
}

async function checkMaintenance() {
  try { MAINT = await api('/maintenance'); } catch { }
  return MAINT;
}
function maintenanceScreen() {
  $app.innerHTML = `<div class="content" style="display:flex;flex-direction:column;justify-content:center;min-height:80vh;text-align:center">
    <div style="font-size:64px">🛠️</div>
    <h2 style="margin:12px 0 8px">Maintenance en cours</h2>
    <p class="muted">${esc(MAINT.message || 'Klean-Services est temporairement en maintenance. Nous revenons très vite. Merci de votre patience.')}</p>
    ${MAINT.until ? `<p class="small muted">Retour prévu : ${esc(MAINT.until.replace('T', ' à '))}</p>` : ''}
    <button class="btn mt" onclick="A.maintRetry()">Réessayer</button>
  </div>`;
}

function render() {
  currentChat = null;
  const h = (location.hash || '#/home').slice(2);
  const [route, ...rest] = h.split('/');
  const param = rest.join('/');
  if (MAINT.active && MAINT.scope === 'F' && (!USER || USER.role !== 'pdg')) { maintenanceScreen(); return; }
  if (!TOKEN && !['login', 'register'].includes(route)) { location.hash = '#/login'; return; }
  if (USER && USER.must_change_password) { setTimeout(forcePasswordModal, 50); }
  const fn = routes[route] || routes.home;
  Promise.resolve(fn(param)).catch(e => {
    $app.innerHTML = header('Erreur') + `<div class="content">${emptyState('⚠️', e.message || 'Une erreur est survenue.')}<button class="btn" onclick="render()">Réessayer</button></div>` + bottomNav('home');
  });
  window.scrollTo(0, 0);
}

/* ---------- Démarrage ---------- */
(async function init() {
  if ('serviceWorker' in navigator) { try { navigator.serviceWorker.register('/sw.js'); } catch { } }
  applyFont(localStorage.getItem('ks_font') || 16);
  await checkMaintenance();
  setInterval(async () => { const was = MAINT.active; await checkMaintenance(); if (was !== MAINT.active) render(); }, 60000);
  if (TOKEN) {
    try {
      USER = await api('/me');
      if (USER.font_size) applyFont(USER.font_size);
      connectSSE(); refreshBadges();
    } catch { TOKEN = null; localStorage.removeItem('ks_token'); }
  }
  if (!location.hash) location.hash = TOKEN ? '#/home' : '#/login';
  navStack = [location.hash];
  render();
})();
