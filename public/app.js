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
let GRAND_CATEGORIES = [];   // domaines professionnels centraux
let PRO_SKILLS = [];         // arbre central catégorie → sous-catégorie des compétences pro
let GAMES = { quiz: false, flipfizz: false, kdo: false };
let MAINT = { active: false }; // état de maintenance de la plateforme
let ADS = [];
let navStack = [];
let suppressPush = false;
let sse = null;
let currentChat = null;     // mission id du chat ouvert
let currentSupport = null;  // conversation directe avec Klean Services
// Un lien d’invitation est conservé seulement jusqu’à l’inscription. Son ouverture est mesurée séparément d’un partage externe.
const incomingReferral = (() => { try { return new URLSearchParams(location.search).get('ref') || ''; } catch { return ''; } })();
if (/^[A-Za-z0-9_-]{12,100}$/.test(incomingReferral)) {
  localStorage.setItem('ks_referral_token', incomingReferral);
  fetch('/api/share/open/' + encodeURIComponent(incomingReferral), { method: 'POST' }).catch(() => {});
  try { const u = new URL(location.href); u.searchParams.delete('ref'); history.replaceState({}, '', u.pathname + u.search + u.hash); } catch {}
}
let lastActivitySignal = 0;
function signalRealActivity(state = 'active') {
  if (!TOKEN) return;
  const now = Date.now();
  if (state === 'active' && now - lastActivitySignal < 60000) return;
  if (state === 'active') lastActivitySignal = now;
  const body = JSON.stringify({ state });
  // API dédiée : aucune navigation ou actualisation automatique n’est comptée comme activité.
  fetch('/api/activity', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN }, body, keepalive: true }).catch(() => {});
}
['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, () => signalRealActivity('active'), { passive: true }));
document.addEventListener('visibilitychange', () => signalRealActivity(document.hidden ? 'background' : 'active'));
window.addEventListener('focus', () => signalRealActivity('active'));

/* ---------- Utilitaires ---------- */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function normalize(s) { return String(s || '').toLocaleLowerCase('fr').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
// Les fichiers privés sont demandés avec la session courante : une URL /uploads connue seule ne suffit pas.
function mediaUrl(src) {
  const s = String(src || '');
  if (!s || !s.startsWith('/uploads/') || !TOKEN) return s;
  return s + (s.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
}
function anonymousAdViewerKey() {
  let key=localStorage.getItem('ks_ad_viewer');
  if(!/^[a-z0-9_-]{18,120}$/i.test(key||'')) { key=(crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)).replace(/[^a-z0-9_-]/gi,''); localStorage.setItem('ks_ad_viewer',key); }
  return key;
}
function recordAdViews(items) {
  const keys=[...new Set((items||[]).map(a=>String(a.analytics_key||((a.sponsor?'campaign:':'ad:')+String(a.id||'').replace(/^c/,'')))).filter(k=>/^(ad|campaign):\d+$/.test(k)))];
  if(keys.length) api('/ad-views',{method:'POST',body:{keys,anonymous_key:anonymousAdViewerKey()}}).catch(()=>{});
}
function fmtDate(s) { if (!s) return ''; const d = new Date(s.replace(' ', 'T') + (s.includes('Z') || s.includes('+') ? '' : 'Z')); return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function fmtFCFA(n) { return (n ?? 0).toLocaleString('fr-FR') + ' FCFA'; }
// Nom compact pour les cartes et en-têtes étroits ; le nom complet reste en base, dans la recherche et l’administration.
function grandLabel(category) { return String(category && (category.short_label || category.name) || 'Service'); }
function initials(name) { return (name || '?').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase(); }
function avatar(u, cls) { return `<div class="avatar ${cls || ''}">${u && u.photo ? `<img src="${esc(mediaUrl(u.photo))}" alt="">` : esc(initials(u && u.name))}</div>`; }
// iPhone Safari and Android do not necessarily record in the same container.
// Prefer a format the browser explicitly supports instead of forcing WebM.
function audioRecorderOptions() {
  if (!window.MediaRecorder) return null;
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  const mimeType = types.find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  return mimeType ? { mimeType } : {};
}
function audioExtension(mime) { return /mp4|aac|m4a/i.test(mime || '') ? 'm4a' : 'webm'; }
function microphoneError(err) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder)
    return 'Votre navigateur ne prend pas encore en charge l’enregistrement vocal. Utilisez Safari à jour ou un navigateur récent.';
  if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError'))
    return 'Microphone non autorisé. Sur iPhone, autorisez le microphone pour Klean Services dans Réglages/Safari, puis réessayez.';
  if (err && err.name === 'NotFoundError') return 'Aucun microphone n’a été détecté sur cet appareil.';
  return 'Impossible de démarrer le microphone. Vérifiez son autorisation puis réessayez.';
}

function toast(msg, cls, title) {
  const z = document.getElementById('toast-zone');
  const t = document.createElement('div');
  t.className = 'toast ' + (cls || '');
  t.innerHTML = (title ? `<div class="t-title">${esc(title)}</div>` : '') + esc(msg);
  t.onclick = () => t.remove();
  z.appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

let pendingWriteOperations = 0;
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData) && opts.body) headers['Content-Type'] = 'application/json';
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  const writing = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(opts.method || 'GET').toUpperCase());
  if (writing) pendingWriteOperations++;
  try {
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
      const err = new Error(data.error || 'Une erreur est survenue. Veuillez réessayer.');
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  } finally { if (writing) pendingWriteOperations = Math.max(0, pendingWriteOperations - 1); }
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.l = btn.textContent; btn.disabled = true; btn.textContent = label || 'Veuillez patienter…'; }
  else { btn.disabled = false; btn.textContent = btn.dataset.l || btn.textContent; }
}

/* ---------- Son + vibration de notification ---------- */
function notifFeedback(isMission, soundAllowed = true) {
  if (soundAllowed && localStorage.getItem('ks_sound') !== '0') {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      // Deux notes brèves rendent l'alerte mission reconnaissable au premier plan.
      o.frequency.setValueAtTime(isMission ? 740 : 880, ctx.currentTime);
      if (isMission) o.frequency.setValueAtTime(988, ctx.currentTime + .18);
      g.gain.setValueAtTime(.13, ctx.currentTime); g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + (isMission ? .62 : .4));
      o.start(); o.stop(ctx.currentTime + (isMission ? .62 : .4));
      setTimeout(() => ctx.close(), 850);
    } catch { }
  }
  if (soundAllowed && navigator.vibrate) try { navigator.vibrate(isMission ? [120, 55, 120, 55, 180] : [120, 60, 120]); } catch { }
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
    notifFeedback(n.category === 'mission', n.sound !== false);
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
  sse.addEventListener('support', e => {
    const d = JSON.parse(e.data);
    if (currentSupport === Number(d.conversation_id)) appendSupportMsg(d.message);
    else refreshBadges();
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

/* ---------- Navigation centralisée, historique et protection des brouillons ---------- */
let navCursor = 0;
let currentHash = '';
let allowNavigationOnce = false;
let pendingHistoryMove = 0;
let restoringBrowserNavigation = false;
let browserNavigationToConfirm = null;
let leavePromptOpen = false;
let draftGuard = { enabled: false, dirty: false, modalDirty: false, submitting: false, scope: '' };

function normalHash(hash) {
  const h = String(hash || '');
  return h && h.startsWith('#/') ? h : '#/home';
}
function currentRoute() { return (currentHash || normalHash(location.hash)).slice(2).split('/')[0]; }
function hasNavigationHistory() { return navCursor > 0; }
function resetDraftGuard() { draftGuard = { enabled: false, dirty: false, modalDirty: false, submitting: false, scope: '' }; }
function isDraftControl(el) {
  if (!el || !el.matches || !el.matches('input, textarea, select')) return false;
  if (el.disabled || el.type === 'hidden' || el.type === 'button' || el.type === 'submit' || el.dataset.navIgnore !== undefined) return false;
  if (el.id === 'gs-q' || el.id === 'home-q' || el.id === 's-q' || el.id === 'cat-q' || el.id === 'job-q' || el.id === 'avis-q' || el.id === 'ville-q') return false;
  return true;
}
function armDraftProtection(root, scope, reset) {
  if (reset) resetDraftGuard();
  const zone = root || document.getElementById('app');
  if (!zone) return;
  const controls = zone.querySelectorAll('input, textarea, select');
  if (!controls.length) return;
  draftGuard.enabled = true; draftGuard.scope = scope || draftGuard.scope || 'formulaire';
  controls.forEach(el => {
    if (!isDraftControl(el) || el.dataset.ksDraftBound) return;
    el.dataset.ksDraftBound = '1';
    const changed = () => { draftGuard.dirty = true; if (el.closest('#modal')) draftGuard.modalDirty = true; };
    el.addEventListener('input', changed, { passive: true });
    el.addEventListener('change', changed, { passive: true });
  });
}
function pageNeedsDraftProtection(route) {
  return ['register', 'request', 'categories', 'infos', 'addresses', 'security', 'settings', 'pro'].includes(route);
}
function forceCloseModal() {
  if (window._supportPoll) { clearInterval(window._supportPoll); window._supportPoll = null; }
  const m = document.getElementById('modal'); if (m) m.remove();
  draftGuard.modalDirty = false;
}
function closeLeavePrompt() { const p = document.getElementById('leave-confirm'); if (p) p.remove(); leavePromptOpen = false; }
function showLeaveConfirm(onLeave) {
  if (leavePromptOpen) return;
  leavePromptOpen = true;
  const bg = document.createElement('div');
  bg.className = 'modal-bg'; bg.id = 'leave-confirm';
  bg.style.zIndex = '2000';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="leave-confirm-title">
    <h3 id="leave-confirm-title">Modifications non enregistrées</h3>
    <p class="small">Vous avez des modifications non enregistrées. Voulez-vous quitter cette page ?</p>
    <div class="btn-row"><button class="btn sec" id="leave-stay">Continuer la modification</button><button class="btn warn" id="leave-drop">Quitter sans enregistrer</button></div>
  </div>`;
  document.body.appendChild(bg);
  document.getElementById('leave-stay').onclick = closeLeavePrompt;
  document.getElementById('leave-drop').onclick = () => { closeLeavePrompt(); resetDraftGuard(); onLeave(); };
}
function withLeaveProtection(action) {
  if (pendingWriteOperations > 0 || draftGuard.submitting) { toast('Envoi en cours : veuillez patienter avant de revenir.', 'err'); return; }
  if (draftGuard.enabled && draftGuard.dirty) { showLeaveConfirm(action); return; }
  action();
}
function fallbackHash(hash) {
  const route = String(hash || '').slice(2).split('/')[0];
  if (['request', 'services', 'search'].includes(route)) return '#/services';
  if (['mission'].includes(route)) return '#/missions';
  if (['chat', 'contact', 'messages', 'notifications'].includes(route)) return '#/messages';
  if (['infos', 'addresses', 'security', 'settings', 'pro', 'pros', 'visibilite', 'pub', 'payments'].includes(route)) return '#/account';
  if (['jobs', 'avis-recherche', 'urgence', 'about', 'quiz', 'flip', 'kdo'].includes(route)) return '#/home';
  return '';
}
function nav(hash) {
  const target = normalHash(hash);
  if (target === (currentHash || normalHash(location.hash))) return;
  withLeaveProtection(() => { allowNavigationOnce = true; forceCloseModal(); location.hash = target; });
}
function back() {
  // Un formulaire présenté dans une fenêtre est refermé avant de changer de page.
  const modal = document.getElementById('modal');
  if (modal) {
    if (draftGuard.modalDirty) showLeaveConfirm(() => forceCloseModal());
    else forceCloseModal();
    return;
  }
  withLeaveProtection(() => {
    if (navCursor > 0) { allowNavigationOnce = true; pendingHistoryMove = -1; history.back(); return; }
    const fallback = fallbackHash(currentHash || location.hash);
    if (fallback && fallback !== (currentHash || location.hash)) { allowNavigationOnce = true; location.hash = fallback; }
    else toast('Vous êtes déjà sur le premier écran de cette navigation.', 'ok');
  });
}
window.back = back;


// Consultation ouverte : seules les opérations qui écrivent, contactent ou affichent des données privées demandent une session.
function authRequired(returnHash, message) {
  const target = returnHash || currentHash || '#/account';
  sessionStorage.setItem('ks_return_after_auth', target);
  openModal(`<h3>🔐 Compte requis</h3><p class="small">${esc(message || 'Pour effectuer cette action, veuillez créer un compte ou vous connecter.')}</p>
    <div class="btn-row"><button class="btn sec" onclick="closeModal();nav('#/login')">Se connecter</button><button class="btn" onclick="closeModal();nav('#/register')">Créer un compte</button></div>`);
}
function resumeAfterAuth(fallback) {
  const target = sessionStorage.getItem('ks_return_after_auth');
  sessionStorage.removeItem('ks_return_after_auth');
  nav(target && target.startsWith('#/') ? target : (fallback || '#/home'));
}
function guestAccount() {
  $app.innerHTML = `${header('Compte', { back: 'contextual', bell: false })}<div class="content"><div class="card center">
    <div style="font-size:42px">👤</div><h2 style="margin:8px 0">Bienvenue sur Klean Services</h2>
    <p class="muted small">Vous pouvez découvrir librement les services et contenus publics. Créez un compte seulement lorsque vous souhaitez envoyer une demande, publier ou accéder à votre espace personnel.</p>
    <button class="btn" onclick="sessionStorage.setItem('ks_return_after_auth','#/account');nav('#/register')">Créer un compte</button>
    <button class="btn sec mt" onclick="sessionStorage.setItem('ks_return_after_auth','#/account');nav('#/login')">Se connecter</button>
  </div></div>${bottomNav('account')}`;
}
function publicAuthGate() {
  $app.innerHTML = `${header('Accès au compte', { bell: false })}<div class="content"><div class="card center"><div style="font-size:38px">🔐</div><p>Pour effectuer cette action, veuillez créer un compte ou vous connecter.</p><button class="btn" onclick="nav('#/register')">Créer un compte</button><button class="btn sec mt" onclick="nav('#/login')">Se connecter</button></div></div>${bottomNav('account')}`;
}

// Installation PWA : le navigateur conserve la décision finale. Aucun succès n’est annoncé avant l’événement système appinstalled.
let deferredInstallPrompt = null;
function isInstalledApp() { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; }
function isAppleMobile() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function installCtaMount() {
  const old=document.getElementById('install-cta'); if(old)old.remove();
  if (isInstalledApp()) return;
  const c=document.createElement('button'); c.id='install-cta'; c.className='install-cta'; c.type='button'; c.innerHTML='<span aria-hidden="true">⇩</span><b>Installer l’application</b>';
  c.setAttribute('aria-label','Installer l’application Klean Services'); c.onclick=installApp; document.body.appendChild(c);
}
async function installApp() {
  if (isInstalledApp()) { const c=document.getElementById('install-cta'); if(c)c.remove(); return; }
  if (deferredInstallPrompt) {
    const prompt=deferredInstallPrompt;
    try { await prompt.prompt(); const result=await prompt.userChoice; if(result && result.outcome==='accepted') { const c=document.getElementById('install-cta'); if(c){c.disabled=true;c.innerHTML='<span aria-hidden="true">…</span><b>Installation en cours…</b>';} setTimeout(()=>installCtaMount(),5000); } else toast('Installation annulée. Vous pourrez réessayer quand vous le souhaitez.','ok'); }
    catch { toast('L’installation n’a pas pu être lancée. Vous pourrez réessayer.','err'); }
    return;
  }
  const instructions=isAppleMobile()
    ? 'Sur iPhone ou iPad, ouvrez ce site dans Safari, touchez le bouton Partager puis choisissez « Sur l’écran d’accueil ».'
    : 'Votre navigateur ne propose pas l’installation directe. Ouvrez son menu puis choisissez « Installer l’application » ou « Ajouter à l’écran d’accueil ».';
  openModal(`<h3>📲 Installer Klean Services</h3><p class="small">${instructions}</p><button class="btn sec" onclick="closeModal()">Compris</button>`);
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstallPrompt=e; if((location.hash||'#/home')==='#/home') installCtaMount(); });
window.addEventListener('appinstalled', () => { deferredInstallPrompt=null; const c=document.getElementById('install-cta'); if(c)c.remove(); toast('Klean Services a été installée sur cet appareil.','ok'); });
function commitHash(hash) {
  const h = normalHash(hash);
  if (!currentHash) { navStack = [h]; navCursor = 0; currentHash = h; render(); return; }
  if (h === currentHash) return;
  if (pendingHistoryMove) {
    const expected = navCursor + pendingHistoryMove;
    if (navStack[expected] === h) navCursor = expected;
    else { const found = navStack.lastIndexOf(h); navCursor = found >= 0 ? found : Math.max(0, expected); }
    pendingHistoryMove = 0;
  } else if (navStack[navCursor - 1] === h) navCursor--;
  else if (navStack[navCursor + 1] === h) navCursor++;
  else {
    navStack = navStack.slice(0, navCursor + 1);
    navStack.push(h); navCursor = navStack.length - 1;
  }
  currentHash = h;
  resetDraftGuard();
  render();
}
window.addEventListener('hashchange', () => {
  const h = normalHash(location.hash);
  if (restoringBrowserNavigation && h === currentHash) {
    restoringBrowserNavigation = false;
    const pending = browserNavigationToConfirm; browserNavigationToConfirm = null;
    if (pending) showLeaveConfirm(() => { allowNavigationOnce = true; pendingHistoryMove = pending.delta; history.go(pending.delta); });
    return;
  }
  if (h === currentHash) return;
  // Les boutons natifs du navigateur/Android/iPhone arrivent ici après le changement d’historique.
  if (!allowNavigationOnce && draftGuard.enabled && draftGuard.dirty && !draftGuard.submitting) {
    let delta = navStack[navCursor - 1] === h ? -1 : (navStack[navCursor + 1] === h ? 1 : 0);
    if (delta) {
      browserNavigationToConfirm = { delta };
      restoringBrowserNavigation = true;
      history.go(-delta); // on restaure le formulaire, puis l’utilisateur décide.
      return;
    }
    // Cas rare (historique externe/non linéaire) : on reste dans l’application et on demande confirmation.
    const target = h;
    allowNavigationOnce = true;
    location.hash = currentHash;
    showLeaveConfirm(() => nav(target));
    return;
  }
  allowNavigationOnce = false;
  commitHash(h);
});

/* Balayage horizontal vers la droite : réservé au bord gauche et ignoré sur les zones interactives.
   Sur iPhone, le geste système est laissé prioritaire ; son retour navigateur arrive via hashchange. */
let touchX = null, touchY = null, touchAt = 0, touchBlocked = false;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function gestureBlocked(target) {
  return !!(target && target.closest && target.closest('input,textarea,select,button,a,.photo-strip,.choices,.tabs,.searchbar,[data-horizontal-scroll],video,audio'));
}
document.addEventListener('touchstart', e => {
  if (e.touches.length !== 1) return;
  const t=e.touches[0]; touchX=t.clientX; touchY=t.clientY; touchAt=Date.now(); touchBlocked=gestureBlocked(e.target);
}, { passive:true });
document.addEventListener('touchcancel', () => { touchX=null; touchBlocked=false; }, { passive:true });
document.addEventListener('touchend', e => {
  if (touchX === null) return;
  const t=e.changedTouches[0], dx=t.clientX-touchX, dy=t.clientY-touchY, started=touchX, elapsed=Date.now()-touchAt;
  touchX=null;
  if (isIOS || touchBlocked || started>44 || elapsed>900 || dx<78 || Math.abs(dy)>Math.min(56, dx*.45)) return;
  back();
}, { passive:true });

function logout(manual = true) {
  TOKEN = null; USER = null; localStorage.removeItem('ks_token');
  if (sse) { sse.close(); sse = null; }
  if (manual) toast('Vous êtes déconnecté.', 'ok');
  nav('#/login'); render();
}

/* ---------- Gabarits ---------- */
function header(title, opts = {}) {
  const showBack = opts.back === 'contextual' ? hasNavigationHistory() : opts.back !== false;
  return `<div class="hdr">
    ${showBack ? `<button type="button" class="back-btn" onclick="back()" aria-label="Retour à l’écran précédent">←<span>Retour</span></button>` : ''}
    ${opts.brand ? `<div class="brand" aria-label="Klean Services"><img src="/logo.png" alt=""> <span>Klean Services</span></div>` : `<div class="title">${esc(title)}</div>`}
    ${opts.bell !== false ? `<button type="button" class="bell" onclick="nav('#/notifications')" aria-label="Voir les notifications">🔔<span class="js-bell-badge"></span></button>` : ''}
  </div>`;
}
function bottomNav(active) {
  const items = [
    ['home', '🏠', 'Accueil'], ['search', '🔍', 'Rechercher'], ['missions', '📋', 'Demandes'],
    ['messages', '💬', 'Messages'], ['account', '👤', 'Compte']
  ];
  return `<div class="bottomnav">` + items.map(([id, ic, lb]) =>
    `<button type="button" class="${active === id ? 'on' : ''}" aria-label="${lb}" onclick="nav('#/${id}')"><span class="ni" aria-hidden="true">${ic}</span><span>${lb}</span>${id === 'messages' ? '<span class="js-msg-badge"></span>' : ''}</button>`
  ).join('') + `</div>`;
}
function emptyState(ic, msg) { return `<div class="empty"><div class="e-ic">${ic}</div>${esc(msg)}</div>`; }
function statusPill(s) {
  const L = { recherche: '🔎 Recherche en cours', sans_pro: 'Sans professionnel', acceptee: 'Acceptée', confirmee: 'Programmée', demarrage_demande: 'Démarrage à confirmer', en_cours: 'En cours', fin_demande: 'Fin à confirmer', terminee: 'Terminée', payee: 'Payée', annulee: 'Annulée', litige: 'Litige' };
  return `<span class="pill ${s}">${L[s] || s}</span>`;
}

function openModal(html) {
  forceCloseModal();
  const bg = document.createElement('div');
  bg.className = 'modal-bg'; bg.id = 'modal';
  bg.innerHTML = `<div class="modal">${html}</div>`;
  bg.onclick = e => { if (e.target === bg) attemptCloseModal(); };
  document.body.appendChild(bg);
  armDraftProtection(bg, 'fenêtre', false);
}
function attemptCloseModal() { if (draftGuard.modalDirty) showLeaveConfirm(() => forceCloseModal()); else forceCloseModal(); }
function closeModal() { forceCloseModal(); }

/* ============================================================
   ÉCRANS
   ============================================================ */
const routes = {};

/* ---------- Connexion / Inscription ---------- */
routes.login = () => {
  $app.innerHTML = `
  <div class="content no-nav" style="padding-top:52px">
    <div class="center mb"><img class="splash-logo splash-image" src="/logo.png" alt="Logo Klean Services" style="margin:0 auto">
      <h2 style="margin:14px 0 2px">Klean Services</h2>
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
      resumeAfterAuth(['pdg', 'admin', 'gestionnaire', 'agent'].includes(USER.role) ? '#/account' : '#/home');
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
        <input type="text" id="f-ville" placeholder="👆 Choisir ma ville" readonly style="cursor:pointer;background:#fff" onclick="A.villePick('f-ville')">
      </div>
      <div class="field"><label>Quartier</label><input type="text" id="f-quartier" placeholder="Ex : Air France, Cocody Angré…"></div>
      <div class="sec-title">Règles d'utilisation</div>
      <div class="rules-box">${esc(rules.client || '')}</div>
      <label class="check-line"><input type="checkbox" id="f-accept"> J'ai lu et j'accepte les règles d'utilisation de Klean Services.</label>
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
          accept_rules: document.getElementById('f-accept').checked,
          referral_token: localStorage.getItem('ks_referral_token') || undefined
        }
      });
      TOKEN = r.token; USER = r.user; localStorage.setItem('ks_token', TOKEN); localStorage.removeItem('ks_referral_token');
      connectSSE(); refreshBadges(); signalRealActivity('active');
      toast('Bienvenue sur Klean Services !', 'ok');
      resumeAfterAuth('#/home');
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

/* COLIS 20 : les prix de catalogue ne quittent pas la gestion tarifaire PDG. */
function prixHtml() { return ''; }

/* Choix des services d'un professionnel : mêmes catégories et services que
   partout ailleurs. Un professionnel peut sélectionner plusieurs catégories. */
function proDomainChips(selectedIds) {
  const selected = new Set((selectedIds || []).map(Number));
  return GRAND_CATEGORIES.filter(c => c.active !== 0).map(c => `
    <label class="check-line" style="align-items:flex-start;margin:0 0 9px;padding:10px;border:1px solid #e4ecea;border-radius:10px">
      <input class="domain-chip" type="checkbox" value="${c.id}" ${selected.has(Number(c.id)) ? 'checked' : ''}>
      <span><b>${esc(c.icon || '🧩')} ${esc(c.name)}</b>${c.description ? `<span class="muted small" style="display:block;margin-top:2px">${esc(c.description)}</span>` : ''}</span>
    </label>`).join('');
}
// Sélecteur hiérarchique : le professionnel ouvre une grande catégorie, puis coche
// uniquement les sous-catégories réellement maîtrisées. Les ids, pas les noms, sont enregistrés.
function proSkillPicker(selectedIds) {
  const selected=new Set((selectedIds||[]).map(Number));
  return (PRO_SKILLS||[]).map(root=>{const open=root.categories.some(c=>(c.subcategories||[]).some(sc=>selected.has(Number(sc.id))));return `<details class="pro-skill-root" ${open?'open':''}><summary><span>${esc(root.icon||'🧩')} <b>${esc(root.short_label||root.name)}</b></span><span class="muted small">Choisir mes sous-catégories</span></summary><div class="pro-skill-body">${root.categories.map(cat=>`<div class="pro-skill-category"><b>${esc(cat.icon||'🔹')} ${esc(cat.name)}</b><div class="pro-skill-options">${(cat.subcategories||[]).map(sub=>`<label class="check-line"><input class="pro-sub-skill" type="checkbox" value="${sub.id}" data-root="${root.id}" ${selected.has(Number(sub.id))?'checked':''}> ${esc(sub.name)}</label>`).join('')}</div></div>`).join('')}</div></details>`;}).join('') || '<div class="hint">Aucune sous-catégorie active n’est disponible pour le moment.</div>';
}
function selectedProSubcategories() { return [...document.querySelectorAll('.pro-sub-skill:checked')].map(c=>Number(c.value)).filter(Number.isInteger); }
/* Ancienne aide conservée pour les écrans historiques non encore concernés. */
function proServiceChips(selectedIds) {
  const sel = selectedIds || [];
  return SERVICES.filter(c => c.services.length).map((c, i) => `
    <div class="pro-service-category"><button type="button" class="pro-service-head" onclick="A.toggleProCategory(this)" aria-expanded="${i === 0 ? 'true' : 'false'}"><span>${esc(c.icon || '🔹')} ${esc(c.name)}</span><span>⌄</span></button>
      <div class="choices pro-cat-services ${i === 0 ? 'open' : ''}">${c.services.map(s => `<button type="button" class="chip ${sel.includes(s.id) ? 'on' : ''}" data-sid="${s.id}" onclick="this.classList.toggle('on')">${esc(s.name)}</button>`).join('')}</div></div>`).join('');
}

/* Carte publicité / info : la vidéo s'affiche en grand et démarre automatiquement (muette) */
function adCardHtml(a) {
  const media = a.file && a.type === 'video'
    ? `<video src="${esc(a.file)}" autoplay muted loop playsinline controls preload="metadata"
         style="display:block;width:100%;max-height:150px;border-radius:8px;margin-top:6px;background:#000;object-fit:contain"></video>`
    : a.file && a.type === 'image'
      ? `<img src="${esc(mediaUrl(a.file))}" alt="" style="display:block;width:100%;max-height:120px;border-radius:8px;margin-top:6px;object-fit:cover">`
      : '';
  return `<div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="ad-tag">${a.title && /urgen/i.test(a.title) ? '🚨 URGENT' : a.type === 'video' ? '📣 PUBLICITÉ' : 'ℹ️ INFORMATION'}</span>
        <span class="small muted">👁️ ${Number(a.views || 0).toLocaleString('fr-FR')}</span>
      </div>
      ${a.title ? `<div class="bold small">${esc(a.title)}</div>` : ''}
      ${a.content ? `<div class="small muted" style="white-space:normal">${esc(a.content)}</div>` : ''}
      ${media}</div>`;
}
/* Bande pub/info affichée en haut des écrans d'accueil et de services */
function adsBandHtml(list) {
  if (!list.length) return '';
  const aVideo = list.some(c => c.includes('<video'));
  return `<div style="display:flex;gap:8px;overflow-x:auto;padding:0 2px 6px;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch">
    ${list.map(c => `<div style="flex:0 0 ${list.length > 1 ? '84%' : '100%'};scroll-snap-align:start;background:#fff;border:1px solid #e8e8ef;border-radius:12px;padding:8px 10px;${aVideo ? '' : 'max-height:118px;overflow:hidden'}">${c}</div>`).join('')}
  </div>`;
}

/* ---------- Accueil ---------- */
routes.home = async () => {
  // Les prix et services populaires affichés viennent toujours de la configuration actuelle du tableau de bord.
  const cityQuery = USER && USER.ville ? '?ville=' + encodeURIComponent(USER.ville) : '';
  try { SERVICES = await api('/services' + cityQuery); POPULAIRES = await api('/grand-categories/populaires' + cityQuery); }
  catch (e) { $app.innerHTML = header('Accueil', { brand: true }) + `<div class="content">${emptyState('📶', e.message)}<button class="btn" onclick="render()">Réessayer</button></div>` + bottomNav('home'); return; }
  try { GAMES = await api('/games/config'); } catch { }
  try { ADS = await api('/ads'); } catch { }
  const homeAds = ADS; // toutes les publicités actives sortent sur l'écran d'accueil
  const topZone = [];
  if (MAINT.active && MAINT.scope !== 'F') topZone.push(`<div style="border-left:3px solid #e67e22;background:#fff8f0">
      <div class="bold small">🛠️ Maintenance partielle</div>
      <div class="small muted" style="white-space:normal">${esc(MAINT.message || 'Certaines fonctions sont temporairement suspendues.')}</div></div>`);
  homeAds.forEach(a => topZone.push(adCardHtml(a)));
  const gv = k => Number((GAMES.views && GAMES.views[k]) || 0).toLocaleString('fr-FR');
  if (GAMES.quiz) topZone.push(`<div onclick="nav('#/quiz')" style="cursor:pointer;text-align:center">
      <div style="display:flex;justify-content:space-between;align-items:center"><span class="ad-tag">🧠 QUIZ</span><span class="small muted">👁️ ${gv('quiz')}</span></div>
      <div class="bold small">🧠 Quiz — jouez maintenant !</div></div>`);
  if (GAMES.flipfizz) topZone.push(`<div onclick="nav('#/flip')" style="cursor:pointer;text-align:center">
      <div style="display:flex;justify-content:space-between;align-items:center"><span class="ad-tag">🎮 JEU</span><span class="small muted">👁️ ${gv('flipfizz')}</span></div>
      <div class="bold small">🎲 Flip Fizz</div></div>`);
  if (GAMES.kdo) topZone.push(`<div onclick="nav('#/kdo')" style="cursor:pointer;text-align:center">
      <div style="display:flex;justify-content:space-between;align-items:center"><span class="ad-tag">🎮 JEU</span><span class="small muted">👁️ ${gv('kdo')}</span></div>
      <div class="bold small">🎁 Kdo</div></div>`);
  $app.innerHTML = `
  ${header('', { brand: true, back: 'contextual', bell: !!USER })}
  <div class="content" style="padding-top:0">
    <div id="home-fixe" style="position:sticky;top:calc(58px + var(--safe-t));z-index:39;background:var(--bg,#f5f7f7);padding:8px 0 4px;margin:0 -2px">
      ${adsBandHtml(topZone)}
      <div class="searchbar" style="margin:0 2px">
        <input type="text" id="home-q" placeholder="🔎 Décrivez votre besoin…" enterkeyhint="search" autocomplete="off">
        <button onclick="A.goSearch()" aria-label="Rechercher">🔍</button>
      </div>
      <div id="home-search-results" class="live-search-results"></div>
    </div>
    <div id="quiz-live"></div>
    <div class="hint">Ex : « mon eau coule », « ma clime est gâtée », « je veux laver ma maison »…</div>
    ${POPULAIRES.length ? `<div class="sec-title">Services populaires</div>
    <div class="svc-grid">
      ${POPULAIRES.map(s => `<button type="button" class="svc-card ${s.image_url ? 'has-image' : ''}" onclick="nav('#/categories/${s.id}')" aria-label="Ouvrir ${esc(s.name)}"><span class="svc-card-media">${s.image_url ? `<img src="${esc(s.image_url)}" alt="" loading="lazy" onerror="this.parentElement.classList.add('image-missing')">` : `<span class="ic" aria-hidden="true">${esc(s.icon || '🧩')}</span>`}</span><span class="svc-card-copy"><span class="nm">${esc(grandLabel(s))}</span>${s.price_from ? `<span class="price-from">À partir de ${fmtFCFA(s.price_from)}</span>` : ''}</span></button>`).join('')}
    </div>` : ''}
    <button class="btn sec mt" onclick="nav('#/categories')">Voir tous les services</button>
    <div class="home-shortcuts" aria-label="Accès rapides">
      <button class="home-shortcut" onclick="nav('#/jobs')"><span>💼</span><div><b>Trouver ou proposer un job</b><small>Consulter les offres ou publier la vôtre</small></div><i>›</i></button>
      <button class="home-shortcut" onclick="nav('#/avis-recherche')"><span>📢</span><div><b>Avis de recherche</b><small>Publier ou consulter un avis</small></div><i>›</i></button>
      <button class="home-shortcut urgent" onclick="nav('#/urgence')"><span>🚨</span><div><b>Urgences</b><small>Contacts et assistance configurés</small></div><i>›</i></button>
    </div>
    <div id="bandeau-espace"></div>
  </div><div id="bandeau-host"></div>${bottomNav('home')}`;
  updateBadges();
  installCtaMount();
  quizLiveMount(); // le quiz actif s'affiche automatiquement, sans aucun clic
  bandeauMount();  // bandeau d'annonces défilantes en bas de l'accueil
  // Consultation publicitaire dédupliquée par jour ; les jeux gardent leur comptage historique connecté.
  recordAdViews(homeAds);
  const vues=[]; if (GAMES.quiz) vues.push('game:quiz'); if (GAMES.flipfizz) vues.push('game:flipfizz'); if (GAMES.kdo) vues.push('game:kdo');
  if (vues.length && USER) api('/vues', { method: 'POST', body: { keys: vues } }).catch(() => { });
  const q = document.getElementById('home-q');
  q.addEventListener('input', () => A.liveSearch('home-q', 'home-search-results', true));
  q.addEventListener('keydown', e => { if (e.key === 'Enter') A.goSearch(); });
};

/* ---------- Recherche ---------- */
routes.search = async (params) => {
  const q = decodeURIComponent(params || '');
  $app.innerHTML = `
  ${header('Rechercher', { bell: !!USER })}
  <div class="content">
    <div class="searchbar">
      <input type="text" id="s-q" placeholder="🔎 Que recherchez-vous ?" value="${esc(q)}" enterkeyhint="search">
      <button onclick="A.doSearch()">🔍</button>
    </div>
    <div id="s-results"><div class="hint">Décrivez simplement votre besoin : « réparer ma télévision », « un électricien », « je cherche un employé »…</div></div>
  </div>${bottomNav('search')}`;
  const inp = document.getElementById('s-q');
  inp.addEventListener('input', () => A.liveSearch('s-q', 's-results', false));
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') A.doSearch(); });
  if (q) A.doSearch(); else inp.focus();
  updateBadges();
};

/* ---------- Demande unifiée depuis une grande catégorie ---------- */
function categoryDraftKey(categoryId) { return 'ks_category_request_draft_' + Number(categoryId); }
function readCategoryDraft(categoryId) {
  let draft = {};
  try { draft = JSON.parse(sessionStorage.getItem(categoryDraftKey(categoryId)) || '{}'); } catch { draft = {}; }
  if (Number(draft.category_id) === Number(categoryId)) return draft;
  try { draft = JSON.parse(sessionStorage.getItem('ks_pending_request_draft') || '{}'); } catch { draft = {}; }
  return Number(draft.category_id) === Number(categoryId) ? draft : {};
}
function renderCategoryRequestForm(cat, serviceChoices) {
  const services = (serviceChoices || []).filter(s => Number(s.id));
  if (!services.length) {
    $app.innerHTML = `${header(grandLabel(cat), { bell: !!USER })}<div class="content">${emptyState('📋','Aucune prestation active n’est disponible dans cette catégorie pour le moment.')}</div>${bottomNav('search')}`;
    updateBadges(); return;
  }
  const allTasks = services.flatMap(s => (s.taches || []).map(t => ({ id:Number(t.id), name:t.name, description:t.description || '', search_terms:Array.isArray(t.search_terms) ? t.search_terms : [], price_from:Number(t.price_from) || null, price_unit:t.price_unit || '', service_id:Number(s.id), service_name:s.name, category:s.category || '' })));
  const savedDraft = readCategoryDraft(cat.id);
  const taskById = new Map(allTasks.map(t => [Number(t.id), t]));
  let selectedTasks = (savedDraft.taches || []).map(raw => {
    const task = taskById.get(Number(raw && (raw.id ?? raw)));
    return task ? { ...task, detail:String(raw && raw.detail || '').slice(0,500) || '' } : null;
  }).filter(Boolean);
  // Les missions historiques restent compatibles : une seule prestation porte la demande.
  if (selectedTasks.length) selectedTasks = selectedTasks.filter(t => t.service_id === selectedTasks[0].service_id);
  const savedServiceId = Number(savedDraft.service_id);
  const defaultService = selectedTasks[0] || services.find(s => Number(s.id) === savedServiceId) || services[0];
  REQ = {
    mode:'category', category_id:cat.id, category_name:cat.name, category_draft_key:categoryDraftKey(cat.id),
    category_services:services, category_tasks:allTasks, selected_tasks:selectedTasks,
    service_id:Number(defaultService.id), task_id:selectedTasks[0] ? selectedTasks[0].id : null,
    photos:savedDraft.photos || [], audio:savedDraft.audio || null,
    lat:savedDraft.lat ?? (USER && USER.lat), lng:savedDraft.lng ?? (USER && USER.lng),
    photo_limit:3, audio_max:25
  };
  const initialCity = savedDraft.intervention_city || (USER && USER.ville) || '';
  const initialCommune = savedDraft.intervention_commune || '';
  const initialQuartier = savedDraft.quartier || (USER && USER.quartier) || '';
  const initialAddress = savedDraft.address || (USER && USER.address) || '';
  $app.innerHTML = `${header(grandLabel(cat), { bell: !!USER })}
    <div class="content category-request-page">
      ${cat.description ? `<div class="category-request-intro">${esc(cat.description)}</div>` : ''}
      <div class="card category-request-card">
        <section class="request-section request-needs-section">
          <label class="request-label">Je choisis mon/mes besoins <span class="muted small">(facultatif)</span></label>
          <button type="button" class="need-picker" id="category-needs-btn" onclick="A.openCategoryNeeds()"><span class="need-picker-icon">☑</span><span class="grow"><b id="category-needs-title">Choisir des besoins</b><small id="category-needs-summary">Aucun besoin sélectionné</small></span><span class="need-picker-arrow">›</span></button>
        </section>
        <section class="request-section">
          <div class="field"><label>Je décris mon besoin ci-dessous. <span class="req">*</span></label>
            <textarea id="r-desc" maxlength="5000" placeholder="Ex : Je souhaite nettoyer mon canapé et les fauteuils du salon…" oninput="A.requestDescriptionChanged()">${esc(savedDraft.description || '')}</textarea><div id="r-language-hint" class="small muted" aria-live="polite"></div></div>
        </section>
        <section class="request-section media-request-section">
          <div class="field"><label>Photos <span class="muted small">facultatif · 3 maximum</span></label><div class="photo-strip" id="r-photos"><button type="button" class="ph-add" onclick="A.pickPhotos('r-photos')" aria-label="Ajouter des photos">＋</button></div><input type="file" id="file-input" accept="image/*" multiple style="display:none"></div>
          <div class="field"><label>Message vocal <span class="muted small">facultatif · 25 secondes maximum</span></label><div id="r-audio-zone"><button type="button" class="btn sec sm" id="r-rec" onclick="A.toggleRec('r-audio-zone')">🎤 Enregistrer un message vocal</button></div></div>
        </section>
        <section class="request-section">
          <div class="field"><label>Ville d’intervention <span class="req">*</span></label><input type="text" id="r-city" placeholder="👆 Choisir la ville de l’intervention" readonly style="cursor:pointer;background:#fff" value="${esc(initialCity)}" onclick="A.villePick('r-city')"></div>
          <div class="field" id="r-commune-field" style="display:${initialCity === 'Abidjan' ? 'block' : 'none'}"><label>Commune <span class="req">*</span></label><input type="text" id="r-commune" placeholder="👆 Choisir la commune" readonly style="cursor:pointer;background:#fff" value="${esc(initialCommune)}" onclick="A.communePick()"></div>
          <div class="field"><label>Quartier / repère <span class="muted small">facultatif</span></label><input type="text" id="r-quartier" maxlength="250" placeholder="Ex : Air France, près du marché…" value="${esc(initialQuartier)}"></div>
          <div class="field"><label>Adresse précise <span class="req">*</span></label><input type="text" id="r-addr" maxlength="1000" placeholder="Ex : rue, immeuble, porte ou autre repère" value="${esc(initialAddress)}"></div>
          <div class="gps-row mb"><button type="button" class="btn outline sm" onclick="A.useGPS()" id="b-gps">📍 Ajouter ma position GPS <span class="muted">(facultatif)</span></button><button type="button" class="btn ghost sm" onclick="A.geocodeRequestAddress()">🗺️ Rechercher l’adresse</button></div><div class="small muted" id="r-geocode-note">La recherche d’adresse utilise OpenStreetMap seulement après votre clic.</div>
        </section>
        <section class="request-section">
          <div class="field"><label>Disponibilité</label><select id="r-schedule" onchange="A.requestSchedule()"><option value="asap">Dès que possible</option><option value="today">Aujourd’hui</option><option value="date">À une date précise</option></select><input type="datetime-local" id="r-date" style="display:none;margin-top:8px"></div>
          ${cat.price_from ? `<div class="category-price-reference"><span>Prix indicatif</span><b>À partir de ${fmtFCFA(cat.price_from)}</b><small>Le montant réel dépend du besoin et du lieu.</small></div>` : ''}
          <div id="r-estimate" class="estimate-box" aria-live="polite"></div>
        </section>
        <label class="check-line"><input type="checkbox" id="r-urgent" ${savedDraft.urgence ? 'checked' : ''}> <span>🔥 C'est urgent</span></label>
        <button class="btn category-submit" id="b-send">Trouver un professionnel</button>
      </div>
    </div>${bottomNav('search')}`;
  updateBadges();
  REQ.photos.forEach(file => document.getElementById('r-photos').insertAdjacentHTML('afterbegin', `<img src="${esc(mediaUrl(file))}" alt="Photo jointe">`));
  if (REQ.audio) document.getElementById('r-audio-zone').innerHTML = `<audio controls preload="metadata" src="${esc(mediaUrl(REQ.audio))}"></audio><div class="small muted">Message vocal joint.</div><button type="button" class="btn ghost sm" onclick="A.clearRequestAudio('r-audio-zone')">🗑️ Supprimer</button>`;
  A.updateCategoryNeedSummary();
  if (initialCity === 'Abidjan') A.requestLocationChanged(true);
  if (savedDraft.schedule_type) { document.getElementById('r-schedule').value=savedDraft.schedule_type; document.getElementById('r-date').value=savedDraft.date_souhaitee || ''; A.requestSchedule(); }
  document.querySelectorAll('.category-request-page input, .category-request-page textarea, .category-request-page select').forEach(el => el.addEventListener('input', () => A.saveCategoryDraft(), { passive:true }));
  document.querySelectorAll('.category-request-page select, .category-request-page input[type=checkbox]').forEach(el => el.addEventListener('change', () => A.saveCategoryDraft(), { passive:true }));
  document.getElementById('b-send').onclick = () => A.submitCategoryRequest(cat.id);
}

/* ---------- Grandes catégories : seules cartes du parcours public ---------- */
routes.categories = async (param) => {
  const cityQuery = USER && USER.ville ? '?ville=' + encodeURIComponent(USER.ville) : '';
  const id = Number(param || 0);
  if (id) {
    let cat; try { cat = await api('/grand-categories/' + id + '/catalogue' + cityQuery); }
    catch (e) { toast(e.message, 'err'); nav('#/categories'); return; }
    const serviceChoices = cat.categories.flatMap(c => c.services.map(s => ({ ...s, category:c.name, category_icon:c.icon || '' })));
    renderCategoryRequestForm(cat, serviceChoices);
    return;
  }
  let cats; try { cats = await api('/grand-categories' + cityQuery); }
  catch (e) { $app.innerHTML = header('Tous les services') + `<div class="content">${emptyState('📶', e.message)}</div>` + bottomNav('search'); return; }
  $app.innerHTML = `${header('Tous les services', { bell: !!USER })}<div class="content">
    <div class="hint">Toutes les grandes catégories actives, classées de A à Z.</div>
    ${cats.map(c => `<div class="menu-item" onclick="nav('#/categories/${c.id}')"><span class="mi-ic">${esc(c.icon || '🧩')}</span><div class="grow"><b>${esc(grandLabel(c))}</b>${c.description ? `<div class="small muted">${esc(c.description)}</div>` : ''}${c.price_from ? `<div class="price-from">À partir de ${fmtFCFA(c.price_from)}</div>` : ''}</div><span class="mi-arr">›</span></div>`).join('') || emptyState('📋','Aucune grande catégorie active pour le moment.')}
  </div>${bottomNav('search')}`;
  updateBadges();
};

/* ---------- Tous les services (liste complète : CATÉGORIE → SERVICES) ---------- */
routes.services = async (params) => {
  try { CATALOGUE = await api('/catalogue' + (USER && USER.ville ? '?ville=' + encodeURIComponent(USER.ville) : '')); }
  catch (e) { $app.innerHTML = header('Tous les services') + `<div class="content">${emptyState('📶', e.message)}<button class="btn" onclick="render()">Réessayer</button></div>` + bottomNav('search'); return; }
  if (!ADS.length) try { ADS = await api('/ads'); } catch { }
  const pubsServices = ADS.filter(a => a.placement === 'services');
  const bandePub = adsBandHtml(pubsServices.map(adCardHtml));
  if (pubsServices.length) recordAdViews(pubsServices);
  const catId = parseInt(params || 0, 10);
  const q = (sessionStorage.getItem('ks_cat_q') || '').toLowerCase().trim();
  const hit = x => (x || '').toLowerCase().includes(q);

  // --- Niveau 2 : UNE catégorie → ses services (avec bouton Retour) ---
  if (catId) {
    const c = CATALOGUE.find(x => x.id === catId);
    if (!c) { nav('#/services'); return; }
    $app.innerHTML = `
    ${header(((c.icon || '') + ' ' + c.name).trim())}
    <div class="content">
      ${bandePub}
      ${c.grand_category ? `<div class="small muted mb">${esc(c.grand_icon || '🧩')} ${esc(c.grand_category)} › ${esc(c.name)}</div>` : ''}
      <div class="hint">Choisissez la prestation dont vous avez besoin — vous pourrez la décrire librement à l'étape suivante.</div>
      ${c.services.map(s => `<div class="menu-item" onclick="nav('#/request/${s.id}')">
        <span class="mi-ic">${esc(c.icon || '🔹')}</span><div><div>${esc(s.name)}</div>
        ${prixHtml(s)}
        ${s.taches.length ? `<div class="muted small">${s.taches.slice(0, 3).map(t => esc(t.name)).join(' · ')}${s.taches.length > 3 ? '…' : ''}</div>` : ''}</div>
        <span class="mi-arr">›</span></div>`).join('') || emptyState('📋', 'Aucun service dans cette catégorie pour le moment.')}
    </div>${bottomNav('search')}`;
    updateBadges();
    return;
  }

  // --- Niveau 1 : liste des catégories (ou résultats du filtre) ---
  let listHtml;
  if (q) {
    const out = [];
    const seenSearch = new Set();
    CATALOGUE.forEach(c => c.services.forEach(s => {
      if (!seenSearch.has(Number(s.id)) && (hit(s.name) || hit(c.name) || s.taches.some(t => hit(t.name)))) {
        seenSearch.add(Number(s.id)); out.push({ ...s, icon: c.icon, path: c.name });
      }
    }));
    out.sort((a,b)=>String(a.name).localeCompare(String(b.name),'fr',{sensitivity:'base',numeric:true}));
    listHtml = out.length
      ? out.map(s => `<div class="menu-item" onclick="nav('#/request/${s.id}')"><span class="mi-ic">${esc(s.icon || '🔹')}</span><div><div>${esc(s.name)}</div>${prixHtml(s)}<div class="muted small">${esc(s.path)}</div></div><span class="mi-arr">›</span></div>`).join('')
      : emptyState('🔍', 'Aucun service trouvé pour « ' + esc(q) + ' ».');
  } else {
    // Un seul catalogue central : chaque service actif une seule fois, tri A–Z français,
    // sans distinguer accent ni casse. Les modifications PDG viennent de /catalogue.
    const seen = new Set();
    const all = [];
    CATALOGUE.forEach(c => (c.services || []).forEach(s => {
      if (!seen.has(Number(s.id))) { seen.add(Number(s.id)); all.push({ ...s, icon: s.icon || c.icon, path: [c.grand_category, c.name].filter(Boolean).join(' › ') }); }
    }));
    all.sort((a,b) => String(a.name).localeCompare(String(b.name), 'fr', { sensitivity:'base', numeric:true }));
    listHtml = all.length ? `<div class="small muted mb">${all.length} service${all.length > 1 ? 's' : ''} actif${all.length > 1 ? 's' : ''}, classé${all.length > 1 ? 's' : ''} de A à Z.</div>` + all.map(s => `<div class="menu-item" onclick="nav('#/request/${s.id}')">
      <span class="mi-ic">${esc(s.icon || '🔹')}</span><div><div style="font-weight:700">${esc(s.name)}</div>${prixHtml(s)}<div class="muted small">${esc(s.path)}</div></div><span class="mi-arr">›</span></div>`).join('')
      : emptyState('📋', 'Aucun service actif pour le moment.');
  }

  $app.innerHTML = `
  ${header('Tous les services', { bell: !!USER })}
  <div class="content">
    ${bandePub}
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

/* ---------- Demande de service : tâche facultative, besoin libre prioritaire ---------- */
let REQ = { photos: [], audio: null, lat: null, lng: null };
routes.request = async (serviceId) => {
  let data;
  try { data = await api('/services/' + serviceId + '/questions'); }
  catch (e) { toast(e.message, 'err'); back(); return; }
  let selection = {}; try { selection = JSON.parse(sessionStorage.getItem('ks_search_selection') || '{}'); } catch { selection = {}; }
  if (Number(selection.service_id) !== Number(data.service.id)) selection = {};
  sessionStorage.removeItem('ks_search_selection');
  let savedDraft = {}; try { savedDraft = JSON.parse(sessionStorage.getItem('ks_pending_request_draft') || '{}'); } catch { savedDraft = {}; }
  if (Number(savedDraft.service_id) !== Number(data.service.id)) savedDraft = {};
  const selectedIds = new Set((savedDraft.taches || []).map(t => Number(t.id || t)).concat(savedDraft.task_id ? [Number(savedDraft.task_id)] : [], selection.task_id ? [Number(selection.task_id)] : []));
  REQ = { photos: savedDraft.photos || [], audio: savedDraft.audio || null, lat: savedDraft.lat ?? (USER && USER.lat), lng: savedDraft.lng ?? (USER && USER.lng), service_id: data.service.id,
    task_id: [...selectedIds][0] || null, has_tasks: (data.taches || []).length > 0,
    photo_limit: Math.min(3, Number(data.limits && data.limits.photos || 3)), audio_max: Math.min(25, Number(data.limits && data.limits.audio_seconds || 25) || 25) };
  const initialCity = savedDraft.intervention_city || (USER && USER.ville) || '';
  const initialCommune = savedDraft.intervention_commune || '';
  const tasksHtml = (data.taches || []).length ? `<div class="field"><label>Je choisis mon/mes besoins <span class="muted small">(facultatif)</span></label>
    <div class="choices" id="r-taches">${data.taches.map(t => `<button type="button" class="chip task-chip ${selectedIds.has(Number(t.id)) ? 'on' : ''}" data-task-id="${t.id}" data-task-name="${esc(t.name)}" onclick="A.requestToggleTask(this)">${selectedIds.has(Number(t.id)) ? '☑ ' : '☐ '}${esc(t.name)}</button>`).join('')}</div>
    <div id="r-task-details"></div></div>` : '';
  $app.innerHTML = `
  ${header(data.service.name, { bell: !!USER })}
  <div class="content"><div class="card">
      <div class="small muted mb">${esc(data.service.grand_category || data.service.category || '')}${data.service.category && data.service.grand_category ? ' › ' + esc(data.service.category) : ''} › ${esc(data.service.name)}</div>
      ${tasksHtml}
      <div class="field"><label>Je décris mon besoin ci-dessous. <span class="req">*</span></label>
        <textarea id="r-desc" maxlength="5000" placeholder="Ex : Le robinet de ma cuisine coule depuis ce matin…" oninput="A.requestDescriptionChanged()">${esc(savedDraft.description || selection.query || '')}</textarea><div id="r-language-hint" class="small muted" aria-live="polite"></div></div>
      <div class="field"><label>Photos <span class="muted small">facultatif · 3 maximum</span></label><div class="photo-strip" id="r-photos"><button class="ph-add" onclick="A.pickPhotos('r-photos')">＋</button></div><input type="file" id="file-input" accept="image/*" multiple style="display:none"></div>
      <div class="field"><label>Note vocale <span class="muted small">facultatif · ${REQ.audio_max} secondes maximum</span></label><div id="r-audio-zone"><button class="btn sec sm" id="r-rec" onclick="A.toggleRec('r-audio-zone')">🎤 Enregistrer une note vocale</button></div></div>
      <div class="field"><label>Ville d’intervention <span class="req">*</span></label>
        <input type="text" id="r-city" placeholder="👆 Choisir la ville de l’intervention" readonly style="cursor:pointer;background:#fff" value="${esc(initialCity)}" onclick="A.villePick('r-city')">
      </div>
      <div class="field" id="r-commune-field" style="display:${initialCity === 'Abidjan' ? 'block' : 'none'}"><label>Commune <span class="req">*</span></label>
        <input type="text" id="r-commune" placeholder="👆 Choisir la commune" readonly style="cursor:pointer;background:#fff" value="${esc(initialCommune)}" onclick="A.communePick()">
      </div>
      <div class="field"><label>Adresse / Quartier <span class="req">*</span></label><input type="text" id="r-addr" placeholder="Ex : quartier Air France, près de…" value="${esc(savedDraft.address || (USER && USER.address) || '')}"></div>
      <div class="gps-row mb"><button class="btn outline sm" onclick="A.useGPS()" id="b-gps">📍 Ajouter ma position GPS <span class="muted">(facultatif)</span></button><button class="btn ghost sm" onclick="A.geocodeRequestAddress()">🗺️ Rechercher l’adresse</button></div><div class="small muted" id="r-geocode-note">La recherche d’adresse utilise OpenStreetMap seulement après votre clic.</div>
      <div class="field"><label>Disponibilité</label><select id="r-schedule" onchange="A.requestSchedule()"><option value="asap">Dès que possible</option><option value="today">Aujourd’hui</option><option value="date">À une date précise</option></select><input type="datetime-local" id="r-date" style="display:none;margin-top:8px"></div>
      <div id="r-estimate" class="estimate-box" aria-live="polite"></div>
      <label class="check-line"><input type="checkbox" id="r-urgent" ${savedDraft.urgence ? 'checked' : ''}> 🔥 C'est urgent</label>
      <button class="btn" id="b-send">Trouver un professionnel</button>
  </div></div>${bottomNav('search')}`;
  updateBadges();
  if (initialCity === 'Abidjan') await A.requestLocationChanged(true);
  // Recrée les éventuelles précisions sauvegardées, sans imposer une tâche.
  document.querySelectorAll('#r-taches .task-chip.on').forEach(el => {
    A.toggleTask(el, true);
    const saved = (savedDraft.taches || []).find(t => Number(t.id || t) === Number(el.dataset.taskId));
    const detail = document.getElementById('r-task-detail-' + el.dataset.taskId);
    if (saved && detail) detail.value = saved.detail || '';
  });
  A.requestEstimate();
  if (savedDraft.schedule_type) { document.getElementById('r-schedule').value = savedDraft.schedule_type; document.getElementById('r-date').value = savedDraft.date_souhaitee || ''; A.requestSchedule(); }
  document.getElementById('b-send').onclick = async () => {
    const addr = document.getElementById('r-addr').value, description = document.getElementById('r-desc').value;
    const interventionCity = document.getElementById('r-city').value, interventionCommune = (document.getElementById('r-commune') || {}).value || '';
    const taches = [...document.querySelectorAll('#r-taches .task-chip.on')].map(el => ({ id:Number(el.dataset.taskId), detail:((document.getElementById('r-task-detail-'+el.dataset.taskId)||{}).value||'').trim() }));
    REQ.task_id = taches[0] ? taches[0].id : null;
    if (!description.trim()) { toast('Décrivez votre besoin.', 'err'); return; }
    if (!interventionCity.trim()) { toast('Choisissez la ville d’intervention.', 'err'); return; }
    if (interventionCity === 'Abidjan' && !interventionCommune.trim()) { toast('Choisissez la commune d’intervention.', 'err'); return; }
    if (!addr.trim()) { toast('Indiquez l’adresse ou le quartier de l’intervention.', 'err'); return; }
    REQ.draft = { service_id: REQ.service_id, task_id: REQ.task_id, taches, answers: {}, description, address: addr, intervention_city: interventionCity, intervention_commune: interventionCommune, lat: REQ.lat, lng: REQ.lng,
      urgence: document.getElementById('r-urgent').checked, schedule_type: document.getElementById('r-schedule').value, date_souhaitee: document.getElementById('r-date').value || null, photos: REQ.photos, audio: REQ.audio };
    if (!USER) { sessionStorage.setItem('ks_pending_request_draft', JSON.stringify(REQ.draft)); authRequired('#/request/' + data.service.id); return; }
    sessionStorage.removeItem('ks_pending_request_draft'); A.chooseProviderForRequest();
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
        <div class="small muted">${m.provider_type === 'entreprise' ? '🏢 Entreprise recherchée' : '👤 Particulier recherché'}</div>
        ${m.taches && m.taches.length ? `<div class="small">🛠️ ${m.taches.map(t => esc(t.name)).join(' • ')}</div>` : (m.tache ? `<div class="small">🛠️ ${esc(m.tache)}</div>` : '')}
        <div class="muted small">${esc(m.address || '')} • ${fmtDate(m.created_at)}</div></div>
        ${statusPill(m.status)}</div>
      ${m.urgence ? '<div class="small" style="color:var(--danger);font-weight:700;margin-top:6px">🔥 Urgent</div>' : ''}
    </div>`;
  $app.innerHTML = `
  ${header(isPro ? 'Demandes & Missions' : 'Mes demandes', { back: 'contextual' })}
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
      <button class="btn sec mb" onclick="nav('#/home')">＋ Nouvelle demande</button>
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
  const orderIdx = { recherche: 0, sans_pro: 0, acceptee: 1, confirmee: 2, demarrage_demande: 2, en_cours: 3, fin_demande: 3, terminee: 4, payee: 5 };
  const curIdx = orderIdx[m.status] ?? -1;

  let banner = '';
  if (m.status === 'recherche') banner = isClient
    ? `<div class="status-banner search"><div class="spinner"></div>Recherche de professionnels disponibles… Vous serez notifié dès qu'un professionnel accepte.</div>`
    : (isCand && m.offer_pending ? `<div class="status-banner info">🔔 Cette mission vous est proposée. Répondez rapidement !</div>` : `<div class="status-banner search"><div class="spinner"></div>En attente de réponse…</div>`);
  if (m.status === 'sans_pro') banner = isClient
    ? `<div class="status-banner bad">😕 Aucun ${m.provider_type === 'entreprise' ? 'entreprise' : 'particulier'} admissible n'est disponible pour le moment.<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button class="btn sm" onclick="A.changeMissionProvider(${m.id})">Changer le type</button><button class="btn sm sec" onclick="A.relancerMission(${m.id})">Relancer</button></div></div>`
    : `<div class="status-banner bad">😕 Cette demande n'est plus disponible.</div>`;
  if (m.status === 'acceptee') banner = isClient
    ? `<div class="status-banner ok">✅ ${esc(m.pro ? m.pro.name : 'Un professionnel')} a accepté ! Consultez son profil puis confirmez.</div>`
    : `<div class="status-banner info">En attente de la confirmation du client.</div>`;
  if (m.status === 'confirmee') banner = `<div class="status-banner ok">📅 Mission programmée.${isPro ? ' Vous pouvez demander le démarrage le moment venu.' : ''}</div>`;
  if (m.status === 'demarrage_demande') banner = `<div class="status-banner info">🛠️ Le professionnel demande le démarrage. ${isClient ? 'Votre confirmation est requise.' : 'En attente de la confirmation du client.'}</div>`;
  if (m.status === 'en_cours') banner = `<div class="status-banner info">🛠️ Mission en cours de réalisation.</div>`;
  if (m.status === 'fin_demande') banner = `<div class="status-banner info">✅ Le professionnel déclare la mission terminée. ${isClient ? 'Confirmez ou contestez la fin.' : 'En attente de la confirmation du client.'}</div>`;
  if (m.status === 'terminee') banner = `<div class="status-banner search">💵 Fin confirmée — paiement déclaré, en attente des confirmations.</div>`;
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
      ${(m.pro || isPro) && !['annulee','payee','litige'].includes(m.status) ? `<button class="btn sec sm mt" onclick="nav('#/chat/${m.id}')">💬 Ouvrir la discussion ${m.unread_messages ? `<span class="badge">${m.unread_messages}</span>` : ''}</button>` : (m.status === 'payee' ? '<div class="small muted mt">🔒 Conversation clôturée après validation du paiement. Pour toute question, utilisez Contacter Klean Services.</div>' : '')}
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
        ${!isClient ? `<div class="muted small">Commission Klean Services (${p.commission_rate}%) : ${fmtFCFA(p.commission_amount)}<br><b>Votre part : ${fmtFCFA(p.pro_amount)}</b></div>` : ''}
      </div>
      <span class="pill ${p.status === 'valide' ? 'ok' : 'warn'}">${p.status === 'valide' ? 'Payé ✓' : p.status === 'en_attente' ? 'En attente' : 'Confirmation partielle'}</span></div>
      ${p.status !== 'valide' ? (meConfirmed
        ? `<div class="muted small mt">✓ Vous avez confirmé. En attente de la confirmation de l'autre partie.</div>`
        : `<button class="btn mt" onclick="A.confirmPay(${m.id},this)">${isClient ? '💵 J\u2019ai remis le paiement en espèces' : '💵 J\u2019ai bien reçu le paiement en espèces'}</button>`) : ''}
    </div>`;
  } else if (isPro && ['acceptee', 'confirmee', 'en_cours'].includes(m.status)) {
    const pcPending = (m.price_changes || []).find(pc => pc.status === 'en_attente');
    if (!m.amount) {
      payBlock = `<div class="sec-title">Montant de la mission</div><div class="card">
        <div class="field"><label>Montant (FCFA) <span class="req">*</span></label>
        <input type="number" id="m-amount" min="100" step="100" placeholder="Ex : 10000" oninput="A.finPreview(${m.commission_rate})"></div>
        <div class="small mb" id="fin-preview" class="muted">Commission Klean Services : ${m.commission_rate}% — elle sera déduite de ce montant.</div>
        <button class="btn sec sm" onclick="A.setAmount(${m.id},this)">Enregistrer le montant</button></div>`;
    } else {
      // Transparence totale : prix, commission et part du professionnel calculés par le serveur
      payBlock = `<div class="sec-title">Montant de la mission</div><div class="card">
        <div class="bold">${fmtFCFA(m.finance.amount)}</div>
        <div class="muted small">Commission Klean Services (${m.finance.commission_rate}%) : ${fmtFCFA(m.finance.commission)}<br><b>Votre part : ${fmtFCFA(m.finance.pro_amount)}</b></div>
        ${pcPending
          ? `<div class="status-banner search mt">⏳ Modification demandée : ${fmtFCFA(pcPending.old_amount)} → ${fmtFCFA(pcPending.new_amount)}. En attente de la réponse du client.</div>`
          : `<button class="btn outline sm mt" onclick="A.prixModifForm(${m.id},${m.amount},${m.finance.commission_rate})">✏️ Demander une modification du prix</button>
             <div class="muted small mt">Travail plus important que prévu ? Le nouveau prix devra être accepté par le client.</div>`}
      </div>`;
    }
  } else if (isClient && m.amount) {
    const pcPending = (m.price_changes || []).find(pc => pc.status === 'en_attente');
    const diff = pcPending ? pcPending.new_amount - pcPending.old_amount : 0;
    const newCom = pcPending && m.finance ? Math.round(pcPending.new_amount * m.finance.commission_rate / 100) : 0;
    payBlock = `<div class="sec-title">Montant</div><div class="card"><div class="bold">${fmtFCFA(m.amount)} <span class="muted small">• paiement en espèces à la fin de la mission</span></div></div>
    ${pcPending ? `<div class="card" style="border:2px solid #f59e0b">
      <div class="bold mb">💬 Le professionnel propose un nouveau prix</div>
      <div class="small">Ancien prix : <b>${fmtFCFA(pcPending.old_amount)}</b></div>
      <div class="small">Nouveau prix : <b>${fmtFCFA(pcPending.new_amount)}</b> (${diff > 0 ? '+' : ''}${diff.toLocaleString('fr-FR')} FCFA)</div>
      ${m.finance && m.finance.commission_enabled ? `<div class="small">Nouvelle commission Klean Services (${m.finance.commission_rate}%) : ${fmtFCFA(newCom)} — déjà incluse dans le prix.</div>` : ''}
      <div class="small mt"><b>Motif :</b> ${esc(pcPending.reason)}</div>
      <div class="btn-row mt">
        <button class="btn warn" onclick="A.prixReponse(${m.id},${pcPending.id},false,this)">Refuser</button>
        <button class="btn" onclick="A.prixReponse(${m.id},${pcPending.id},true,this)">✅ Accepter le nouveau prix</button>
      </div></div>` : ''}`;
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
  if (isPro && m.status === 'confirmee') actions = `<button class="btn mt" onclick="A.startMission(${m.id},this)">🛠️ Demander le démarrage</button>`;
  if (isClient && m.status === 'demarrage_demande') actions = `<div class="btn-row mt"><button class="btn warn" onclick="A.contestStage(${m.id},'start',this)">Contester</button><button class="btn" onclick="A.confirmStart(${m.id},this)">✅ Confirmer le démarrage</button></div>`;
  if (isPro && m.status === 'en_cours') actions = `<button class="btn mt" onclick="A.completeMission(${m.id},this)">✅ Demander la confirmation de fin</button>`;
  if (isClient && m.status === 'fin_demande') actions = `<div class="btn-row mt"><button class="btn warn" onclick="A.contestStage(${m.id},'complete',this)">Contester la fin</button><button class="btn" onclick="A.confirmEnd(${m.id},this)">✅ Confirmer la fin</button></div>`;
  if (isPro && m.pro && ['acceptee','confirmee','demarrage_demande','en_cours','fin_demande','terminee'].includes(m.status)) actions += `<button class="btn outline mt" onclick="A.openDirections(${m.id},this)">🗺️ Itinéraire vers le client</button>`;
  const cancellable = ['recherche', 'sans_pro', 'acceptee', 'confirmee', 'demarrage_demande', 'en_cours', 'fin_demande'].includes(m.status) && (isClient || isPro);

  $app.innerHTML = `
  ${header(m.service)}
  <div class="content">
    ${banner}
    <div class="card">
      <div class="row"><span style="font-size:26px">${esc(m.icon || '📋')}</span>
        <div class="grow"><div class="bold">${esc(m.service)}</div><div class="muted small">N° ${esc(m.code)} • ${fmtDate(m.created_at)}</div></div>
        ${statusPill(m.status)}</div>
      <div class="small muted mt">Prestataire recherché : <b>${m.provider_type === 'entreprise' ? '🏢 Une entreprise' : '👤 Un particulier'}</b>${m.capacity_required > 1 ? ' • capacité renforcée requise' : ''}</div>
      ${m.taches && m.taches.length ? `<div class="small mt"><b>🛠️ Tâches demandées :</b>${m.taches.map(t => `<div>• ${esc(t.name)}${t.detail ? ` — ${esc(t.detail)}` : ''}</div>`).join('')}</div>` : (m.tache ? `<div class="small mt"><b>🛠️ Tâche demandée :</b> ${esc(m.tache)}</div>` : '')}
      ${m.urgence ? '<div class="small mt" style="color:var(--danger);font-weight:700">🔥 Demande urgente</div>' : ''}
      ${m.date_souhaitee ? `<div class="small mt">📅 Souhaité : ${fmtDate(m.date_souhaitee)}</div>` : ''}
      <div class="small mt">📍 ${esc(m.address || '')}</div>
      ${m.detail.length ? `<div class="sec-title" style="margin-top:14px">Détails</div>` + m.detail.map(d => `<div class="small"><b>${esc(d.label)} :</b> ${esc(d.value)}</div>`).join('') : ''}
      ${m.description ? `<div class="small mt"><b>Message :</b> ${esc(m.description)}</div>` : ''}
      ${m.photos.length ? `<div class="photo-strip">${m.photos.map(p => `<img src="${esc(mediaUrl(p))}" onclick="A.viewPhoto('${esc(p)}')" onerror="this.classList.add('msg-missing')">`).join('')}</div>` : ''}
      ${m.audio ? `<div class="mt"><audio controls src="${esc(mediaUrl(m.audio))}"></audio></div>` : ''}
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
  const chat = m.chat || { locked: false, text_limit: 30, image_limit: 3, audio_max_seconds: 20, audio_enabled: true, image_enabled: true, used_text: 0, used_images: 0 };
  A._audioMaxSec = chat.audio_max_seconds || 20;
  const readonly = !!chat.locked;
  $app.innerHTML = `
  ${header(other + ' — ' + m.service, { bell: false })}
  <div class="chat-wrap">
    <div class="chat-msgs" id="chat-msgs">
      <div class="center muted small">Conversation liée à la mission n° ${esc(m.code)}</div>
      ${readonly ? '<div class="status-banner info">🔒 Cette conversation est en lecture seule. La prestation est clôturée ; contactez Klean Services en cas de besoin.</div>' : ''}
      ${msgs.map(x => chatBubble(x)).join('')}
    </div>
    ${readonly ? `<div class="chat-input"><button class="btn sec" onclick="nav('#/contact')">📩 Contacter Klean Services</button></div>` : `<div class="small muted" style="padding:4px 14px 0">Texte : ${chat.used_text || 0}/${chat.text_limit} • Images : ${chat.used_images || 0}/${chat.image_limit} • Vocal : ${chat.audio_max_seconds}s max</div>
    <div class="chat-presets"><button type="button" onclick="A.chatPreset('Bonjour, je suis en route.')">Je suis en route</button><button type="button" onclick="A.chatPreset('Je suis bien arrivé(e).')">Je suis arrivé(e)</button><button type="button" onclick="A.chatPreset('Merci, à bientôt.')">Merci</button></div>
    <div class="chat-input">
      ${chat.image_enabled ? `<button class="icon-btn" onclick="A.chatPhoto(${m.id})" title="Envoyer une photo">📷</button>` : ''}
      ${chat.audio_enabled ? `<button class="icon-btn" id="chat-rec" onclick="A.chatAudio(${m.id})" title="Message vocal">🎤</button>` : ''}
      <textarea id="chat-text" rows="1" maxlength="2000" placeholder="Votre message…"></textarea>
      <button class="icon-btn main" onclick="A.chatSend(${m.id})">➤</button>
    </div>`}
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
  if (x.type === 'photo') inner = `<img src="${esc(mediaUrl(x.file))}" onclick="A.viewPhoto('${esc(x.file)}')" onerror="this.outerHTML='<i>📷 Photo expirée</i>'">` + (x.content ? `<div>${esc(x.content)}</div>` : '');
  if (x.type === 'audio') inner = `<audio controls src="${esc(mediaUrl(x.file))}"></audio>`;
  return `<div class="bubble ${me ? 'me' : 'them'}">${inner}<div class="b-time">${fmtDate(x.created_at)}</div></div>`;
}
function appendChatMsg(x) {
  const box = document.getElementById('chat-msgs');
  if (!box) return;
  box.insertAdjacentHTML('beforeend', chatBubble(x));
  box.scrollTop = box.scrollHeight;
}

/* ---------- Contact direct avec Klean Services ---------- */
function supportBubble(x) {
  const mine = USER && x.sender_id === USER.id;
  const label = mine ? 'Vous' : 'Klean Services';
  const body = x.type === 'audio' ? `<audio controls src="${esc(mediaUrl(x.file))}"></audio>` : esc(x.content || '');
  return `<div class="bubble ${mine ? 'me' : 'them'}"><div class="small" style="font-weight:700;margin-bottom:3px">${label}${x.is_auto ? ' • réponse automatique' : ''}</div>${body}<div class="b-time">${fmtDate(x.created_at)}</div></div>`;
}
function appendSupportMsg(x) {
  const box = document.getElementById('support-msgs');
  if (!box || !x) return;
  box.insertAdjacentHTML('beforeend', supportBubble(x));
  box.scrollTop = box.scrollHeight;
}
routes.contact = async (param) => {
  if (!USER) { nav('#/login'); return; }
  if (param === 'new') {
    const subject = sessionStorage.getItem('ks_contact_subject') || '';
    if (!['suggestion', 'preoccupation'].includes(subject)) { nav('#/contact'); return; }
    const label = subject === 'suggestion' ? '💡 Suggestion' : '⚠️ Préoccupation';
    const question = subject === 'suggestion' ? 'Que voulez-vous suggérer ?' : 'Quelle est votre préoccupation ?';
    $app.innerHTML = `${header(label)}<div class="content"><div class="card">
      <div class="bold mb">${question}</div><div class="field"><textarea id="support-first" maxlength="3000" placeholder="Écrivez votre message ici…"></textarea></div>
      <button class="btn" onclick="A.supportCreate('${subject}',this)">Envoyer</button></div></div>${bottomNav('account')}`;
    return;
  }
  if (param) {
    let d; try { d = await api('/support/conversations/' + encodeURIComponent(param)); } catch (e) { toast(e.message, 'err'); back(); return; }
    currentSupport = Number(d.conversation.id);
    const subjectLabel = d.conversation.subject === 'suggestion' ? '💡 Suggestion' : '⚠️ Préoccupation';
    $app.innerHTML = `${header('Klean Services — ' + subjectLabel, { bell: false })}
      <div class="chat-wrap"><div class="chat-msgs" id="support-msgs">
        <div class="center muted small">Conversation ${d.conversation.status === 'ouverte' ? 'ouverte' : 'fermée'} • ${subjectLabel}</div>
        ${d.messages.map(supportBubble).join('')}</div>
        ${d.conversation.status === 'ouverte' ? `<div class="chat-input"><textarea id="support-text" rows="1" maxlength="3000" placeholder="Votre message…"></textarea><button class="icon-btn main" onclick="A.supportSend(${d.conversation.id})">➤</button></div>` : `<div class="chat-input"><div class="muted small">Cette conversation est fermée. Vous pouvez ouvrir une nouvelle demande depuis « Contacter Klean Services ».</div></div>`}
      </div>`;
    const box = document.getElementById('support-msgs'); box.scrollTop = box.scrollHeight;
    const input = document.getElementById('support-text'); if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); A.supportSend(d.conversation.id); } });
    return;
  }
  let conversations = []; try { conversations = await api('/support/conversations'); } catch (e) { toast(e.message, 'err'); }
  $app.innerHTML = `${header('Contacter Klean Services')}
    <div class="content"><div class="hint">Choisissez le sujet de votre message. Notre équipe peut ensuite vous répondre directement ici.</div>
      <div class="menu-item" onclick="A.startContact('suggestion')"><span class="mi-ic">💡</span><div>Suggestion<div class="muted small">Proposer une amélioration</div></div><span class="mi-arr">›</span></div>
      <div class="menu-item" onclick="A.startContact('preoccupation')"><span class="mi-ic">⚠️</span><div>Préoccupation<div class="muted small">Signaler une difficulté ou demander de l'aide</div></div><span class="mi-arr">›</span></div>
      ${conversations.length ? `<div class="sec-title">Mes conversations</div>${conversations.map(c => `<div class="card tap" onclick="nav('#/contact/${c.id}')"><div class="row"><span class="mi-ic">${c.subject === 'suggestion' ? '💡' : '⚠️'}</span><div class="grow"><div class="bold">${c.subject === 'suggestion' ? 'Suggestion' : 'Préoccupation'} <span class="muted small">• ${c.status === 'ouverte' ? 'Ouverte' : 'Fermée'}</span></div><div class="conv-prev">${c.last_type === 'audio' ? '🎤 Message vocal' : esc(c.last_content || '')}</div></div><div class="muted small">${fmtDate(c.last_at || c.updated_at)}</div></div></div>`).join('')}` : ''}
    </div>${bottomNav('account')}`;
};

/* ---------- Messages (conversations) ---------- */
routes.messages = async () => {
  if (!USER) { nav('#/login'); return; }
  let convs = [];
  try { convs = await api('/conversations'); } catch (e) { toast(e.message, 'err'); }
  $app.innerHTML = `
  ${header('Messages', { back: 'contextual' })}
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
  if (!USER) { guestAccount(); return; }
  try { USER = await api('/me'); } catch { }
  const statut = USER.pro_status === 'approved' ? 'Client • Professionnel' : 'Client';
  $app.innerHTML = `
  ${header('Mon compte', { back: 'contextual' })}
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
    <div class="menu-item" onclick="nav('#/contact')"><span class="mi-ic">📩</span>Contacter Klean Services<span class="mi-arr">›</span></div>
    <div class="menu-item" onclick="nav('#/my-reviews')"><span class="mi-ic">⭐</span>Mes avis<span class="mi-arr">›</span></div>

    <div class="collap" id="c-autres">
      <div class="collap-head" onclick="A.collap('c-autres')">Autres services <span class="arr">›</span></div>
      <div class="collap-body">
        <div class="menu-item" onclick="nav('#/avis-recherche')"><span class="mi-ic">📢</span>Avis de recherche<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/jobs')"><span class="mi-ic">💼</span>Trouver ou proposer un job<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/ecole-famille')"><span class="mi-ic">🏫</span>École & famille<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/urgence')"><span class="mi-ic">🚨</span>Urgences<span class="mi-arr">›</span></div>
      </div>
    </div>

    <div class="collap" id="c-compte">
      <div class="collap-head" onclick="A.collap('c-compte')">Compte & paramètres <span class="arr">›</span></div>
      <div class="collap-body">
        <div class="menu-item" onclick="nav('#/infos')"><span class="mi-ic">✏️</span>Mes informations<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/addresses')"><span class="mi-ic">📍</span>Mes adresses<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/payments')"><span class="mi-ic">💳</span>Paiements<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/notifications')"><span class="mi-ic">🔔</span>Notifications<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="A.enablePush()"><span class="mi-ic">📲</span>Notifications sur cet appareil<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/security')"><span class="mi-ic">🔒</span>Sécurité<span class="mi-arr">›</span></div>
        <div class="menu-item" onclick="nav('#/settings')"><span class="mi-ic">⚙️</span>Paramètres<span class="mi-arr">›</span></div>
      </div>
    </div>
    <div class="sec-title">Klean Services</div>
    <div class="menu-item" onclick="nav('#/about')"><span class="mi-ic">ℹ️</span>À propos de Klean Services<span class="mi-arr">›</span></div>
    <div class="menu-item" onclick="A.shareApp()"><span class="mi-ic">↗️</span>Partager l’application<span class="mi-arr">›</span></div>
    ${['pdg', 'admin', 'gestionnaire', 'agent'].includes(USER.role) ? `<a class="menu-item" href="/admin" style="text-decoration:none;color:inherit"><span class="mi-ic">🖥️</span>Tableau de bord administrateur<span class="mi-arr">›</span></a>` : ''}
    <button class="btn ghost mt" onclick="logout()">Se déconnecter</button>
  </div>${bottomNav('account')}`;
  updateBadges();
};

/* ---------- À propos & partage ---------- */
routes.about = async () => {
  let d;
  try { d = await api('/about'); } catch (e) { toast(e.message, 'err'); back(); return; }
  $app.innerHTML = `${header('À propos de Klean Services')}<div class="content">
    <div class="card"><div class="bold" style="font-size:20px;margin-bottom:12px">${esc(d.title)}</div>
      ${(d.paragraphs || []).map(p => `<div style="margin:0 0 16px"><div class="bold">${esc(p.heading || '')}</div><div class="small" style="white-space:pre-wrap;line-height:1.55">${esc(p.text || '')}</div></div>`).join('') || '<div class="muted">Le contenu est en cours de publication.</div>'}
    </div>
    <button class="btn sec" onclick="A.shareApp()">↗️ Partager l’application</button>
  </div>${bottomNav('account')}`;
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
  SERVICES = await api('/services' + (USER && USER.ville ? '?ville=' + encodeURIComponent(USER.ville) : ''));
  try { GRAND_CATEGORIES = await api('/grand-categories'); } catch { GRAND_CATEGORIES = []; }
  try { PRO_SKILLS = await api('/pro-skill-catalogue'); } catch { PRO_SKILLS = []; }
  let rules = { pro: '' };
  try { rules = await api('/rules'); } catch { }
  const rejected = USER.pro_status === 'rejected';

  // --- Étape 1 : choisir le type de compte professionnel ---
  const proType = sessionStorage.getItem('ks_pro_type') || (USER.pro && USER.pro.pro_type) || '';
  if (proType !== 'particulier' && proType !== 'entreprise') {
    $app.innerHTML = `${header('Devenir professionnel')}
    <div class="content">
      ${rejected ? `<div class="status-banner bad">Votre précédente demande a été refusée${USER.pro && USER.pro.rejected_reason ? ' : ' + esc(USER.pro.rejected_reason) : ''}. Vous pouvez compléter et renvoyer votre dossier.</div>` : ''}
      <div class="hint">Quel type de compte professionnel souhaitez-vous ouvrir ?</div>
      <div class="card" style="cursor:pointer" onclick="sessionStorage.setItem('ks_pro_type','particulier');render()">
        <div class="bold" style="font-size:17px">👤 PARTICULIER</div>
        <div class="muted small" style="margin-top:4px">Petits dépannages, interventions ponctuelles, petits travaux, services à domicile, prestations individuelles.</div>
        <div class="bold small" style="color:var(--p,#0b7a6b);margin-top:6px">Choisir ›</div>
      </div>
      <div class="card" style="cursor:pointer" onclick="sessionStorage.setItem('ks_pro_type','entreprise');render()">
        <div class="bold" style="font-size:17px">🏢 ENTREPRISE</div>
        <div class="muted small" style="margin-top:4px">Grandes prestations, chantiers, marchés importants, interventions pour entreprises, équipes de plusieurs personnes.</div>
        <div class="bold small" style="color:var(--p,#0b7a6b);margin-top:6px">Choisir ›</div>
      </div>
    </div>${bottomNav('account')}`;
    updateBadges();
    return;
  }
  const estEnt = proType === 'entreprise';

  $app.innerHTML = `${header('Devenir professionnel')}
  <div class="content">
    ${rejected ? `<div class="status-banner bad">Votre précédente demande a été refusée${USER.pro && USER.pro.rejected_reason ? ' : ' + esc(USER.pro.rejected_reason) : ''}. Vous pouvez compléter et renvoyer votre dossier.</div>` : ''}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px" class="mb">
        <div class="bold">${estEnt ? '🏢 Compte Entreprise' : '👤 Compte Particulier'}</div>
        <button class="btn sec sm" onclick="sessionStorage.removeItem('ks_pro_type');render()">Changer de type</button>
      </div>
      <div class="muted small mb">Conditions : informations exactes, respect des règles professionnelles, validation par l'administration. Votre compte restera aussi un compte client.</div>
      ${estEnt ? `
      <div class="field"><label>Nom de l'entreprise <span class="req">*</span></label><input type="text" id="p-cname" placeholder="Ex : Klean BTP Sarl" value="${esc(USER.pro && USER.pro.company_name || '')}"></div>
      <div class="field"><label>Registre de commerce (RCCM) — si disponible</label><input type="text" id="p-rccm" placeholder="Ex : CI-ABJ-2024-B-12345" value="${esc(USER.pro && USER.pro.company_rccm || '')}"></div>
      <div class="field"><label>Taille de l'équipe</label><select id="p-csize">
        ${['','2 à 5 personnes','6 à 10 personnes','11 à 50 personnes','Plus de 50 personnes'].map(v => `<option value="${esc(v)}" ${USER.pro && USER.pro.company_size === v ? 'selected' : ''}>${v || 'Choisir…'}</option>`).join('')}
      </select></div>` : ''}
      <div class="field"><label>${estEnt ? "Domaine d'activité de l'entreprise" : 'Votre profession'} <span class="req">*</span></label><input type="text" id="p-prof" placeholder="${estEnt ? 'Ex : Bâtiment, nettoyage industriel, événementiel…' : "Ex : Plombier, Électricien, Agent d'entretien…"}" value="${esc(USER.pro ? USER.pro.profession : '')}"></div>
      <div class="field"><label>Mes compétences : catégorie puis sous-catégorie <span class="req">*</span></label>
        <div class="muted small mb">Ouvrez une catégorie principale, puis cochez une ou plusieurs sous-catégories que vous maîtrisez réellement. Vous pouvez en choisir dans plusieurs catégories.</div>
        <div id="p-domains">${proSkillPicker(USER.pro ? (USER.pro.selected_subcategories || []) : [])}</div></div>
      <div class="field"><label>Zone d'intervention <span class="req">*</span></label><input type="text" id="p-zone" placeholder="Ex : Bouaké et environs" value="${esc(USER.pro ? USER.pro.zone : '')}"></div>
      <div class="field"><label>Expérience</label><input type="text" id="p-exp" placeholder="Ex : 5 ans d'expérience" value="${esc(USER.pro ? USER.pro.experience : '')}"></div>
      <div class="field"><label>Description</label><textarea id="p-desc" placeholder="Présentez-vous en quelques lignes…">${esc(USER.pro ? USER.pro.description : '')}</textarea></div>
      <div class="field"><label>${estEnt ? 'Documents (registre de commerce, pièce du responsable, références…)' : 'Documents (CNI, diplômes…)'} — recommandés, parfois obligatoires</label>
        <div class="photo-strip" id="p-docs"><button class="ph-add" onclick="A.pickPhotos('p-docs')">＋</button></div>
        <input type="file" id="file-input" accept="image/*,.pdf" multiple style="display:none">
      </div>
      <div class="sec-title">Règles professionnelles</div>
      <div class="rules-box">${esc(rules.pro || '')}</div>
      <label class="check-line"><input type="checkbox" id="p-accept"> J'ai lu et j'accepte les règles professionnelles de Klean Services.</label>
      <button class="btn" id="b-apply">Envoyer ma demande</button>
    </div>
  </div>${bottomNav('account')}`;
  REQ = { photos: [] };
  document.getElementById('b-apply').onclick = async e => {
    const selected_subcategories = selectedProSubcategories();
    busy(e.target, true);
    try {
      await api('/pro/apply', {
        method: 'POST', body: {
          profession: document.getElementById('p-prof').value, selected_subcategories,
          zone: document.getElementById('p-zone').value, experience: document.getElementById('p-exp').value,
          description: document.getElementById('p-desc').value, documents: REQ.photos,
          accept_rules: document.getElementById('p-accept').checked,
          pro_type: proType,
          company_name: document.getElementById('p-cname') ? document.getElementById('p-cname').value : '',
          company_rccm: document.getElementById('p-rccm') ? document.getElementById('p-rccm').value : '',
          company_size: document.getElementById('p-csize') ? document.getElementById('p-csize').value : ''
        }
      });
      sessionStorage.removeItem('ks_pro_type');
      toast('Demande envoyée ! L\u2019administration va la valider.', 'ok');
      render();
    } catch (err) { toast(err.message, 'err'); busy(e.target, false); }
  };
};

async function renderProDashboard() {
  let d, cc = null, proOptions = [];
  try { d = await api('/pro/dashboard'); } catch (e) { toast(e.message, 'err'); return; }
  try { cc = await api('/commerce/config'); } catch { } // une option désactivée n'est pas proposée
  try { proOptions = await api('/pro-options'); } catch { }
  const upcoming = d.missions.filter(m => ['confirmee', 'acceptee', 'demarrage_demande', 'en_cours', 'fin_demande'].includes(m.status));
  const avState = d.availability_status || (d.available ? 'disponible' : 'indisponible');
  const avLabel = { disponible: '🟢 Disponible', alerte: '🔔 Alerté — demande à traiter', en_mission: '🧰 En mission', indisponible: '⚪ Indisponible', suspendu: '🚫 Suspendu' }[avState] || avState;
  $app.innerHTML = `${header('Mon espace professionnel')}
  <div class="content">
    ${USER.kp_code ? `<div class="card" style="text-align:center;padding:10px"><span class="muted small">Votre code professionnel</span><div class="bold" style="font-size:20px;letter-spacing:2px">${esc(USER.kp_code)}</div></div>` : ''}
    <div class="avail-toggle" onclick="A.toggleAvail(${d.available ? 0 : 1})">
      <div class="dot ${d.available ? 'on' : ''}"></div>
      <div class="grow"><div class="bold">${avLabel}</div>
      <div class="muted small">${avState === 'en_mission' ? 'Vous ne recevrez aucune nouvelle demande jusqu’à la clôture de votre mission.' : d.available ? 'Vous recevez les nouvelles missions.' : 'Touchez pour redevenir disponible et recevoir des missions.'}</div></div>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="v">${d.stats.en_cours}</div><div class="l">Missions en cours</div></div>
      <div class="stat"><div class="v">${d.stats.terminees}</div><div class="l">Missions terminées</div></div>
      <div class="stat"><div class="v">${(d.stats.revenus).toLocaleString('fr-FR')}</div><div class="l">Revenus (FCFA)</div></div>
      <div class="stat"><div class="v">${d.stats.rating ? d.stats.rating + ' ★' : '—'}</div><div class="l">${d.stats.reviews} évaluation(s)</div></div>
    </div>
    <div class="muted small center mb">Commission Klean Services : ${d.stats.commission_rate}% par mission</div>
    ${proOptions.length ? `<div class="sec-title">🧩 Mes options professionnelles</div><div class="card">${proOptions.map(o => `<div class="option-pro"><div class="grow"><div class="bold">${esc(o.name)} ${o.required ? '<span class="req">Obligatoire</span>' : '<span class="muted small">Facultative</span>'}</div><div class="small muted">${esc(o.description || 'Option proposée par Klean Services.')}</div><textarea id="pro-opt-${o.id}" rows="2" placeholder="Votre réponse / confirmation…">${esc(o.usage && o.usage.payload || '')}</textarea></div><button class="btn sm" onclick="A.saveProOption(${o.id},${o.required ? 1 : 0})">Enregistrer</button></div>`).join('')}</div>` : ''}
    ${d.offers.length ? `<button class="card tap" style="width:100%;border:2px solid var(--accent,#0b7a75);text-align:left" onclick="sessionStorage.setItem('ks_mtab','pro');nav('#/missions')"><div class="row"><span style="font-size:25px">🔔</span><div class="grow"><b>Demandes disponibles</b><div class="small muted">Ouvrir les demandes auxquelles vous pouvez réellement répondre</div></div><span class="badge">${d.offers.length}</span></div></button><div class="sec-title">🔔 Missions à traiter (${d.offers.length})</div>` + d.offers.map(m => `
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
    <div class="menu-item" onclick="A.changeServiceCity()"><span class="mi-ic">📍</span><div class="grow">Ma ville d’intervention<div class="muted small">${(d.profile.service_cities || []).includes('*') ? 'Toutes les villes autorisées par l’administration' : esc((d.profile.service_cities || []).join(' • ') || d.profile.service_city || USER.ville || 'À choisir')}</div></div><span class="mi-arr">›</span></div>
    <div class="menu-item" onclick="nav('#/pro-edit')"><span class="mi-ic">✏️</span>Mon profil professionnel<span class="mi-arr">›</span></div>
    ${cc && cc.visibilite.enabled ? `<div class="menu-item" onclick="nav('#/visibilite')"><span class="mi-ic">⭐</span>Améliorer ma visibilité <span class="muted small">(facultatif)</span><span class="mi-arr">›</span></div>` : ''}
    ${cc && cc.pub.enabled ? `<div class="menu-item" onclick="nav('#/pub')"><span class="mi-ic">📣</span>Promouvoir mon activité (publicité)<span class="mi-arr">›</span></div>` : ''}
  </div>${bottomNav('account')}`;
  updateBadges();
}

routes['pro-edit'] = async () => {
  if (!USER || USER.pro_status !== 'approved') { nav('#/pro'); return; }
  SERVICES = await api('/services' + (USER && USER.ville ? '?ville=' + encodeURIComponent(USER.ville) : ''));
  try { GRAND_CATEGORIES = await api('/grand-categories'); } catch { GRAND_CATEGORIES = []; }
  try { PRO_SKILLS = await api('/pro-skill-catalogue'); } catch { PRO_SKILLS = []; }
  const p = USER.pro;
  const estEnt = p.pro_type === 'entreprise';
  $app.innerHTML = `${header('Mon profil professionnel')}
  <div class="content"><div class="card">
    <div class="bold mb">${estEnt ? '🏢 Compte Entreprise' : '👤 Compte Particulier'}</div>
    ${estEnt ? `
    <div class="field"><label>Nom de l'entreprise</label><input type="text" id="p-cname" value="${esc(p.company_name || '')}"></div>
    <div class="field"><label>Registre de commerce (RCCM)</label><input type="text" id="p-rccm" value="${esc(p.company_rccm || '')}"></div>
    <div class="field"><label>Taille de l'équipe</label><select id="p-csize">
      ${['','2 à 5 personnes','6 à 10 personnes','11 à 50 personnes','Plus de 50 personnes'].map(v => `<option value="${esc(v)}" ${p.company_size === v ? 'selected' : ''}>${v || 'Choisir…'}</option>`).join('')}
    </select></div>` : ''}
    <div class="field"><label>${estEnt ? "Domaine d'activité" : 'Profession'}</label><input type="text" id="p-prof" value="${esc(p.profession)}"></div>
    <div class="field"><label>Mes compétences : catégories et sous-catégories</label>
      <div class="muted small mb">Toute modification est envoyée à l’administration pour validation. Les compétences déjà autorisées restent actives jusque-là.</div>
      <div id="p-domains">${proSkillPicker(p.authorized_subcategories || p.selected_subcategories || [])}</div></div>
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
          zone: document.getElementById('p-zone').value, experience: document.getElementById('p-exp').value,
          description: document.getElementById('p-desc').value,
          company_name: document.getElementById('p-cname') ? document.getElementById('p-cname').value : null,
          company_rccm: document.getElementById('p-rccm') ? document.getElementById('p-rccm').value : null,
          company_size: document.getElementById('p-csize') ? document.getElementById('p-csize').value : null
        }
      });
      const selectedSubs=selectedProSubcategories();
      const currentSubs=(p.authorized_subcategories || p.selected_subcategories || []).map(Number).sort((a,b)=>a-b);
      const wantedSubs=[...new Set(selectedSubs)].sort((a,b)=>a-b);
      if (JSON.stringify(currentSubs)!==JSON.stringify(wantedSubs)) {
        await api('/pro/domain-change-request', { method: 'POST', body: { selected_subcategories:wantedSubs } });
        toast('Profil mis à jour ✓ Demande de nouvelles compétences envoyée à l’administration.', 'ok');
      } else toast('Profil mis à jour ✓', 'ok');
      back();
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
      ${p.documents_valides ? '<span class="pill ok">📄 Documents fournis</span>' : ''}
      ${p.mis_en_avant ? '<span class="pill ok">⭐ Mis en avant</span>' : ''}</div>
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

/* ---------- Visibilité professionnelle (FACULTATIVE : le profil normal reste gratuit) ---------- */
routes.visibilite = async () => {
  if (!USER) { nav('#/login'); return; }
  let v;
  try { v = await api('/visibilite'); } catch (e) { toast(e.message, 'err'); back(); return; }
  const stLbl = { attente_paiement: ['warn', '⏳ En attente de paiement'], active: ['ok', '🟢 Active'], expiree: ['warn', 'Expirée'], annulee: ['warn', 'Annulée'] };
  $app.innerHTML = `${header('Améliorer ma visibilité')}
  <div class="content">
    <div class="card"><div class="small">⭐ Option <b>facultative</b> : votre profil professionnel reste entièrement gratuit et continue de recevoir des missions normalement. La visibilité payante met simplement votre profil en avant.</div></div>
    ${!v.enabled ? `<div class="status-banner info">La visibilité payante n'est pas proposée pour le moment.</div>` : ''}
    ${v.niveau_actuel ? `<div class="status-banner ok">⭐ Votre profil est actuellement mis en avant (niveau ${v.niveau_actuel}).</div>` : ''}
    ${v.enabled ? v.plans.map(pl => `<div class="card">
      <div class="row"><div class="grow"><div class="bold">${esc(pl.name)}</div>
        <div class="small muted">${esc(pl.avantages || '')}</div>
        <div class="small mt"><b>${pl.price.toLocaleString('fr-FR')} ${esc(v.devise)}</b> pour ${pl.duration_days} jours</div></div></div>
      <button class="btn sm mt" onclick="A.visSub(${pl.id},'${esc(pl.name)}',${pl.price},this)">Choisir cette formule</button>
    </div>`).join('') : ''}
    ${v.subs.length ? `<div class="sec-title">Mes souscriptions</div>` + v.subs.map(sb => `<div class="card"><div class="row">
      <div class="grow"><div class="bold">${esc(sb.plan_name)}</div><div class="small muted">${sb.price.toLocaleString('fr-FR')} ${esc(v.devise)} • ${sb.duration_days} j${sb.end_at ? ' • jusqu\u2019au ' + fmtDate(sb.end_at) : ''}</div></div>
      <span class="pill ${(stLbl[sb.status] || ['warn'])[0]}">${(stLbl[sb.status] || ['', sb.status])[1]}</span></div></div>`).join('') : ''}
  </div>${bottomNav('account')}`;
};

/* ---------- Campagnes publicitaires (annonceurs) ---------- */
routes.pub = async () => {
  if (!USER) { nav('#/login'); return; }
  let v;
  try { v = await api('/pub'); } catch (e) { toast(e.message, 'err'); back(); return; }
  const stLbl = {
    brouillon: ['warn', 'Brouillon'], attente_paiement: ['warn', '⏳ En attente de paiement'], paiement_confirme: ['ok', 'Paiement confirmé'],
    attente_validation: ['warn', '🔍 En attente de validation'], validee: ['warn', '📋 Validée — en file d\u2019attente'],
    active: ['ok', '🟢 En diffusion'], suspendue: ['warn', '⏸ Suspendue'], refusee: ['bad', 'Refusée'], expiree: ['warn', 'Expirée']
  };
  $app.innerHTML = `${header('Promouvoir mon activité')}
  <div class="content">
    ${!v.enabled ? `<div class="status-banner info">Les campagnes publicitaires ne sont pas proposées pour le moment.</div>`
    : `<div class="card"><div class="bold mb">📣 Faites connaître votre activité</div>
      <div class="small muted">Votre publicité (texte, image ou vidéo) sera diffusée sur l'écran d'accueil après paiement et validation par Klean Services.</div>
      <button class="btn mt" onclick="A.pubForm()">＋ Créer une campagne</button></div>`}
    ${v.campagnes.length ? `<div class="sec-title">Mes campagnes</div>` + v.campagnes.map(c => `<div class="card">
      <div class="row"><div class="grow"><div class="bold">${esc(c.title)}</div>
        <div class="small muted">Budget : ${c.budget.toLocaleString('fr-FR')} ${esc(v.devise)} • ${c.duration_days} j • ${esc(c.type)}${c.zone ? ' • ' + esc(c.zone) : ''}</div>
        ${c.end_at && c.status === 'active' ? `<div class="small muted">Jusqu'au ${fmtDate(c.end_at)}</div>` : ''}
        ${c.note_admin ? `<div class="small mt">Note de l'administration : ${esc(c.note_admin)}</div>` : ''}</div>
      <span class="pill ${(stLbl[c.status] || ['warn'])[0]}">${(stLbl[c.status] || ['', c.status])[1]}</span></div></div>`).join('') : ''}
  </div>${bottomNav('account')}`;
};

/* ---------- Avis de recherche ---------- */
routes['avis-recherche'] = async () => {
  const saved = JSON.parse(sessionStorage.getItem('ks_avis_filters') || '{}');
  let list = [], categories = [];
  try { [list, categories] = await Promise.all([api('/avis-recherche'), api('/avis-recherche/categories')]); } catch (e) { toast(e.message, 'err'); }
  const filtered = list.filter(a => (!saved.category_id || Number(a.category_id) === Number(saved.category_id))
    && (!saved.q || normalize([a.nom,a.description,a.infos,a.city,a.dernier_lieu,a.category_name].join(' ')).includes(normalize(saved.q)))
    && (!saved.city || normalize([a.city,a.dernier_lieu].join(' ')).includes(normalize(saved.city))));
  $app.innerHTML = `${header('Avis de recherche', { bell: !!USER })}
  <div class="content">
    <button class="btn mb" onclick="A.avisForm()">📢 Publier un avis de recherche</button>
    <div class="card compact-card"><div class="bold small mb">Rechercher des avis</div>
      <div class="field"><select id="avis-cat"><option value="">Toutes les catégories</option>${categories.map(c=>`<option value="${c.id}" ${Number(saved.category_id)===Number(c.id)?'selected':''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="searchbar"><input type="search" id="avis-q" placeholder="Personne, objet, lieu…" value="${esc(saved.q || '')}"><button onclick="A.avisSearch()">🔍</button></div>
      <div class="field"><input type="text" id="avis-city" readonly onclick="A.villePick('avis-city')" placeholder="📍 Filtrer par ville" value="${esc(saved.city || '')}" style="cursor:pointer;background:#fff"></div>
      <button class="btn sec sm" onclick="A.avisSearch()">Appliquer les filtres</button></div>
    ${filtered.length ? filtered.map(a => `<div class="card" ${a.paid && a.formule === 'urgent' ? 'style="border:2px solid #dc2626"' : ''}>
      ${a.status === 'pending' && a.publisher ? '<span class="pill warn">En attente de validation</span>' : ''}
      ${a.paid && a.formule === 'urgent' ? '<span class="pill bad">🚨 URGENT</span>' : a.paid && a.formule === 'avant' ? '<span class="pill ok">⭐ Mis en avant</span>' : ''}
      <div class="row">${a.photo ? `<img src="${esc(mediaUrl(a.photo))}" style="width:72px;height:72px;border-radius:10px;object-fit:cover" alt="Photo de l’avis">` : ''}
        <div class="grow"><div class="small muted">📌 ${esc(a.category_name || 'Avis de recherche')}</div><div class="bold">${esc(a.nom)}</div>
        ${a.city ? `<div class="small">📍 ${esc(a.city)}</div>` : a.dernier_lieu ? `<div class="small">📍 ${esc(a.dernier_lieu)}</div>` : ''}</div></div>
      ${a.date_disparition ? `<div class="small mt">Date / période : ${esc(a.date_disparition)} ${esc(a.heure_disparition || '')}</div>` : ''}
      ${a.description ? `<div class="small mt">${esc(a.description)}</div>` : ''}
      ${a.derniere_vue ? `<div class="small mt">Vu(e) pour la dernière fois : ${esc(a.derniere_vue)}</div>` : ''}
      ${a.description_physique ? `<div class="small mt">Description : ${esc(a.description_physique)}</div>` : ''}
      ${a.vetements ? `<div class="small">Vêtements : ${esc(a.vetements)}</div>` : ''}
      ${a.infos ? `<div class="small mt">${esc(a.infos)}</div>` : ''}
      ${a.contact ? `<div class="small mt bold">📞 Contact autorisé : <a href="tel:${esc(a.contact)}">${esc(a.contact)}</a></div>` : `<button class="btn sec sm mt" onclick="authRequired('#/avis-recherche')">Se connecter pour contacter</button>`}
      ${USER && a.user_id !== USER.id ? `<button class="btn ghost sm mt" onclick="A.reportNotice(${Number(a.user_id)},${Number(a.id)})">⚠️ Signaler cet avis</button>` : ''}
    </div>`).join('') : emptyState('📢', saved.q || saved.category_id || saved.city ? 'Aucun avis ne correspond à ces filtres.' : 'Aucun avis de recherche publié.')}
  </div>${bottomNav('account')}`;
  const q=document.getElementById('avis-q'); q.addEventListener('keydown',e=>{if(e.key==='Enter')A.avisSearch();});
};

/* ---------- Trouver ou proposer un job ---------- */
routes.jobs = async () => {
  const q = sessionStorage.getItem('ks_jobq') || '';
  let offers = [], profiles = [];
  try { [offers, profiles] = await Promise.all([api('/job-offers' + (q ? '?q=' + encodeURIComponent(q) : '')), api('/jobs' + (q ? '?q=' + encodeURIComponent(q) : ''))]); } catch (e) { toast(e.message, 'err'); }
  $app.innerHTML = `${header('Trouver ou proposer un job', { bell: !!USER })}
  <div class="content">
    <div class="job-actions"><button class="btn" onclick="A.jobOfferForm()">＋ Proposer un job</button><button class="btn sec" onclick="A.jobProfileForm()">Publier mon profil candidat</button></div>
    <div class="searchbar"><input type="search" id="job-q" placeholder="🔎 Métier, compétence, ville…" value="${esc(q)}"><button onclick="A.jobSearch()">🔍</button></div>
    <div class="sec-title">Trouver un job — offres disponibles</div>
    ${offers.length ? offers.map(o=>`<div class="card">
      ${o.status === 'pending' ? '<span class="pill warn">Mon offre en attente de validation</span>' : o.status === 'rejected' ? '<span class="pill bad">Mon offre non publiée</span>' : o.status === 'closed' ? '<span class="pill info">Offre clôturée</span>' : ''}
      <div class="bold">${esc(o.title)}</div><div class="muted small">Publié par ${esc(o.publisher)}${o.city ? ' • 📍 '+esc(o.city) : ''}</div>
      <div class="small mt">${esc(o.description)}</div>${o.skills?`<div class="small mt"><b>Compétences :</b> ${esc(o.skills)}</div>`:''}
      ${o.location?`<div class="small"><b>Lieu :</b> ${esc(o.location)}</div>`:''}${o.contract_type?`<div class="small"><b>Type :</b> ${esc(o.contract_type)}</div>`:''}${o.duration?`<div class="small"><b>Durée / période :</b> ${esc(o.duration)}</div>`:''}${o.compensation?`<div class="small"><b>Rémunération :</b> ${esc(o.compensation)}</div>`:''}
      ${o.contact ? `<div class="small mt bold">Candidature : <a href="tel:${esc(o.contact)}">${esc(o.contact)}</a></div>${o.application_method?`<div class="small muted">${esc(o.application_method)}</div>`:''}` : `<button class="btn sec sm mt" onclick="authRequired('#/jobs')">Se connecter pour contacter</button>`}
    </div>`).join('') : emptyState('💼','Aucune offre de job disponible pour le moment.')}
    <div class="sec-title">Profils de candidats</div><div class="hint">Ces profils historiques restent disponibles pour les personnes qui souhaitent recruter directement.</div>
    ${profiles.length ? profiles.map(j => `<div class="card">
      ${j.status === 'pending' ? '<span class="pill warn">En attente de validation</span>' : ''}
      ${j.boost && j.boost !== 'normal' && (!j.boost_until || j.boost_until >= new Date().toISOString().slice(0, 19).replace('T', ' ')) ? `<span class="pill ok">⭐ ${j.boost === 'prioritaire' ? 'Profil prioritaire' : 'Mis en avant'}</span>` : ''}
      <div class="row">${avatar({ name: j.publisher, photo: j.photo })}<div class="grow"><div class="bold">${esc(j.metier)}</div><div class="muted small">${esc(j.publisher)}${j.localisation ? ' • '+esc(j.localisation) : ''}</div></div></div>
      ${j.competences ? `<div class="small mt"><b>Compétences :</b> ${esc(j.competences)}</div>` : ''}${j.experience ? `<div class="small"><b>Expérience :</b> ${esc(j.experience)}</div>` : ''}${j.disponibilite ? `<div class="small"><b>Disponibilité :</b> ${esc(j.disponibilite)}</div>` : ''}${j.description ? `<div class="small mt">${esc(j.description)}</div>` : ''}
      ${j.contact ? `<div class="small mt bold">📞 <a href="tel:${esc(j.contact)}">${esc(j.contact)}</a></div>` : `<button class="btn sec sm mt" onclick="authRequired('#/jobs')">Se connecter pour contacter</button>`}${USER && j.user_id === USER.id && (!j.boost || j.boost === 'normal') ? `<button class="btn outline sm mt" onclick="A.jobBoost(${j.id})">⭐ Mettre mon profil en avant (facultatif)</button>` : ''}
    </div>`).join('') : emptyState('👤','Aucun profil candidat publié pour le moment.')}
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

/* ---------- Urgences ---------- */
routes.urgence = async () => {
  let cfg = { info: '', contacts: [], categories: [], assistance_available: false };
  try { cfg = await api('/urgence/config'); } catch { }
  const available = !!cfg.assistance_available;
  $app.innerHTML = `${header('Urgences', { bell: !!USER })}
  <div class="content">
    <div class="status-banner ${available ? 'warn' : 'bad'}"><b>${available ? 'Assistance Klean Services disponible' : 'Assistance Klean Services indisponible'}</b>${cfg.info ? `<div class="small mt">${esc(cfg.info)}</div>` : `<div class="small mt">Aucune disponibilité n’est actuellement configurée.</div>`}</div>
    <div class="card emergency-disclaimer"><b>Information importante</b><div class="small">Klean Services ne remplace pas les secours publics. En cas de danger immédiat, contactez uniquement les services publics officiels dont le numéro est vérifié dans votre zone.</div></div>
    <div class="sec-title">Services et catégories disponibles</div>
    ${cfg.categories && cfg.categories.length ? cfg.categories.map(c=>`<div class="menu-item"><span class="mi-ic">🚨</span><div><b>${esc(c.name)}</b>${c.description?`<div class="small muted">${esc(c.description)}</div>`:''}</div></div>`).join('') : `<div class="hint">Aucun service d’assistance n’est configuré actuellement.</div>`}
    <div class="sec-title">Urgences vitales</div>
    ${cfg.contacts && cfg.contacts.filter(c=>c.group==='vital').length ? cfg.contacts.filter(c=>c.group==='vital').map(c => `<a class="menu-item" href="tel:${esc(c.tel)}" style="text-decoration:none;color:inherit"><span class="mi-ic">📞</span><div><b>${esc(c.nom)}</b>${c.label?`<div class="small muted">${esc(c.label)}</div>`:''}<div class="small muted">${esc(c.source_name)}${c.source_date ? ' · ' + esc(c.source_date) : ''}<br>Vérifié le ${esc(c.verified_at)}${c.last_modified ? ' · mis à jour le ' + esc(c.last_modified) : ''}</div></div><span class="mi-arr bold">${esc(c.tel)}</span></a>`).join('') : `<div class="hint">Aucun contact officiel n’est disponible. Aucun numéro n’est inventé.</div>`}
    <div class="sec-title">Services publics et assistance</div>
    ${cfg.contacts && cfg.contacts.filter(c=>c.group==='public_assistance').length ? cfg.contacts.filter(c=>c.group==='public_assistance').map(c => `<a class="menu-item" href="tel:${esc(c.tel)}" style="text-decoration:none;color:inherit"><span class="mi-ic">📞</span><div><b>${esc(c.nom)}</b>${c.label?`<div class="small muted">${esc(c.label)}</div>`:''}<div class="small muted">${esc(c.source_name)}${c.source_date ? ' · ' + esc(c.source_date) : ''}<br>Vérifié le ${esc(c.verified_at)}${c.last_modified ? ' · mis à jour le ' + esc(c.last_modified) : ''}</div></div><span class="mi-arr bold">${esc(c.tel)}</span></a>`).join('') : `<div class="hint">Aucun service public officiel n’est disponible.</div>`}
    ${available ? `<button class="sos-btn" onclick="A.sosConfirm()">🚨 DEMANDER UNE ASSISTANCE</button><div class="muted small center">Une confirmation vous sera demandée. Cette demande est envoyée à l’équipe Klean Services, pas aux secours publics.</div>` : ''}
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
      <input type="text" id="i-ville" placeholder="👆 Choisir ma ville" readonly style="cursor:pointer;background:#fff" value="${esc(USER.ville || '')}" onclick="A.villePick('i-ville')">
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
      <div class="small muted mt">Aperçu : <span style="font-size:${font}px">Klean Services — tous vos services à portée de main.</span></div>
    </div>
    <div class="card">
      <div class="switch"><div><div class="bold small">🔊 Son des notifications</div><div class="muted small">Jouer un son à chaque notification</div></div>
      <button class="chip ${sound ? 'on' : ''}" onclick="A.toggleSound(this)">${sound ? 'Activé' : 'Désactivé'}</button></div>
    </div>
    <div class="card muted small">
      <b>Klean Services</b><br>Version 2.0 — Tous vos services à portée de main.<br>
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

/* ---------- Bandeau fixe en bas de l'accueil : publicités, informations, urgences ---------- */
let BD_TIMER = null, BD_JSON = '';
const BD_TYPES = { pub: { ic: '📢', lb: 'Pub' }, info: { ic: 'ℹ️', lb: 'Info' }, urgence: { ic: '🚨', lb: 'Urgence' } };
async function bandeauMount() {
  if (BD_TIMER) { clearInterval(BD_TIMER); BD_TIMER = null; }
  BD_JSON = '';
  await bandeauRender();
  // Synchronisation : tout changement fait dans le tableau de bord (type, thème, message,
  // activation, ordre, vitesse) est répercuté sur l'accueil sans recharger la page.
  BD_TIMER = setInterval(() => {
    if (!document.getElementById('bandeau-host')) { clearInterval(BD_TIMER); BD_TIMER = null; return; }
    bandeauRender();
  }, 12000);
}
async function bandeauRender() {
  const host = document.getElementById('bandeau-host');
  if (!host) return;
  let b;
  try { b = await api('/annonces'); } catch { return; }
  const j = JSON.stringify(b);
  if (j === BD_JSON && host.innerHTML) return; // rien n'a changé : on ne casse pas l'animation en cours
  BD_JSON = j;
  const espace = document.getElementById('bandeau-espace');
  if (!b.enabled || !b.items.length) { host.innerHTML = ''; if (espace) espace.style.height = '0'; return; }
  // Préfixe généré automatiquement selon le type : 📢 Pub (Thème) : … | ℹ️ Info (Thème) : … | 🚨 Urgence (Thème) : …
  const item = a => { const t = BD_TYPES[a.type] || BD_TYPES.info;
    return `<span ${a.link ? `data-link="${esc(a.link)}" onclick="A.bandeauGo(this.dataset.link)"` : ''}
    style="display:inline-flex;align-items:center;gap:7px;padding:0 20px;cursor:${a.link ? 'pointer' : 'default'};color:${esc(a.color || '#ffffff')}">
    <b style="${(a.type || 'info') === 'urgence' ? 'color:#ff6b6b' : ''}">${t.ic} ${t.lb}${(a.theme || '').trim() ? ' (' + esc(a.theme.trim()) + ')' : ''} :</b>
    <span style="opacity:.92">${esc(a.content || a.title || '')}</span>
    <span style="opacity:.35;padding-left:20px">◆</span></span>`; };
  const bloc = b.items.map(item).join('');
  host.innerHTML = `
  <style>@keyframes ksdefile{from{transform:translateX(0)}to{transform:translateX(-50%)}}
  #bandeau-int:hover,#bandeau-int:active{animation-play-state:paused}</style>
  <div style="position:fixed;bottom:calc(57px + var(--safe-b, 0px));left:50%;transform:translateX(-50%);width:100%;max-width:560px;z-index:49;background:#0b1320;border-top:2px solid #16a34a;overflow:hidden;height:34px;display:flex;align-items:center">
    <div id="bandeau-int" style="display:inline-flex;white-space:nowrap;will-change:transform;font-size:13.5px;color:#fff">${bloc}${bloc}${bloc}${bloc}</div>
  </div>`;
  if (espace) espace.style.height = '42px'; // le bandeau ne masque jamais le contenu
  requestAnimationFrame(() => {
    const int = document.getElementById('bandeau-int');
    if (!int) return;
    const demiLargeur = int.scrollWidth / 2;
    int.style.animation = `ksdefile ${Math.max(6, demiLargeur / b.speed)}s linear infinite`; // vitesse en pixels/seconde, fluide
  });
}

/* ---------- Quiz synchronisé sur l'accueil ---------- */
let QL_TIMER = null, QL_ETAT = null, QL_TICK = 0;
function qlStop() { if (QL_TIMER) { clearInterval(QL_TIMER); QL_TIMER = null; } }
async function quizLiveMount() {
  qlStop();
  if (!document.getElementById('quiz-live') || !USER || !GAMES.quiz) return;
  await qlSync();
  QL_TICK = 0;
  QL_TIMER = setInterval(() => {
    if (!document.getElementById('quiz-live')) { qlStop(); return; } // on a quitté l'accueil
    QL_TICK++;
    const live = QL_ETAT && QL_ETAT.live;
    if (live && !live.paused) { // décompte local seconde par seconde
      if (live.phase === 'question') { live.remaining_ms -= 1000; if (live.remaining_ms <= 300) { qlSync(); return; } }
      else { live.next_in_ms -= 1000; if (live.next_in_ms <= 300) { qlSync(); return; } }
    }
    if (QL_TICK % 5 === 0) { qlSync(); return; } // re-synchronisation serveur toutes les 5 s
    qlRender();
  }, 1000);
}
async function qlSync() {
  try { QL_ETAT = await api('/games/concours'); } catch { QL_ETAT = null; }
  qlRender();
}
function qlRender() {
  const box = document.getElementById('quiz-live');
  if (!box) return;
  const e = QL_ETAT;
  if (!e || !e.enabled || !e.session || !e.allowed) { box.innerHTML = ''; return; }
  const s = e.session;
  const carte = inner => `<div class="card" style="border:2px solid #16a34a;margin-top:8px">${inner}</div>`;
  if (s.status === 'terminee') {
    if (!e.participant) { box.innerHTML = ''; return; }
    box.innerHTML = carte(`<div class="center">🏁 <b>Quiz « ${esc(s.title)} » terminé.</b><br>
      <button class="btn sec mt" onclick="nav('#/quiz')">Voir mes résultats ${e.est_gagnant ? '🏆' : ''}</button></div>`);
    return;
  }
  const live = e.live;
  if (!live) { box.innerHTML = ''; return; }
  if (live.paused) { box.innerHTML = carte(`<div class="center"><div style="font-size:32px">⏸️</div><b>Quiz en pause</b><div class="small muted mt">La chronologie est figée par l’administration. Restez sur l’accueil : le quiz reprendra automatiquement.</div><div class="small muted mt">👥 ${s.counts ? (s.counts.in_competition ?? s.counts.participants) : 0} en lice • 👁️ ${s.counts ? s.counts.spectators : 0} spectateur(s)</div></div>`); return; }
  const letters = ['A', 'B', 'C', 'D'];
  if (live.phase === 'question') {
    const secs = Math.max(0, Math.ceil(live.remaining_ms / 1000));
    const etatTxt = live.eliminated
      ? '<div class="small center bold" style="color:#6b7280">👁️ Vous êtes éliminé(e), mais vous pouvez suivre le reste du concours en mode spectateur.</div>'
      : live.answered
        ? '<div class="small center bold" style="color:#16a34a">✅ Réponse envoyée — verrouillée. Résultat à la fin du décompte.</div>'
      : live.spectator
        ? '<div class="small center bold" style="color:#6b7280">👁️ Mode spectateur — vous ne pouvez plus répondre, mais vous suivez tout.</div>'
        : '<div class="small muted center">Une seule réponse possible — elle sera verrouillée.</div>';
    box.innerHTML = carte(`
      <div class="small muted center">🧠 QUIZ EN DIRECT • « ${esc(s.title)} » • Question ${live.index + 1} / ${live.total}<br>👥 ${s.counts ? (s.counts.in_competition ?? s.counts.participants) : 0} en lice • 👁️ ${s.counts ? s.counts.spectators : 0} spectateur(s)</div>
      <div class="center" style="margin:2px 0">
        <span style="font-size:38px;font-weight:800;line-height:1;color:${secs <= 5 ? '#dc2626' : '#16a34a'}">${secs}</span>
        <span class="small muted"> seconde(s)</span></div>
      <div style="height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;margin-bottom:10px">
        <div style="height:100%;background:${secs <= 5 ? '#dc2626' : '#16a34a'};width:${Math.min(100, live.remaining_ms / (live.time_per_q * 10))}%"></div></div>
      <div class="bold mb" style="font-size:16px">${esc(live.question ? live.question.question : '')}</div>
      ${(live.question ? live.question.options : []).map((o, j) => {
        const choisi = live.answered && live.my_answer === j;
        const inactif = live.answered || live.spectator;
        return `<button type="button" ${inactif ? 'disabled' : ''} onclick="A.qlRepondre(${s.id},${live.index},${j})"
          style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:${choisi ? '#f0fdf4' : '#fff'};
          border:2px solid ${choisi ? '#16a34a' : '#e5e7eb'};border-radius:12px;padding:11px;margin-bottom:7px;font-size:15px;
          ${inactif ? 'opacity:' + (choisi ? '1' : '0.55') + ';cursor:default' : 'cursor:pointer'}">
          <span style="flex:0 0 26px;height:26px;border-radius:50%;background:#f3f4f6;display:flex;align-items:center;justify-content:center;font-weight:700">${letters[j]}</span>
          <span>${esc(o)}</span>${choisi ? '<span style="margin-left:auto">🔒</span>' : ''}</button>`;
      }).join('')}
      ${etatTxt}`);
    return;
  }
  // Pause : révélation du résultat + décompte avant le prochain quiz
  const secs = Math.max(0, Math.ceil(live.next_in_ms / 1000));
  const r = live.reveal || {};
  const maRep = r.my_answer == null
    ? '<span style="color:#6b7280">Vous n\u2019avez pas répondu à ce quiz.</span>'
    : r.my_correct
      ? `<span style="color:#16a34a">Votre réponse : <b>${letters[r.my_answer]}</b> — ✅ bonne réponse !</span>`
      : `<span style="color:#dc2626">Votre réponse : <b>${letters[r.my_answer]}</b> — ❌ mauvaise réponse.</span>`;
  box.innerHTML = carte(`
    <div class="small muted center">🧠 QUIZ EN DIRECT • « ${esc(s.title)} » • Résultat du quiz ${live.index + 1} / ${live.total}</div>
    <div class="small mb" style="margin-top:6px">${esc(r.question || '')}</div>
    <div class="bold small mb" style="color:#16a34a">✔️ Bonne réponse : ${letters[r.correct] || ''} — ${esc((r.options || [])[r.correct] || '')}</div>
    <div class="small mb">${maRep}</div>
    ${live.spectator_next ? '<div class="small bold" style="color:#6b7280">👁️ Vous suivez la suite en mode spectateur (seuls les bons répondants continuent).</div>' : '<div class="small bold" style="color:#16a34a">🎯 Vous continuez ! Préparez-vous…</div>'}
    <div class="center" style="margin-top:8px">⏳ Prochain quiz dans
      <span style="font-size:30px;font-weight:800;color:#2563eb"> ${secs}</span>
      <span class="small muted"> seconde(s)</span></div>`);
}

/* ---------- Jeux ---------- */
let QUIZ_TIMER = null;
function quizStopTimer() { if (QUIZ_TIMER) { clearInterval(QUIZ_TIMER); QUIZ_TIMER = null; } }

routes.quiz = async () => {
  if (!USER) { nav('#/login'); return; }
  quizStopTimer();
  let etat;
  try { etat = await api('/games/concours'); } catch (e) { toast(e.message, 'err'); back(); return; }
  if (!etat.enabled) { toast('Le quiz est désactivé.', 'err'); back(); return; }

  // Le QCM et le concours sont un seul système : hors session, il n'existe pas de quiz parallèle.
  if (!etat.session) { $app.innerHTML = `${header('Quiz')}<div class="content"><div class="card center"><div style="font-size:42px">🧠</div><div class="bold mb">Aucun quiz en direct pour le moment.</div><div class="small muted mb">Les questions QCM sont utilisées dans les sessions synchronisées lancées par Klean Services. Revenez bientôt !</div><button class="btn sec" onclick="back()">Retour</button></div></div>${bottomNav('home')}`; return; }
  const s = etat.session, p = etat.participant;

  // Public non autorisé
  if (!etat.allowed && !p) {
    const motif = etat.reason || (etat.audience === 'clients_servis'
      ? 'Ce quiz est réservé aux clients ayant déjà bénéficié d\u2019un service sur Klean Services. Commandez votre premier service pour pouvoir participer !'
      : 'Ce quiz est réservé aux clients.');
    $app.innerHTML = `${header('Quiz')}<div class="content"><div class="card center">
      <div style="font-size:44px">🔒</div><div class="bold mb">${motif}</div>
      <button class="btn sec" onclick="back()">Retour</button></div></div>${bottomNav('home')}`;
    return;
  }

  // ----- Série en cours : la question s'affiche automatiquement sur l'accueil -----
  if (s.status === 'en_cours') { nav('#/home'); return; }

  // ----- Session terminée : résultats -----
  if (s.status === 'terminee') {
    if (etat.est_gagnant) { quizEcranGagnant(s, p, etat.messages || []); return; }
    $app.innerHTML = `${header('Quiz — résultats')}<div class="content"><div class="card center">
      <div style="font-size:44px">${p && p.status === 'elimine' ? '❌' : '🙂'}</div>
      <div class="bold mb">Le quiz « ${esc(s.title)} » est terminé.</div>
      <div class="small muted mb">${p && p.status === 'elimine' ? 'Vous avez été éliminé(e) en cours de partie.' : `Votre score : ${p ? p.score : 0} bonne(s) réponse(s).`}</div>
      <div class="small muted mb">${s.winners_designated ? 'Les gagnants ont été désignés. Merci d\u2019avoir participé !' : 'Les gagnants seront annoncés par l\u2019administration.'}</div>
      <button class="btn sec" onclick="back()">Retour</button></div></div>${bottomNav('home')}`;
    return;
  }

  // ----- Session en cours -----
  if (!p) { // participation automatique : le quiz s'affiche directement, le décompte démarre
    try { await api(`/games/concours/${s.id}/rejoindre`, { method: 'POST' }); }
    catch (err) { toast(err.message, 'err'); back(); return; }
    quizQuestion(s);
    return;
  }
  if (p.status === 'elimine') {
    $app.innerHTML = `${header('Quiz')}<div class="content"><div class="card center">
      <div style="font-size:44px">❌</div><div class="bold mb">Vous avez été éliminé(e).</div>
      <div class="small muted mb">Score : ${p.score} bonne(s) réponse(s). Merci d\u2019avoir participé — restez à l\u2019affût du prochain quiz !</div>
      <button class="btn sec" onclick="back()">Retour</button></div></div>${bottomNav('home')}`;
    return;
  }
  if (p.status !== 'en_lice') { // finaliste : réponses enregistrées
    $app.innerHTML = `${header('Quiz')}<div class="content"><div class="card center">
      <div style="font-size:44px">✅</div><div class="bold mb">Vos réponses sont enregistrées !</div>
      <div class="small muted mb">Score : ${p.score} / ${s.nb_questions}. Les résultats seront annoncés à la fin du quiz. Vous recevrez une notification si vous gagnez 🤞</div>
      <button class="btn sec" onclick="back()">Retour</button></div></div>${bottomNav('home')}`;
    return;
  }
  quizQuestion(s); // en lice : question en cours
};

// Affiche la question en cours avec décompte visible et fermeture automatique à 0
async function quizQuestion(s) {
  quizStopTimer();
  let q;
  try { q = await api(`/games/concours/${s.id}/question`); } catch (e) { toast(e.message, 'err'); routes.quiz(); return; }
  if (q.done) { routes.quiz(); return; }
  const letters = ['A', 'B', 'C', 'D'];
  $app.innerHTML = `${header('🧠 Quiz — question ' + (q.index + 1) + '/' + q.total)}
  <div class="content">
    <div class="card">
      <div class="small muted center" style="margin-bottom:4px">🧠 « ${esc(s.title)} » • Question ${q.index + 1} / ${q.total}${s.elimination ? ' • ⚠️ élimination directe' : ''}</div>
      <div class="center" style="margin-bottom:4px">
        <span id="qz-timer" style="font-size:40px;font-weight:800;color:#16a34a;line-height:1">${Math.ceil(q.remaining_ms / 1000)}</span>
        <span class="small muted"> seconde(s)</span>
      </div>
      <div style="height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;margin-bottom:12px">
        <div id="qz-bar" style="height:100%;background:#16a34a;width:100%;transition:width 1s linear"></div></div>
      <div class="bold mb" style="font-size:17px">${esc(q.question.question)}</div>
      ${q.question.options.map((o, j) => `<button type="button" class="qz-opt" data-j="${j}" onclick="A.quizRepondre(${s.id},${j})"
        style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:#fff;border:2px solid #e5e7eb;border-radius:12px;padding:12px;margin-bottom:8px;font-size:15px;cursor:pointer">
        <span style="flex:0 0 28px;height:28px;border-radius:50%;background:#f3f4f6;display:flex;align-items:center;justify-content:center;font-weight:700">${letters[j]}</span>
        <span>${esc(o)}</span></button>`).join('')}
      <div class="small muted center">Une seule réponse possible — elle est enregistrée immédiatement.</div>
    </div></div>${bottomNav('home')}`;
  const deadline = Date.now() + q.remaining_ms;
  window._qzLock = false;
  QUIZ_TIMER = setInterval(() => {
    const left = Math.max(0, deadline - Date.now());
    const el = document.getElementById('qz-timer'), bar = document.getElementById('qz-bar');
    if (!el) { quizStopTimer(); return; }
    el.textContent = Math.ceil(left / 1000);
    if (left <= 5000) el.style.color = '#dc2626';
    if (bar) { bar.style.width = (left / (q.time_per_q * 1000) * 100) + '%'; if (left <= 5000) bar.style.background = '#dc2626'; }
    if (left <= 0) { quizStopTimer(); A.quizRepondre(s.id, -1); } // fermeture automatique à 0
  }, 250);
}

// Écran gagnant : animation légère 🎉🏆 (visible uniquement par le gagnant) + bulle de contact + photo
function quizEcranGagnant(s, p, messages) {
  const confetti = Array.from({ length: 14 }, (_, i) =>
    `<span style="position:absolute;top:-30px;left:${(i * 7.3) % 100}%;font-size:${14 + (i % 3) * 6}px;animation:qzfall ${2.5 + (i % 5) * 0.6}s linear ${(i % 7) * 0.4}s 3">${['🎉', '🎊', '🏆', '⭐'][i % 4]}</span>`).join('');
  const demandePhoto = p.photo_asked && !p.photo_consent;
  $app.innerHTML = `<style>@keyframes qzfall{to{transform:translateY(80vh) rotate(260deg);opacity:0}}</style>
  ${header('Quiz — 🏆')}
  <div class="content" style="position:relative;overflow:hidden">${confetti}
    <div class="card center">
      <div style="font-size:54px">🏆</div>
      <div class="bold" style="font-size:20px;color:#16a34a">Félicitations, vous avez gagné !</div>
      <div class="small muted mb">Quiz « ${esc(s.title)} » — score : ${p.score} bonne(s) réponse(s)</div>
    </div>
    ${demandePhoto ? `<div class="card">
      <div class="bold mb">📸 Demande de l'administration</div>
      <div class="small mb">Acceptez-vous que votre photo de gagnant(e) soit publiée ? Rien ne sera publié sans votre accord, et votre choix est définitif.</div>
      <div style="display:flex;gap:8px">
        <button class="btn" style="flex:1" onclick="A.quizPhoto(${s.id},'accepte')">✅ J'accepte</button>
        <button class="btn sec" style="flex:1" onclick="A.quizPhoto(${s.id},'refuse')">❌ Je refuse</button>
      </div></div>` : ''}
    ${p.photo_consent ? `<div class="card small">${p.photo_consent === 'accepte' ? '📸 Vous avez accepté la publication de votre photo ✅' : '📸 Vous avez refusé la publication de votre photo — votre choix est respecté ❌'}</div>` : ''}
    <div class="card">
      <div class="bold mb">💬 Contacter l'administration</div>
      <div id="qz-msgs" style="max-height:220px;overflow-y:auto;margin-bottom:10px">
        ${messages.length ? messages.map(m => `<div style="display:flex;justify-content:${m.from_admin ? 'flex-start' : 'flex-end'};margin-bottom:6px">
          <div style="max-width:80%;padding:8px 12px;border-radius:14px;font-size:14px;background:${m.from_admin ? '#f3f4f6' : '#dcfce7'}">
            ${m.from_admin ? '<span class="small muted">Administration</span><br>' : ''}${esc(m.body)}</div></div>`).join('')
      : '<div class="small muted center">Écrivez à l\u2019administration pour organiser la remise de votre gain.</div>'}
      </div>
      <div style="display:flex;gap:8px">
        <input type="text" id="qz-msg" placeholder="Votre message…" style="flex:1" maxlength="1000">
        <button class="btn" onclick="A.quizEnvoyer(${s.id})">Envoyer</button>
      </div></div>
    <button class="btn sec" onclick="back()">Retour</button>
  </div>${bottomNav('home')}`;
  const box = document.getElementById('qz-msgs'); if (box) box.scrollTop = box.scrollHeight;
}

async function quizClassique() {
  let qs;
  try { qs = await api('/games/quiz'); } catch (e) { toast(e.message, 'err'); back(); return; }
  if (!qs.length) {
    $app.innerHTML = `${header('🧠 Quiz')}<div class="content">${emptyState('🧠', 'Aucune question de quiz pour le moment. Revenez bientôt !')}</div>${bottomNav('home')}`;
    return;
  }
  const letters = ['A', 'B', 'C', 'D'];
  const answers = {};
  let idx = 0;
  const montrer = () => {
    const q = qs[idx];
    $app.innerHTML = `${header('🧠 Quiz — question ' + (idx + 1) + '/' + qs.length)}
    <div class="content"><div class="card">
      <div class="small muted center" style="margin-bottom:8px">🧠 Quiz • Question ${idx + 1} / ${qs.length}</div>
      <div class="bold mb" style="font-size:17px">${esc(q.question)}</div>
      ${q.options.slice(0, 4).map((o, j) => `<button type="button" class="qz-opt" data-j="${j}"
        style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:#fff;border:2px solid #e5e7eb;border-radius:12px;padding:12px;margin-bottom:8px;font-size:15px;cursor:pointer">
        <span style="flex:0 0 28px;height:28px;border-radius:50%;background:#f3f4f6;display:flex;align-items:center;justify-content:center;font-weight:700">${letters[j]}</span>
        <span>${esc(o)}</span></button>`).join('')}
      <div class="small muted center">Touchez une réponse pour passer à la suivante.</div>
    </div></div>${bottomNav('home')}`;
    let verrou = false;
    document.querySelectorAll('.qz-opt').forEach(b => b.onclick = () => {
      if (verrou) return;
      verrou = true;
      answers[q.id] = parseInt(b.dataset.j, 10);
      b.style.borderColor = '#16a34a'; b.style.background = '#f0fdf4';
      setTimeout(async () => {
        idx++;
        if (idx < qs.length) { montrer(); return; }
        try {
          const r = await api('/games/quiz', { method: 'POST', body: { answers } });
          openModal(`<h3>Résultat</h3><div class="center" style="font-size:40px">${r.score === r.total ? '🏆' : r.score > r.total / 2 ? '🎉' : '🙂'}</div>
          <div class="center bold" style="font-size:22px">${r.score} / ${r.total}</div>
          <button class="btn mt" onclick="closeModal();back()">Fermer</button>`);
        } catch (err) { toast(err.message, 'err'); back(); }
      }, 350);
    });
  };
  montrer();
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
        ? `<div class="status-banner ok">🎉 GAGNÉ ! L'équipe Klean Services vous contactera pour votre récompense.</div>`
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
  /* Fenêtre de sélection de ville : liste complète des villes et localités
     de Côte d'Ivoire (gérée dans le tableau de bord) + recherche. */
  async villePick(inputId) {
    let villes = [];
    try { villes = await api('/villes'); } catch { toast('Liste des villes indisponible. Vérifiez votre connexion.', 'err'); return; }
    if (!villes.length) { toast('Aucune ville disponible pour le moment.', 'err'); return; }
    const lignes = vs => vs.map(v => `<div class="menu-item" onclick="A._villeSet('${inputId}','${esc(v).replace(/'/g, "\\'")}')"><span class="mi-ic">🏙️</span>${esc(v)}<span class="mi-arr">›</span></div>`).join('');
    openModal(`<h3>🏙️ Choisir ma ville</h3>
      <div class="searchbar" style="margin-bottom:8px">
        <input type="text" id="ville-q" placeholder="🔎 Rechercher une ville : Boua…" autocomplete="off">
      </div>
      <div id="ville-liste" style="max-height:52vh;overflow-y:auto">${lignes(villes)}</div>`);
    const inp = document.getElementById('ville-q');
    const zone = document.getElementById('ville-liste');
    const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    inp.addEventListener('input', () => {
      const q = norm(inp.value.trim());
      const vs = q ? villes.filter(v => norm(v).includes(q)) : villes;
      zone.innerHTML = vs.length ? lignes(vs) : '<div class="hint">Aucune ville trouvée. Contactez-nous si votre localité manque.</div>';
    });
    inp.focus();
  },
  _villeSet(inputId, v) {
    const i = document.getElementById(inputId);
    if (i) i.value = v;
    closeModal();
    if (inputId === 'r-city' && A.requestLocationChanged) Promise.resolve(A.requestLocationChanged(false)).finally(() => A.saveCategoryDraft());
    else A.saveCategoryDraft();
  },
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
      resumeAfterAuth('#/home');
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
    sessionStorage.setItem('ks_cat_q', '');
    nav('#/services/' + catId);
  },
  _searchTimer: null, _lastSearchQuery: '', _searchSeq: 0,
  searchResultCard(s, compact) {
    const task = s.tache_suggeree ? ` — <b>${esc(s.tache_suggeree)}</b>` : '';
    const confidence = s.confidence === 'élevée' ? 'Correspondance très probable' : s.confidence === 'moyenne' ? 'Correspondance possible' : 'Autre résultat pertinent';
    return `<div class="menu-item" onclick="A.openSearchResult(${Number(s.id)},${Number(s.task_id || 0)})">
      <span class="mi-ic">${esc(s.icon || '🔹')}</span><div class="grow"><div><b>${esc(s.name)}</b></div>
      <div class="small muted">${esc(s.grand_category || s.category || '')}${s.category && s.grand_category ? ' › ' + esc(s.category) : ''}${task}</div>
      ${prixHtml(s, true)}${compact ? '' : `<div class="small muted" style="margin-top:3px">${confidence}</div>`}</div><span class="mi-arr">›</span></div>`;
  },
  openSearchResult(serviceId, taskId) {
    sessionStorage.setItem('ks_search_selection', JSON.stringify({ service_id: Number(serviceId), task_id: taskId ? Number(taskId) : null, query: A._lastSearchQuery || '' }));
    nav('#/request/' + Number(serviceId));
  },
  searchCategoryCard(c) {
    return `<div class="menu-item" onclick="A.openSearchCategory(${Number(c.id)})"><span class="mi-ic">${esc(c.icon || '🧩')}</span><div class="grow"><b>${esc(c.name)}</b><div class="small muted">Grande catégorie${c.description ? ' · ' + esc(c.description) : ''}</div></div><span class="mi-arr">›</span></div>`;
  },
  openSearchCategory(id) { nav('#/categories/' + Number(id)); },
  describeGrandCategory(id) {
    const services = (window._grandCategoryServices || []).filter(s => Number(s.id));
    if (!services.length) return toast('Aucune prestation active n’est disponible dans cette catégorie.', 'err');
    if (services.length === 1) return A.chooseGrandDescription(services[0].id);
    openModal(`<h3>Décrire mon besoin</h3><p class="small muted">Choisissez la prestation la plus proche. Vous pourrez écrire votre besoin librement, sans sélectionner de tâche.</p><div style="max-height:52vh;overflow:auto">${services.map(s=>`<div class="menu-item" onclick="A.chooseGrandDescription(${s.id})"><span class="mi-ic">🔹</span><div><b>${esc(s.name)}</b><div class="small muted">${esc(s.category || '')}</div></div><span class="mi-arr">›</span></div>`).join('')}</div>`);
  },
  chooseGrandDescription(serviceId) {
    sessionStorage.setItem('ks_search_selection', JSON.stringify({ service_id:Number(serviceId), task_id:null, query:sessionStorage.getItem('ks_category_need') || A._lastSearchQuery || '' }));
    sessionStorage.removeItem('ks_category_need'); closeModal(); nav('#/request/' + Number(serviceId));
  },
  async describeAnyNeed() {
    const query = A._lastSearchQuery || ((document.getElementById('s-q') || {}).value || (document.getElementById('home-q') || {}).value || '').trim();
    sessionStorage.setItem('ks_category_need', query);
    let cats=[]; try { cats=await api('/grand-categories' + (USER && USER.ville ? '?ville='+encodeURIComponent(USER.ville) : '')); } catch(e) { return toast(e.message,'err'); }
    openModal(`<h3>Décrire mon besoin</h3><p class="small muted">Choisissez le grand domaine le plus proche. Aucune tâche prédéfinie ne sera obligatoire.</p><div style="max-height:52vh;overflow:auto">${cats.map(c=>`<div class="menu-item" onclick="closeModal();nav('#/categories/${c.id}')"><span class="mi-ic">${esc(c.icon||'🧩')}</span><b>${esc(c.name)}</b><span class="mi-arr">›</span></div>`).join('')}</div>`);
  },
  requestToggleTask(el) { A.toggleTask(el); const on=[...document.querySelectorAll('#r-taches .task-chip.on')]; REQ.task_id=on[0] ? Number(on[0].dataset.taskId) : null; A.requestEstimate(); },
  /* Formulaire compact d'une grande catégorie : le panneau présente directement les tâches,
     sans répéter le nom de la grande catégorie devant chaque ligne. */
  openCategoryNeeds() {
    const services = REQ.category_services || [];
    const tasks = REQ.category_tasks || [];
    if (!services.length || !tasks.length) return toast('Aucun besoin prédéfini n’est disponible dans cette catégorie.', 'err');
    openModal(`<h3>Choisir mes besoins</h3><p class="small muted">Recherchez ou sélectionnez directement les besoins concernés. Plusieurs besoins sont possibles lorsqu’ils appartiennent à la même prestation.</p>
      <div class="searchbar" style="margin-bottom:9px"><input id="category-task-q" placeholder="Rechercher un besoin" oninput="A.filterCategoryNeeds()" autocomplete="off"></div>
      <div id="category-task-list" class="category-task-list"></div>
      <div class="btn-row mt"><button class="btn" onclick="closeModal()">Terminer</button></div>`);
    A.renderCategoryNeedTasks();
  },
  renderCategoryNeedTasks() {
    const zone = document.getElementById('category-task-list'); if (!zone) return;
    const query = normalize((document.getElementById('category-task-q') || {}).value || '');
    const selected = new Set((REQ.selected_tasks || []).map(t => Number(t.id)));
    const choice = t => `<button type="button" class="category-task-choice ${selected.has(Number(t.id)) ? 'on' : ''}" onclick="A.toggleCategoryNeed(${t.id})"><span>${selected.has(Number(t.id)) ? '☑' : '☐'}</span><div><b>${esc(t.name)}</b>${t.description ? `<small>${esc(t.description)}</small>` : ''}${t.price_from ? `<small class="task-price">À partir de ${fmtFCFA(t.price_from)}${t.price_unit ? ` <em>· ${esc(t.price_unit)}</em>` : ''}</small>` : ''}</div></button>`;
    const groups = (REQ.category_services || []).map(service => {
      const tasks = (REQ.category_tasks || []).filter(t => Number(t.service_id) === Number(service.id) && (!query || normalize(`${t.name} ${t.description || ''} ${(t.search_terms || []).join(' ')}`).includes(query)));
      // Le nom de la prestation organise les tâches ; le nom de la grande catégorie reste seulement dans l’en-tête vert.
      return tasks.length ? `<section class="category-task-group"><h4>${esc(service.name)}</h4>${tasks.map(choice).join('')}</section>` : '';
    }).filter(Boolean);
    zone.innerHTML = groups.length ? groups.join('') : '<div class="hint">Aucun besoin trouvé. Vous pouvez décrire votre demande librement.</div>';
  },
  filterCategoryNeeds() { A.renderCategoryNeedTasks(); },
  toggleCategoryNeed(taskId) {
    const task = (REQ.category_tasks || []).find(t => Number(t.id) === Number(taskId)); if (!task) return;
    const chosen = REQ.selected_tasks || [];
    const index = chosen.findIndex(t => Number(t.id) === Number(task.id));
    if (index >= 0) chosen.splice(index,1); else {
      if (chosen.length && Number(chosen[0].service_id) !== Number(task.service_id)) { toast('Sélectionnez plusieurs besoins dans la même prestation.', 'err'); return; }
      chosen.push({ ...task, detail:'' }); REQ.service_id=task.service_id;
    }
    REQ.selected_tasks=chosen; REQ.task_id=chosen[0] ? chosen[0].id : null;
    A.renderCategoryNeedTasks(); A.updateCategoryNeedSummary(); A.saveCategoryDraft(); A.requestEstimate();
  },
  updateCategoryNeedSummary() {
    if (REQ.mode !== 'category') return;
    const picked = REQ.selected_tasks || [], title=document.getElementById('category-needs-title'), summary=document.getElementById('category-needs-summary');
    if (title) title.textContent = picked.length ? `${picked.length} besoin${picked.length>1?'s':''} sélectionné${picked.length>1?'s':''}` : 'Choisir des besoins';
    if (summary) summary.textContent = picked.length ? picked.map(t=>t.name).join(' · ') : 'Aucun besoin sélectionné — vous pouvez décrire votre demande librement.';
  },
  saveCategoryDraft() {
    if (REQ.mode !== 'category' || !REQ.category_id) return;
    const val = id => (document.getElementById(id) || {}).value || '';
    const draft = { category_id:REQ.category_id, service_id:REQ.service_id, task_id:REQ.task_id, taches:(REQ.selected_tasks || []).map(t=>({id:t.id,detail:t.detail || ''})), description:val('r-desc'), intervention_city:val('r-city'), intervention_commune:val('r-commune'), quartier:val('r-quartier'), address:val('r-addr'), lat:REQ.lat, lng:REQ.lng, photos:REQ.photos || [], audio:REQ.audio || null, urgence:!!((document.getElementById('r-urgent') || {}).checked), schedule_type:val('r-schedule') || 'asap', date_souhaitee:val('r-date') || null };
    sessionStorage.setItem(REQ.category_draft_key || categoryDraftKey(REQ.category_id), JSON.stringify(draft));
  },
  submitCategoryRequest(categoryId) {
    const description=((document.getElementById('r-desc') || {}).value || '').trim();
    const city=((document.getElementById('r-city') || {}).value || '').trim();
    const commune=((document.getElementById('r-commune') || {}).value || '').trim();
    const quartier=((document.getElementById('r-quartier') || {}).value || '').trim();
    const address=((document.getElementById('r-addr') || {}).value || '').trim();
    const selected=REQ.selected_tasks || [];
    if (selected[0]) { REQ.service_id=selected[0].service_id; REQ.task_id=selected[0].id; }
    if (!description) return toast('Décrivez votre besoin.', 'err');
    if (!city) return toast('Choisissez la ville d’intervention.', 'err');
    if (city === 'Abidjan' && !commune) return toast('Choisissez la commune d’intervention.', 'err');
    if (!address) return toast('Indiquez l’adresse précise de l’intervention.', 'err');
    const fullAddress=[quartier,address].filter(Boolean).join(' — ');
    REQ.draft={ category_id:Number(categoryId), service_id:REQ.service_id, task_id:REQ.task_id || null, taches:selected.map(t=>({id:t.id,detail:t.detail || ''})), answers:{}, description, address:fullAddress, quartier, intervention_city:city, intervention_commune:commune, lat:REQ.lat, lng:REQ.lng, urgence:!!document.getElementById('r-urgent').checked, schedule_type:document.getElementById('r-schedule').value, date_souhaitee:document.getElementById('r-date').value || null, photos:REQ.photos, audio:REQ.audio };
    A.saveCategoryDraft();
    if (!USER) { sessionStorage.setItem('ks_pending_request_draft',JSON.stringify(REQ.draft)); authRequired('#/categories/' + Number(categoryId)); return; }
    sessionStorage.removeItem('ks_pending_request_draft'); A.chooseProviderForRequest();
  },

  async liveSearch(inputId, zoneId, compact) {
    const input = document.getElementById(inputId), zone = document.getElementById(zoneId);
    if (!input || !zone) return;
    const q = input.value.trim();
    clearTimeout(A._searchTimer);
    if (q.length < 2) { zone.innerHTML = compact ? '' : '<div class="hint">Décrivez librement votre besoin : service, problème ou travail à réaliser.</div>'; return; }
    const sequence = ++A._searchSeq;
    A._searchTimer = setTimeout(async () => {
      if (zoneId === 's-results') zone.innerHTML = '<div class="center muted mt"><div class="spinner" style="margin:0 auto"></div></div>';
      try {
        const city = USER && USER.ville ? '&ville=' + encodeURIComponent(USER.ville) : '';
        const r = await api('/search?q=' + encodeURIComponent(q) + city);
        if (sequence !== A._searchSeq) return;
        A._lastSearchQuery = q;
        const categories = Array.isArray(r.categories) ? r.categories : [];
        const catHtml = categories.length ? `<div class="sec-title">Grandes catégories</div>${categories.map(c=>A.searchCategoryCard(c)).join('')}` : '';
        const serviceHtml = r.results.length ? `<div class="sec-title">Prestations et tâches</div>${(compact ? r.results.slice(0,5) : r.results).map(s => A.searchResultCard(s, compact)).join('')}` : '';
        const clarification = r.clarification ? `<div class="hint" style="margin-top:8px">💬 ${esc(r.clarification)}</div>` : '';
        zone.innerHTML = (categories.length || r.results.length)
          ? ((compact ? `${categories.slice(0,2).map(c=>A.searchCategoryCard(c)).join('')}${r.results.slice(0,4).map(s=>A.searchResultCard(s,true)).join('')}` : catHtml + serviceHtml) + clarification)
          : (compact ? `<div class="hint">${r.clarification ? esc(r.clarification) + ' ' : 'Aucune correspondance certaine. '}<button class="btn ghost sm" onclick="A.describeAnyNeed()">Décrire mon besoin</button></div>` : emptyState('🔍', r.clarification || 'Aucun résultat suffisamment fiable.') + `<button class="btn" onclick="A.describeAnyNeed()">Décrire mon besoin</button><button class="btn sec mt" onclick="nav('#/categories')">Voir tous les services</button>`);
      } catch (e) { if (sequence === A._searchSeq) zone.innerHTML = compact ? '<div class="hint">Recherche momentanément indisponible.</div>' : emptyState('📶', e.message); }
    }, 180);
  },
  async doSearch() {
    const q = (document.getElementById('s-q') || {}).value?.trim() || '';
    if (!q) return;
    A._lastSearchQuery = q;
    await A.liveSearch('s-q', 's-results', false);
  },
  pickChip(el, val) {
    [...el.parentElement.children].forEach(c => c.classList.remove('on'));
    el.classList.add('on');
    el.parentElement.dataset.val = val;
  },
  chooseProviderForRequest() {
    if (!REQ.draft) return toast('Les informations de votre demande ne sont plus disponibles. Veuillez réessayer.', 'err');
    openModal(`<h3>Choisissez un prestataire</h3>
      <button class="btn" style="width:100%;margin-bottom:10px" onclick="A.sendRequestWithProvider('particulier')">👤 Un particulier</button>
      <button class="btn sec" style="width:100%" onclick="A.sendRequestWithProvider('entreprise')">🏢 Une entreprise</button>`);
  },
  async sendRequestWithProvider(provider_type, duplicate_confirmed) {
    if (!REQ.draft) return;
    try {
      const r = await api('/missions', { method: 'POST', body: { ...REQ.draft, provider_type, duplicate_confirmed: !!duplicate_confirmed } });
      closeModal(); delete REQ.draft; sessionStorage.removeItem('ks_pending_request_draft');
      if (REQ.category_draft_key) sessionStorage.removeItem(REQ.category_draft_key);
      toast('Demande envoyée ! Recherche de prestataires en cours…', 'ok');
      navStack = ['#/home', '#/missions']; navCursor = 1; currentHash = '#/missions'; nav('#/mission/' + r.id);
    } catch (err) {
      if (err.status === 409 && err.data && err.data.duplicate && !duplicate_confirmed) {
        openModal(`<h3>Demande semblable détectée</h3><p class="small muted">Une demande récente de ce service existe déjà. Souhaitez-vous tout de même créer une demande indépendante ?</p><button class="btn" onclick="A.sendRequestWithProvider('${provider_type}',true)">Créer quand même</button><button class="btn sec mt" onclick="closeModal()">Annuler</button>`);
      } else toast(err.message, 'err');
    }
  },
  changeMissionProvider(id) {
    openModal(`<h3>Choisissez un prestataire</h3><button class="btn" style="width:100%;margin-bottom:10px" onclick="A.saveMissionProvider(${id},'particulier')">👤 Un particulier</button><button class="btn sec" style="width:100%" onclick="A.saveMissionProvider(${id},'entreprise')">🏢 Une entreprise</button>`);
  },
  async saveMissionProvider(id, provider_type) {
    try { await api('/missions/' + id + '/provider-type', { method: 'PUT', body: { provider_type } }); closeModal(); toast('Choix mis à jour. Nouvelle recherche en cours.', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  },
  async relancerMission(id) {
    try { await api('/missions/' + id + '/relancer', { method: 'POST', body: {} }); toast('Recherche relancée.', 'ok'); render(); } catch (e) { toast(e.message, 'err'); }
  },
  toggleTask(el, forceOn) {
    if (forceOn === true) el.classList.add('on'); else el.classList.toggle('on');
    el.textContent = (el.classList.contains('on') ? '☑ ' : '☐ ') + el.dataset.taskName;
    const zone = document.getElementById('r-task-details'); if (!zone) return;
    const tasks = [...document.querySelectorAll('#r-taches .task-chip.on')];
    zone.innerHTML = tasks.map(t => `<div class="field" style="margin:10px 0 0"><label class="small">Précision pour « ${esc(t.dataset.taskName)} » <span class="muted">(facultatif)</span></label><input type="text" id="r-task-detail-${esc(t.dataset.taskId)}" maxlength="500" placeholder="Ex : cuisine, 2 robinets concernés…"></div>`).join('');
  },
  toggleProCategory(el) {
    const list = el.parentElement.querySelector('.pro-cat-services');
    const open = list.classList.toggle('open'); el.setAttribute('aria-expanded', open ? 'true' : 'false');
  },
  async saveProOption(id, required) {
    const el = document.getElementById('pro-opt-' + id); const payload = (el && el.value || '').trim();
    if (required && !payload) return toast('Cette option obligatoire doit être renseignée.', 'err');
    try { await api('/pro-options/' + id + '/use', { method: 'POST', body: { payload } }); toast('Option professionnelle enregistrée ✓', 'ok'); render(); } catch (e) { toast(e.message, 'err'); }
  },
  async changeServiceCity() {
    let cities = []; try { cities = await api('/villes'); } catch (e) { toast(e.message, 'err'); return; }
    const profile = USER.pro || {}, current = profile.service_city || USER.ville || '';
    const allowed = Array.isArray(profile.service_cities) ? profile.service_cities : [], allAllowed = allowed.includes('*');
    // Le professionnel choisit sa ville principale ; les villes supplémentaires restent une décision administrative.
    const selectable = allAllowed || !allowed.length ? cities : cities.filter(c => allowed.includes(c));
    if (current && !selectable.includes(current)) selectable.unshift(current);
    const assigned = allAllowed ? 'Toutes les villes actives sont autorisées par l’administration.' : allowed.length ? allowed.join(' • ') : 'Aucune ville n’est encore attribuée : choisissez votre ville principale.';
    A._proGps = (profile.service_lat != null && profile.service_lng != null) ? { lat:Number(profile.service_lat), lng:Number(profile.service_lng) } : null;
    openModal(`<h3>📍 Ma zone d’intervention</h3>
      <p class="small muted">Votre ville d’inscription ne change pas. La ville et la position de service servent uniquement à mieux classer les demandes qui vous sont proposées.</p>
      <div class="small" style="background:#f0f8f6;border-radius:8px;padding:8px;margin-bottom:10px"><b>Villes autorisées :</b><br>${esc(assigned)}</div>
      <label class="small muted">Rechercher une ville</label><input id="pro-city-search" style="width:100%;margin-bottom:8px" placeholder="Tapez les premières lettres…" oninput="A.filterServiceCities()">
      <label class="small muted">Ville principale d’intervention</label><select id="pro-service-city" style="width:100%;margin-bottom:10px">${selectable.map(v => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
      <label class="small muted">Quartiers / zone de déplacement <span class="muted">(facultatif)</span></label><input id="pro-service-zone" style="width:100%;margin-bottom:9px" maxlength="250" value="${esc(profile.zone || '')}" placeholder="Ex : Cocody, Riviera, Angré">
      <div class="small muted" id="pro-gps-state">${A._proGps ? '✓ Position professionnelle enregistrée pour le classement interne.' : 'Position GPS facultative : elle permet de mieux classer les demandes proches.'}</div>
      <div class="btn-row mt"><button class="btn outline sm" onclick="A.captureProGPS()">📍 ${A._proGps ? 'Mettre à jour ma position' : 'Ajouter ma position GPS'}</button>${A._proGps ? '<button class="btn ghost sm" onclick="A.clearProGPS()">Supprimer GPS</button>' : ''}</div>
      <p class="small muted">Vous souhaitez intervenir dans d’autres villes ? Contactez l’administration. Seule l’administration peut autoriser des villes supplémentaires.</p>
      <button class="btn" onclick="A.saveServiceCity()">Enregistrer</button><button class="btn sec mt" onclick="closeModal()">Annuler</button>`);
  },
  filterServiceCities() {
    const q = ((document.getElementById('pro-city-search') || {}).value || '').trim().toLocaleLowerCase('fr');
    const sel = document.getElementById('pro-service-city'); if (!sel) return;
    [...sel.options].forEach(o => { o.hidden = !!q && !o.text.toLocaleLowerCase('fr').includes(q); });
    const first = [...sel.options].find(o => !o.hidden); if (first) sel.value = first.value;
  },
  captureProGPS() {
    if (!navigator.geolocation) return toast('GPS non disponible sur cet appareil. Vous pouvez enregistrer votre ville et vos quartiers.', 'err');
    const state=document.getElementById('pro-gps-state'); if(state)state.textContent='Localisation en cours…';
    navigator.geolocation.getCurrentPosition(pos => {
      A._proGps={lat:pos.coords.latitude,lng:pos.coords.longitude};
      if(state)state.textContent='✓ Position GPS prête à être enregistrée.';
      toast('Position professionnelle capturée. Enregistrez la zone pour la conserver.', 'ok');
    }, () => { if(state)state.textContent='GPS refusé ou indisponible. Votre ville restera utilisée.'; toast('Localisation indisponible : votre ville et votre zone restent prises en compte.', 'err'); }, {enableHighAccuracy:true,timeout:10000,maximumAge:120000});
  },
  clearProGPS() { A._proGps = null; const state=document.getElementById('pro-gps-state'); if(state)state.textContent='La position GPS sera supprimée après enregistrement.'; },
  async saveServiceCity() {
    try {
      const previous=USER.pro || {}, body={ service_city:document.getElementById('pro-service-city').value, zone:document.getElementById('pro-service-zone').value };
      if (A._proGps) { body.lat=A._proGps.lat; body.lng=A._proGps.lng; }
      else if (previous.service_lat != null || previous.service_lng != null) body.clear_gps=true;
      USER = await api('/pro/service-location', { method: 'PUT', body }); closeModal(); toast('Zone d’intervention mise à jour ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  },
  startContact(subject) { sessionStorage.setItem('ks_contact_subject', subject); nav('#/contact/new'); },
  async supportCreate(subject, btn) {
    const content = (document.getElementById('support-first') || {}).value || ''; busy(btn, true);
    try { const r = await api('/support/conversations', { method: 'POST', body: { subject, content } }); sessionStorage.removeItem('ks_contact_subject'); nav('#/contact/' + r.id); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  async supportSend(id) {
    const input = document.getElementById('support-text'); const content = input && input.value.trim(); if (!content) return;
    try { const m = await api('/support/conversations/' + id + '/messages', { method: 'POST', body: { type: 'text', content } }); input.value = ''; appendSupportMsg(m); }
    catch (e) { toast(e.message, 'err'); }
  },
  collap(id) { document.getElementById(id).classList.toggle('open'); },
  requestSchedule() { const s=document.getElementById('r-schedule'), d=document.getElementById('r-date'); if (!s || !d) return; d.style.display=s.value==='date'?'block':'none'; if(s.value!=='date') d.value=''; A.saveCategoryDraft(); },
  requestTaskChanged() { const task = document.getElementById('r-task'); REQ.task_id = task ? (Number(task.value) || null) : null; A.requestEstimate(); },
  requestDescriptionChanged() { A.saveCategoryDraft(); clearTimeout(A._estimateTimer); A._estimateTimer = setTimeout(() => A.requestEstimate(), 300); clearTimeout(A._needHintTimer); A._needHintTimer = setTimeout(() => A.requestNeedHints(), 420); },
  async requestNeedHints() {
    const zone=document.getElementById('r-language-hint'), input=document.getElementById('r-desc'); if (!zone || !input) return;
    const text=input.value.trim(); if (text.length < 5) { zone.innerHTML=''; return; }
    const seq=(A._needHintSeq||0)+1; A._needHintSeq=seq;
    try {
      const context=REQ && REQ.mode==='category' && REQ.category_id ? '&context_category_id='+encodeURIComponent(REQ.category_id) : '';
      const r=await api('/search?q='+encodeURIComponent(text)+context);
      if (seq!==A._needHintSeq) return;
      const suggestions=(r.results||[]).filter(x=>x.task_id).slice(0,3);
      if (REQ && REQ.mode==='category' && suggestions.length) {
        const buttons=suggestions.map(x=>{ const task=(REQ.category_tasks||[]).find(t=>Number(t.id)===Number(x.task_id)); return task ? `<button type="button" class="btn ghost sm" onclick="A.acceptNeedSuggestion(${Number(task.id)})">${esc(task.name)}</button>` : ''; }).filter(Boolean).join(' ');
        zone.innerHTML=buttons ? `<span>Suggestion, à confirmer :</span> ${buttons}` : (r.clarification ? esc(r.clarification) : '');
      } else if (r.clarification) zone.textContent=r.clarification;
      else zone.innerHTML='';
    } catch { if (seq===A._needHintSeq) zone.innerHTML=''; }
  },
  acceptNeedSuggestion(taskId) {
    const task=(REQ.category_tasks||[]).find(t=>Number(t.id)===Number(taskId)); if(!task) return;
    if ((REQ.selected_tasks||[]).some(t=>Number(t.id)===Number(task.id))) return;
    if ((REQ.selected_tasks||[]).length && Number(REQ.selected_tasks[0].service_id)!==Number(task.service_id)) { A.openCategoryNeeds(); return toast('La suggestion relève d’une autre prestation : choisissez-la dans la liste.', 'err'); }
    A.toggleCategoryNeed(task.id);
  },
  // Réutilisable lorsqu'une transcription vocale est fournie par un appareil ou un service autorisé :
  // elle passe par le même moteur que la description saisie, sans sélection automatique.
  applyTranscribedNeed(text) { const input=document.getElementById('r-desc'); if (!input) return; input.value=String(text||'').slice(0,5000); A.requestDescriptionChanged(); },
  async requestLocationChanged(keepCommune) {
    const city = ((document.getElementById('r-city') || {}).value || '').trim();
    const field = document.getElementById('r-commune-field'); const input = document.getElementById('r-commune');
    if (!field || !input) return A.requestEstimate();
    if (city !== 'Abidjan') { field.style.display = 'none'; input.value = ''; return A.requestEstimate(); }
    field.style.display = 'block';
    if (!keepCommune) input.value = '';
    try { window._requestCommunes = await api('/communes?city=' + encodeURIComponent(city)); } catch { window._requestCommunes = []; }
    A.requestEstimate();
  },
  communePick() {
    const communes = window._requestCommunes || []; if (!communes.length) return toast('Liste des communes indisponible.', 'err');
    const rows = list => list.map(v => `<div class="menu-item" onclick="A._communeSet('${esc(v).replace(/'/g, "\\'")}')"><span class="mi-ic">📍</span>${esc(v)}<span class="mi-arr">›</span></div>`).join('');
    openModal(`<h3>📍 Choisir la commune</h3><div class="searchbar" style="margin-bottom:8px"><input id="commune-q" placeholder="Rechercher une commune"></div><div id="commune-liste" style="max-height:52vh;overflow:auto">${rows(communes)}</div>`);
    const q = document.getElementById('commune-q'), zone = document.getElementById('commune-liste'); q.addEventListener('input', () => { const text = q.value.toLowerCase(); zone.innerHTML = rows(communes.filter(v => v.toLowerCase().includes(text))) || '<div class="hint">Aucune commune trouvée.</div>'; }); q.focus();
  },
  _communeSet(value) { const input = document.getElementById('r-commune'); if (input) input.value = value; closeModal(); A.saveCategoryDraft(); A.requestEstimate(); },
  async requestEstimate() {
    const city = ((document.getElementById('r-city') || {}).value || '').trim();
    const description = ((document.getElementById('r-desc') || {}).value || '').trim();
    const commune = ((document.getElementById('r-commune') || {}).value || '').trim();
    const zone = document.getElementById('r-estimate'); if (!zone) return;
    // Une estimation n’est affichée que lorsqu’une règle vérifiable donne un montant.
    // Depuis une grande catégorie, un besoin sélectionné identifie la prestation : sans lui,
    // un prix dynamique serait arbitraire et reste donc silencieux.
    // L’absence de référence reste silencieuse : aucun montant fictif, aucun « Prix à confirmer ».
    if (!description || !city || (city === 'Abidjan' && !commune) || (REQ.mode === 'category' && !(REQ.selected_tasks || []).length)) { zone.innerHTML = ''; return; }
    try {
      const r = await api('/estimates?service_id=' + encodeURIComponent(REQ.service_id) + '&task_id=' + encodeURIComponent(REQ.task_id || '') + '&city=' + encodeURIComponent(city) + '&zone=' + encodeURIComponent(commune) + '&details=' + encodeURIComponent(description));
      zone.innerHTML = r.status === 'estimated' && r.amount ? `<div class="estimate-price">Estimation disponible : à partir de ${fmtFCFA(r.amount)}</div>` : '';
    } catch { zone.innerHTML = ''; }
  },
  mTab(t) { sessionStorage.setItem('ks_mtab', t); render(); },
  toggleSound(el) {
    const now = localStorage.getItem('ks_sound') !== '0';
    localStorage.setItem('ks_sound', now ? '0' : '1');
    render();
  },
  viewPhoto(src) { openModal(`<img src="${esc(mediaUrl(src))}" style="width:100%;border-radius:12px"><button class="btn mt" onclick="closeModal()">Fermer</button>`); },

  /* Photos */
  pickPhotos(zoneId) {
    if (!USER) { authRequired(currentHash || '#/home'); return; }
    const input = document.getElementById('file-input');
    input.onchange = async () => {
      if (!input.files.length) return;
      let files = [...input.files];
      if (zoneId === 'r-photos') {
        const remaining = Math.max(0, Number(REQ.photo_limit ?? 5) - REQ.photos.length);
        if (!remaining) { toast('La limite de photos de cette demande est atteinte.', 'err'); input.value = ''; return; }
        if (files.length > remaining) { files = files.slice(0, remaining); toast(`Seules ${remaining} photo(s) peuvent encore être ajoutées.`); }
      }
      const fd = new FormData();
      files.forEach(f => fd.append('files', f));
      toast('Envoi des fichiers…');
      try {
        const r = await api('/upload', { method: 'POST', body: fd });
        REQ.photos.push(...r.files); A.saveCategoryDraft();
        const zone = document.getElementById(zoneId);
        r.files.forEach(f => zone.insertAdjacentHTML('afterbegin', `<img src="${esc(mediaUrl(f))}">`));
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

  /* Audio — enregistre, arrête, puis affiche une écoute avant l'envoi de la demande. */
  _rec: null, _recChunks: [], _pendingChatAudio: null, _recTimer: null, _recLimitTimer: null, _audioMaxSec: 20,
  async toggleRec(zoneId) {
    if (!USER) { authRequired(currentHash || '#/home'); return; }
    const btn = document.getElementById('r-rec');
    if (A._rec && A._rec.state === 'recording') { A._rec.stop(); return; }
    let stream;
    try {
      const options = audioRecorderOptions(); if (!options) throw new Error('unsupported');
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      A._recChunks = []; A._rec = new MediaRecorder(stream, options);
      A._rec.ondataavailable = e => { if (e.data && e.data.size) A._recChunks.push(e.data); };
      A._rec.onstop = async () => {
        A.stopRecClock();
        stream.getTracks().forEach(t => t.stop());
        const mime = A._rec && A._rec.mimeType || (options && options.mimeType) || 'audio/webm'; A._rec = null;
        const blob = new Blob(A._recChunks, { type: mime });
        if (!blob.size) return toast('Aucun son n’a été enregistré. Réessayez.', 'err');
        const fd = new FormData(); fd.append('files', blob, 'vocal.' + audioExtension(mime));
        try {
          const r = await api('/upload', { method: 'POST', body: fd }); REQ.audio = r.files[0]; A.saveCategoryDraft();
          const zone = document.getElementById(zoneId); if (!zone) return;
          zone.innerHTML = `<audio controls preload="metadata" src="${esc(mediaUrl(REQ.audio))}"></audio><div class="small muted">Écoutez puis envoyez votre demande.</div><button class="btn ghost sm" onclick="A.clearRequestAudio('${zoneId}')">🗑️ Supprimer</button>`;
          toast('Message vocal enregistré. Vous pouvez l’écouter avant l’envoi ✓', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
      A._rec.start(250); A.startRecClock(btn, Math.min(25, Number(REQ.audio_max || 25))); btn.classList.add('warn');
    } catch (e) { if (stream) stream.getTracks().forEach(t => t.stop()); toast(microphoneError(e), 'err'); }
  },
  clearRequestAudio(zoneId) {
    REQ.audio = null; A.saveCategoryDraft(); const zone = document.getElementById(zoneId); if (zone) zone.innerHTML = `<button class="btn sec sm" id="r-rec" onclick="A.toggleRec('${zoneId}')">🎤 Enregistrer un message vocal</button>`;
  },

  /* GPS */
  async geocodeRequestAddress() {
    const address=((document.getElementById('r-addr')||{}).value||'').trim(), city=((document.getElementById('r-city')||{}).value||'').trim();
    if(!city) return toast('Choisissez d’abord la ville d’intervention.', 'err');
    if(!address) return toast('Saisissez l’adresse ou un repère avant de la rechercher.', 'err');
    const note=document.getElementById('r-geocode-note'); if(note)note.textContent='Recherche de la position de l’adresse…';
    try { const r=await api('/geocode',{method:'POST',body:{address,city}}); REQ.lat=r.lat;REQ.lng=r.lng;A.saveCategoryDraft();if(note)note.textContent='✓ Position de l’adresse trouvée via OpenStreetMap.';toast('Position de l’adresse enregistrée ✓','ok'); }
    catch(e) { if(note)note.textContent='Adresse non localisée automatiquement : la ville et l’adresse saisies restent utilisées.';toast(e.message,'err'); }
  },
  useGPS() {
    const btn = document.getElementById('b-gps');
    if (!navigator.geolocation) { toast('GPS non disponible sur cet appareil. Saisissez votre adresse manuellement.', 'err'); return; }
    btn.textContent = '📍 Localisation…'; btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      pos => {
        REQ.lat = pos.coords.latitude; REQ.lng = pos.coords.longitude; A.saveCategoryDraft();
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
  async openDirections(id, btn) {
    if (btn) busy(btn, true);
    try {
      const m = await api('/missions/' + Number(id));
      if (m.role !== 'pro') throw new Error('Cette option est réservée au professionnel affecté à la mission.');
      const destination = (m.lat !== null && m.lat !== undefined && m.lng !== null && m.lng !== undefined && Number.isFinite(Number(m.lat)) && Number.isFinite(Number(m.lng)))
        ? `${Number(m.lat)},${Number(m.lng)}`
        : [m.address, m.intervention_city, 'Côte d’Ivoire'].filter(Boolean).join(', ');
      if (!destination) throw new Error('Aucune destination exploitable n’est disponible pour cette mission.');
      const launch = origin => {
        let url='https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(destination)+'&travelmode=driving';
        if (origin) url += '&origin='+encodeURIComponent(origin);
        window.open(url, '_blank', 'noopener');
      };
      // La position courante est demandée seulement au professionnel qui lance l’itinéraire.
      // En cas de refus, sa position de service déjà enregistrée est utilisée si elle existe ; sinon
      // Google Maps ouvre simplement la destination/adresse sans divulgation supplémentaire.
      const saved = USER && USER.pro && USER.pro.service_lat != null && USER.pro.service_lng != null ? `${USER.pro.service_lat},${USER.pro.service_lng}` : '';
      if (navigator.geolocation) navigator.geolocation.getCurrentPosition(p => launch(`${p.coords.latitude},${p.coords.longitude}`), () => launch(saved), { enableHighAccuracy:true, timeout:8000, maximumAge:120000 });
      else launch(saved);
    } catch (e) { toast(e.message, 'err'); }
    finally { if (btn) busy(btn, false); }
  },
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
    try { await api('/missions/' + id + '/start', { method: 'POST' }); toast('Demande de démarrage envoyée au client.', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  async confirmStart(id, btn) {
    busy(btn, true);
    try { await api('/missions/' + id + '/start/confirm', { method: 'POST' }); toast('Démarrage confirmé.', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  async completeMission(id, btn) {
    busy(btn, true);
    try { await api('/missions/' + id + '/complete', { method: 'POST' }); toast('Demande de confirmation de fin envoyée au client.', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  async confirmEnd(id, btn) {
    busy(btn, true);
    try { await api('/missions/' + id + '/complete/confirm', { method: 'POST' }); toast('Fin confirmée. Vous pouvez maintenant confirmer le paiement.', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  async contestStage(id, stage, btn) {
    const reason = prompt(stage === 'start' ? 'Pourquoi contestez-vous le démarrage ? (facultatif)' : 'Pourquoi contestez-vous la fin ? (facultatif)');
    if (reason === null) return;
    busy(btn, true);
    try { await api('/missions/' + id + '/' + stage + '/contest', { method: 'POST', body: { reason } }); toast(stage === 'start' ? 'Démarrage contesté. Le professionnel a été notifié.' : 'Fin contestée. Un litige a été ouvert.', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  async setAmount(id, btn) {
    const v = document.getElementById('m-amount').value;
    busy(btn, true);
    try { await api('/missions/' + id + '/montant', { method: 'POST', body: { amount: v } }); toast('Montant enregistré ✓', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  finPreview(rate) {
    const v = parseInt(document.getElementById('m-amount').value, 10) || 0;
    const el = document.getElementById('fin-preview');
    if (!el) return;
    const com = Math.round(v * rate / 100);
    el.innerHTML = v ? `Prix total : <b>${fmtFCFA(v)}</b> — Commission Klean Services (${rate}%) : <b>${fmtFCFA(com)}</b> — Votre part : <b>${fmtFCFA(v - com)}</b>` : `Commission Klean Services : ${rate}% — elle sera déduite de ce montant.`;
  },
  prixModifForm(id, actuel, rate) {
    openModal(`<h3>✏️ Demander une modification du prix</h3>
      <p class="small">Prix actuel : <b>${fmtFCFA(actuel)}</b>. Le client recevra votre proposition et devra l'accepter. Rien n'est modifié sans son accord.</p>
      <div class="field"><label>Nouveau montant (FCFA) <span class="req">*</span></label><input type="number" id="pm-montant" min="100" step="100" oninput="A._pmPreview(${rate})"></div>
      <div class="small muted mb" id="pm-preview"></div>
      <div class="field"><label>Raison de l'augmentation ou de la baisse <span class="req">*</span></label><textarea id="pm-raison" placeholder="Ex : fuite plus importante que prévu, pièce supplémentaire à remplacer…"></textarea></div>
      <div class="btn-row"><button class="btn sec" onclick="closeModal()">Annuler</button>
      <button class="btn" onclick="A._sendPrixModif(${id},this)">Envoyer au client</button></div>`);
  },
  _pmPreview(rate) {
    const v = parseInt(document.getElementById('pm-montant').value, 10) || 0;
    const el = document.getElementById('pm-preview');
    if (el) el.innerHTML = v ? `Si le client accepte : commission (${rate}%) ${fmtFCFA(Math.round(v * rate / 100))} — votre part ${fmtFCFA(v - Math.round(v * rate / 100))}.` : '';
  },
  async _sendPrixModif(id, btn) {
    busy(btn, true);
    try {
      await api('/missions/' + id + '/prix-modif', { method: 'POST', body: { new_amount: document.getElementById('pm-montant').value, reason: document.getElementById('pm-raison').value } });
      closeModal(); toast('Proposition envoyée au client ✓', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },
  async prixReponse(mid, pcid, accepte, btn) {
    busy(btn, true);
    try {
      await api(`/missions/${mid}/prix-modif/${pcid}/reponse`, { method: 'POST', body: { accepte } });
      toast(accepte ? 'Nouveau prix accepté ✓' : 'Modification refusée — l\u2019ancien prix reste valable.', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); busy(btn, false); }
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
  startRecClock(btn, max) {
    A.stopRecClock(); const started = Date.now();
    const paint = () => { const sec = Math.min(max, Math.floor((Date.now() - started) / 1000)); if (btn) btn.textContent = '⏹️ ' + sec + 's/' + max + 's'; };
    paint(); A._recTimer = setInterval(paint, 250);
    A._recLimitTimer = setTimeout(() => { if (A._rec && A._rec.state === 'recording') { toast('Durée maximale atteinte : l’enregistrement s’arrête.', 'ok'); A._rec.stop(); } }, max * 1000);
  },
  stopRecClock() { if (A._recTimer) clearInterval(A._recTimer); if (A._recLimitTimer) clearTimeout(A._recLimitTimer); A._recTimer = null; A._recLimitTimer = null; },
  chatPreset(text) { const ta = document.getElementById('chat-text'); if (ta) { ta.value = text; ta.focus(); } },
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
    if (A._rec && A._rec.state === 'recording') { A._rec.stop(); if (btn) { btn.classList.remove('rec'); btn.textContent = '🎤'; } return; }
    let stream;
    try {
      const options = audioRecorderOptions(); if (!options) throw new Error('unsupported');
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      A._recChunks = []; A._rec = new MediaRecorder(stream, options);
      A._rec.ondataavailable = e => { if (e.data && e.data.size) A._recChunks.push(e.data); };
      A._rec.onstop = async () => {
        A.stopRecClock();
        stream.getTracks().forEach(t => t.stop());
        const mime = A._rec && A._rec.mimeType || (options && options.mimeType) || 'audio/webm'; A._rec = null;
        const blob = new Blob(A._recChunks, { type: mime }); if (!blob.size) return toast('Aucun son n’a été enregistré. Réessayez.', 'err');
        const fd = new FormData(); fd.append('files', blob, 'vocal.' + audioExtension(mime));
        try {
          const r = await api('/upload', { method: 'POST', body: fd }); A._pendingChatAudio = { id, file: r.files[0] };
          openModal(`<h3>🎤 Note vocale prête</h3><audio controls preload="metadata" style="width:100%" src="${esc(mediaUrl(r.files[0]))}"></audio><p class="small muted">Écoutez-la avant l’envoi.</p><button class="btn" onclick="A.sendPendingChatAudio()">Envoyer la note vocale</button><button class="btn sec mt" onclick="A.cancelPendingChatAudio()">Supprimer</button>`);
        } catch (e) { toast(e.message, 'err'); }
      };
      A._rec.start(250); if (btn) { btn.classList.add('rec'); A.startRecClock(btn, A._audioMaxSec || 20); }
      toast('Enregistrement en cours… arrêt automatique à ' + (A._audioMaxSec || 20) + ' secondes.');
    } catch (e) { if (stream) stream.getTracks().forEach(t => t.stop()); toast(microphoneError(e), 'err'); }
  },
  async sendPendingChatAudio() {
    const pending = A._pendingChatAudio; if (!pending) return; try { const m = await api('/missions/' + pending.id + '/messages', { method: 'POST', body: { type: 'audio', file: pending.file } }); appendChatMsg(m); A._pendingChatAudio = null; closeModal(); }
    catch (e) { toast(e.message, 'err'); }
  },
  cancelPendingChatAudio() { A._pendingChatAudio = null; closeModal(); },

  /* Notifications */
  async openNotif(id, link) {
    try { await api('/notifications/read', { method: 'POST', body: { id } }); refreshBadges(); } catch { }
    if (link && link.startsWith('#/')) nav(link); else render();
  },
  async readAll() {
    try { await api('/notifications/read', { method: 'POST', body: {} }); refreshBadges(); render(); } catch (e) { toast(e.message, 'err'); }
  },

  async enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return toast('Les notifications de cet appareil ne sont pas prises en charge par ce navigateur.', 'err');
    try {
      const cfg = await api('/push/config');
      if (!cfg.enabled || !cfg.public_key) return toast('Les notifications Web Push ne sont pas encore configurées par Klean Services.', 'err');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return toast('Autorisation refusée. Vous pouvez l’activer dans les réglages du navigateur.', 'err');
      const reg = await navigator.serviceWorker.ready;
      const b64 = cfg.public_key.replace(/-/g, '+').replace(/_/g, '/'); const raw = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
      const key = Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
      toast('Notifications activées sur cet appareil ✓', 'ok');
    } catch (e) { toast(e.message || 'Impossible d’activer les notifications.', 'err'); }
  },

  /* Pro */
  async toggleAvail(v) {
    try { await api('/pro/availability', { method: 'PUT', body: { available: !!v } }); toast(v ? 'Vous êtes maintenant disponible 🟢' : 'Vous êtes indisponible ⚪', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  },

  /* Avis de recherche / jobs */
  avisSearch() {
    sessionStorage.setItem('ks_avis_filters', JSON.stringify({
      q: document.getElementById('avis-q').value.trim(), category_id: document.getElementById('avis-cat').value, city: document.getElementById('avis-city').value.trim()
    })); render();
  },
  reportNotice(targetId, noticeId) {
    openModal(`<h3>⚠️ Signaler cet avis</h3><div class="field"><textarea id="rep-notice-reason" placeholder="Décrivez le problème constaté…"></textarea></div><div class="btn-row"><button class="btn sec" onclick="closeModal()">Annuler</button><button class="btn warn" onclick="A._doReport(null,${Number(targetId)},this)">Envoyer le signalement</button></div>`);
  },
  async avisForm() {
    if (!USER) { authRequired('#/avis-recherche'); return; }
    REQ = { photos: [] };
    let cc = null, categories = [];
    try { [cc, categories] = await Promise.all([api('/commerce/config'), api('/avis-recherche/categories')]); } catch (e) { toast(e.message, 'err'); return; }
    if (!categories.length) { toast('Aucune catégorie d’avis n’est disponible. Contactez l’administration.', 'err'); return; }
    const av = cc ? cc.avis : null, fmls = [];
    if (av) { fmls.push({ code:'normal',label:'Normal',prix:av.prix_normal }); if(av.avant.enabled)fmls.push({code:'avant',label:'⭐ Mis en avant',prix:av.avant.prix}); if(av.urgent.enabled)fmls.push({code:'urgent',label:'🚨 Urgent',prix:av.urgent.prix}); }
    window._avisFormule = 'normal';
    const fmlBlock = av && fmls.length > 1 ? `<div class="field"><label>Formule</label><div class="choices" id="av-fml">${fmls.map((f,i)=>`<button type="button" class="chip ${i===0?'on':''}" onclick="A.pickChip(this,'${f.code}');window._avisFormule='${f.code}'">${f.label} — ${f.prix?f.prix.toLocaleString('fr-FR')+' '+cc.devise:'gratuit'}</button>`).join('')}</div><div class="muted small">Les formules payantes ne sont appliquées qu’après confirmation du paiement. Publication après modération.</div></div>` : '';
    openModal(`<h3>📢 Publier un avis de recherche</h3>${fmlBlock}
      <div class="field"><label>Catégorie <span class="req">*</span></label><select id="av-cat">${categories.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><div class="small muted">${esc(categories[0].description || '')}</div></div>
      <div class="field"><label>Intitulé <span class="req">*</span></label><input type="text" id="av-nom" placeholder="Ex : Sac noir perdu, recherche de Mariam…"></div>
      <div class="field"><label>Description <span class="req">*</span></label><textarea id="av-desc" placeholder="Décrivez précisément ce qui est recherché et les circonstances."></textarea></div>
      <div class="field"><label>Ville / localité <span class="req">*</span></label><input type="text" id="av-city" readonly onclick="A.villePick('av-city')" placeholder="👆 Choisir une ville" style="cursor:pointer;background:#fff"></div>
      <div class="field"><label>Photo</label><div class="photo-strip" id="av-photo"><button class="ph-add" onclick="A.pickPhotos('av-photo')">＋</button></div><input type="file" id="file-input" accept="image/*" style="display:none"></div>
      <div class="field"><label>Date / période (facultatif)</label><input type="date" id="av-date"></div>
      <div class="field"><label>Dernier lieu / précisions</label><input type="text" id="av-lieu"></div>
      <div class="field"><label>Contact autorisé <span class="req">*</span></label><input type="tel" id="av-contact" value="${esc(USER.phone)}"></div>
      <div class="field"><label>Informations complémentaires</label><textarea id="av-infos"></textarea></div>
      <div class="muted small mb">N’indiquez que des informations dont vous êtes autorisé(e) à disposer. L’avis sera vérifié par l’administration.</div><button class="btn" onclick="A._sendAvis(this)">Envoyer pour validation</button>`);
  },
  async _sendAvis(btn) {
    busy(btn,true); try {
      await api('/avis-recherche',{method:'POST',body:{category_id:document.getElementById('av-cat').value,nom:document.getElementById('av-nom').value,description:document.getElementById('av-desc').value,city:document.getElementById('av-city').value,photo:REQ.photos[0]||null,date_disparition:document.getElementById('av-date').value,dernier_lieu:document.getElementById('av-lieu').value,contact:document.getElementById('av-contact').value,infos:document.getElementById('av-infos').value,formule:window._avisFormule||'normal'}});
      closeModal();toast('Avis envoyé pour validation ✓','ok');render();
    } catch(e){toast(e.message,'err');busy(btn,false);}
  },
  jobSearch() { sessionStorage.setItem('ks_jobq', document.getElementById('job-q').value); render(); },
  jobOfferForm() {
    if (!USER) { authRequired('#/jobs'); return; }
    openModal(`<h3>💼 Proposer un job</h3><div class="muted small mb">Votre offre est examinée avant publication.</div>
      <div class="field"><label>Intitulé du poste <span class="req">*</span></label><input id="jo-title" placeholder="Ex : Chauffeur particulier"></div>
      <div class="field"><label>Description <span class="req">*</span></label><textarea id="jo-description" placeholder="Missions, attentes et conditions…"></textarea></div>
      <div class="field"><label>Compétences recherchées</label><textarea id="jo-skills" placeholder="Ex : Permis B, conduite à Abidjan…"></textarea></div>
      <div class="field"><label>Ville <span class="req">*</span></label><input id="jo-city" readonly onclick="A.villePick('jo-city')" value="${esc(USER.ville||'')}" placeholder="👆 Choisir une ville" style="cursor:pointer;background:#fff"></div>
      <div class="field"><label>Lieu / quartier</label><input id="jo-location" placeholder="Ex : Cocody Angré"></div>
      <div class="field"><label>Durée / période</label><input id="jo-duration" placeholder="Ex : CDD 6 mois, à partir de novembre"></div>
      <div class="field"><label>Rémunération</label><input id="jo-compensation" placeholder="Ex : À discuter, 150 000 FCFA / mois"></div>
      <div class="field"><label>Contact / modalités de candidature <span class="req">*</span></label><input type="tel" id="jo-contact" value="${esc(USER.phone)}"></div>
      <div class="field"><label>Précisions pour candidater</label><textarea id="jo-method" placeholder="Ex : Appelez entre 8h et 17h, envoyez votre CV…"></textarea></div>
      <button class="btn" onclick="A._sendJobOffer(this)">Proposer cette offre</button>`);
  },
  async _sendJobOffer(btn) { busy(btn,true);try { await api('/job-offers',{method:'POST',body:{title:document.getElementById('jo-title').value,description:document.getElementById('jo-description').value,skills:document.getElementById('jo-skills').value,city:document.getElementById('jo-city').value,location:document.getElementById('jo-location').value,duration:document.getElementById('jo-duration').value,compensation:document.getElementById('jo-compensation').value,contact:document.getElementById('jo-contact').value,application_method:document.getElementById('jo-method').value}});closeModal();toast('Offre envoyée pour validation ✓','ok');render();}catch(e){toast(e.message,'err');busy(btn,false);} },
  jobProfileForm() {
    if (!USER) { authRequired('#/jobs'); return; }
    REQ={photos:[]};openModal(`<h3>👤 Publier mon profil candidat</h3><div class="field"><label>Métier recherché <span class="req">*</span></label><input type="text" id="jb-metier" placeholder="Ex : Chauffeur, Ménagère…"></div><div class="field"><label>Compétences</label><input type="text" id="jb-comp"></div><div class="field"><label>Expérience</label><input type="text" id="jb-exp"></div><div class="field"><label>Localisation</label><input type="text" id="jb-loc" value="${esc(USER.address||'')}"></div><div class="field"><label>Disponibilité</label><input type="text" id="jb-dispo" placeholder="Ex : Immédiate"></div><div class="field"><label>Contact <span class="req">*</span></label><input type="tel" id="jb-contact" value="${esc(USER.phone)}"></div><div class="field"><label>CV ou photo</label><div class="photo-strip" id="jb-cv"><button class="ph-add" onclick="A.pickPhotos('jb-cv')">＋</button></div><input type="file" id="file-input" accept="image/*,.pdf" style="display:none"></div><div class="field"><label>Description</label><textarea id="jb-desc"></textarea></div><div class="muted small mb">Le profil sera visible après validation par l'administration.</div><button class="btn" onclick="A._sendJob(this)">Publier mon profil</button>`);
  },
  // Compatibilité avec les anciens liens internes : même écran, nouveau libellé.
  jobForm() { A.jobProfileForm(); },
  async _sendJob(btn) { busy(btn,true);try {await api('/jobs',{method:'POST',body:{metier:document.getElementById('jb-metier').value,competences:document.getElementById('jb-comp').value,experience:document.getElementById('jb-exp').value,localisation:document.getElementById('jb-loc').value,disponibilite:document.getElementById('jb-dispo').value,contact:document.getElementById('jb-contact').value,cv:REQ.photos[0]||null,description:document.getElementById('jb-desc').value}});closeModal();toast('Profil envoyé pour validation ✓','ok');render();}catch(e){toast(e.message,'err');busy(btn,false);}},

  /* Visibilité professionnelle */
  visSub(planId, name, price, btn) {
    openModal(`<h3>⭐ ${esc(name)}</h3>
      <p class="small">Montant : <b>${price.toLocaleString('fr-FR')} FCFA</b>.<br>Après votre souscription, réglez ce montant à Klean Services (espèces ou mobile money). Votre visibilité sera activée dès confirmation du paiement par l'administration.</p>
      <div class="btn-row"><button class="btn sec" onclick="closeModal()">Annuler</button>
      <button class="btn" onclick="A._visSub(${planId},this)">Confirmer ma souscription</button></div>`);
  },
  async _visSub(planId, btn) {
    busy(btn, true);
    try { await api('/visibilite/souscrire', { method: 'POST', body: { plan_id: planId } }); closeModal(); toast('Souscription enregistrée ✓ — en attente de paiement.', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },

  /* Campagnes publicitaires */
  async pubForm() {
    let v;
    try { v = await api('/pub'); } catch (e) { toast(e.message, 'err'); return; }
    REQ = { photos: [] };
    window._pubType = 'texte';
    openModal(`<h3>📣 Créer une campagne publicitaire</h3>
      <div class="field"><label>Format</label><div class="choices">
        ${[['texte', '📝 Texte'], ['image', '🖼️ Image'], ['video', '🎬 Vidéo']].map(([c, l], i) => `<button type="button" class="chip ${i === 0 ? 'on' : ''}" onclick="A.pickChip(this,'${c}');window._pubType='${c}'">${l}</button>`).join('')}
      </div></div>
      <div class="field"><label>Titre <span class="req">*</span></label><input type="text" id="pb-title" placeholder="Ex : Mon salon de coiffure"></div>
      <div class="field"><label>Texte de la publicité</label><textarea id="pb-content" placeholder="Décrivez votre offre…"></textarea></div>
      <div class="field"><label>Image ou vidéo (pour les formats image/vidéo)</label><div class="photo-strip" id="pb-file"><button class="ph-add" onclick="A.pickPhotos('pb-file')">＋</button></div>
      <input type="file" id="file-input" accept="image/*,video/*" style="display:none"></div>
      <div class="field"><label>Budget <span class="req">*</span></label><div class="choices" id="pb-budgets">
        ${v.budgets.map(b => `<button type="button" class="chip" onclick="A.pickChip(this,'${b}');document.getElementById('pb-budget').value='${b}'">${b.toLocaleString('fr-FR')} ${esc(v.devise)}</button>`).join('')}
      </div><input type="number" id="pb-budget" min="500" step="500" placeholder="Ou montant personnalisé"></div>
      <div class="field"><label>Durée de diffusion (jours)</label><input type="number" id="pb-duree" min="1" max="90" value="7"></div>
      <div class="field"><label>Zone ciblée (facultatif)</label><input type="text" id="pb-zone" placeholder="Ex : Bouaké — vide = partout"></div>
      <div class="field"><label>Lien (facultatif)</label><input type="text" id="pb-link" placeholder="https://… ou numéro WhatsApp"></div>
      <div class="muted small mb">Après paiement et validation par Klean Services, votre campagne est diffusée. Si tous les emplacements sont occupés, elle entre automatiquement en file d'attente.</div>
      <button class="btn" onclick="A._sendPub(this)">Envoyer ma campagne</button>`);
  },
  async _sendPub(btn) {
    busy(btn, true);
    try {
      const r = await api('/pub/campagnes', {
        method: 'POST', body: {
          type: window._pubType || 'texte', title: document.getElementById('pb-title').value,
          content: document.getElementById('pb-content').value, file: REQ.photos[0] || null,
          budget: document.getElementById('pb-budget').value, duration_days: document.getElementById('pb-duree').value,
          zone: document.getElementById('pb-zone').value, link: document.getElementById('pb-link').value
        }
      });
      closeModal(); toast('Campagne enregistrée ✓ — réglez le budget pour lancer la validation.', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },

  /* Mise en avant du profil emploi (facultative) */
  async jobBoost(id) {
    let cc;
    try { cc = await api('/commerce/config'); } catch (e) { toast(e.message, 'err'); return; }
    if (!cc.emploi.enabled) { toast('La mise en avant n\u2019est pas proposée pour le moment. Votre profil reste visible gratuitement.', 'err'); return; }
    openModal(`<h3>⭐ Mettre mon profil en avant</h3>
      <p class="small">Option <b>facultative</b> : votre profil reste visible gratuitement. La mise en avant le place en tête de liste pendant ${cc.emploi.duree_jours} jours.</p>
      <div class="btn-row" style="flex-direction:column;gap:8px">
        <button class="btn outline" onclick="A._sendBoost(${id},'avant',this)">⭐ Mis en avant — ${cc.emploi.prix_avant.toLocaleString('fr-FR')} ${esc(cc.devise)}</button>
        <button class="btn outline" onclick="A._sendBoost(${id},'prioritaire',this)">🥇 Prioritaire — ${cc.emploi.prix_prioritaire.toLocaleString('fr-FR')} ${esc(cc.devise)}</button>
        <button class="btn sec" onclick="closeModal()">Annuler</button>
      </div>`);
  },
  async _sendBoost(id, formule, btn) {
    busy(btn, true);
    try {
      const r = await api(`/jobs/${id}/boost`, { method: 'POST', body: { formule } });
      closeModal(); toast(r.status === 'active' ? 'Profil mis en avant ✓' : 'Demande enregistrée ✓ — mise en avant activée après confirmation du paiement.', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); busy(btn, false); }
  },

  /* Urgence */
  async sosConfirm() {
    if (!USER) { authRequired('#/urgence'); return; }
    let cfg; try { cfg=await api('/urgence/config'); } catch(e){ toast(e.message,'err'); return; }
    if(!cfg.assistance_available) return toast('L’assistance Klean Services est indisponible actuellement.','err');
    openModal(`<h3>🚨 Demander une assistance</h3><p class="small">Cette demande est transmise à l’équipe Klean Services. Elle ne contacte pas les secours publics.</p>
      ${cfg.categories && cfg.categories.length ? `<div class="field"><label>Catégorie <span class="req">*</span></label><select id="sos-category"><option value="">Choisir…</option>${cfg.categories.map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><textarea id="sos-msg" placeholder="Précisez la situation (facultatif)"></textarea></div><div class="btn-row"><button class="btn sec" onclick="closeModal()">Annuler</button><button class="btn warn" onclick="A._doSOS(this)">Confirmer l’envoi</button></div>`);
  },
  _doSOS(btn) {
    const cat=document.getElementById('sos-category'); if(cat && !cat.value){toast('Choisissez une catégorie d’assistance.','err');return;}
    busy(btn, true);
    const send = (lat, lng) => api('/urgence', { method: 'POST', body: { message: document.getElementById('sos-msg').value, category: cat ? cat.value : '', lat, lng } })
      .then(() => { closeModal(); toast('Demande d’assistance envoyée à l’équipe Klean Services.', 'ok'); })
      .catch(e => { toast(e.message, 'err'); busy(btn,false); });
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(p => send(p.coords.latitude, p.coords.longitude), () => send(null, null), { timeout: 5000 });
    else send(null, null);
  },
  delAddr(id) { api('/addresses/' + id, { method: 'DELETE' }).then(() => { toast('Adresse supprimée.', 'ok'); render(); }).catch(e => toast(e.message, 'err')); },
  quizPick(el, qid, j) { A.pickChip(el, String(j)); window._quizAnswers[qid] = j; },
  async shareApp() {
    if (!USER) { nav('#/login'); return; }
    try {
      const d = await api('/share/prepare', { method: 'POST' });
      const text = (d.text ? d.text + '\n' : '') + d.url;
      if (navigator.share) {
        try { await navigator.share({ title: 'Klean Services', text: d.text || 'Découvrez Klean Services', url: d.url });
          toast('La feuille de partage a été ouverte. Nous ne pouvons pas savoir si le partage externe a été envoyé.', 'ok');
        } catch (e) { if (e && e.name !== 'AbortError') throw e; }
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        openModal(`<h3>↗️ Partager l’application</h3><p class="small">Le lien a été copié. Collez-le dans WhatsApp, Messages, e-mail ou le réseau de votre choix.</p><textarea readonly style="width:100%;min-height:90px">${esc(text)}</textarea><button class="btn mt" onclick="closeModal()">Fermer</button>`);
      } else {
        openModal(`<h3>↗️ Partager l’application</h3><p class="small">Copiez ce lien et envoyez-le par le canal de votre choix.</p><textarea readonly style="width:100%;min-height:90px" onclick="this.select()">${esc(text)}</textarea><button class="btn mt" onclick="closeModal()">Fermer</button>`);
      }
    } catch (e) { toast(e.message, 'err'); }
  },
  bandeauGo(link) {
    if (!link) return;
    if (link.startsWith('#')) nav(link);
    else window.open(link, '_blank', 'noopener');
  },
  async qlRepondre(sid, index, j) {
    if (window._qlLock) return; // une seule sélection
    window._qlLock = true;
    try { await api(`/games/concours/${sid}/repondre`, { method: 'POST', body: { index, answer: j } }); }
    catch (e) { toast(e.message, 'err'); }
    window._qlLock = false;
    qlSync();
  },
  async quizRepondre(sid, j) {
    if (window._qzLock) return; // une seule sélection
    window._qzLock = true;
    quizStopTimer();
    document.querySelectorAll('.qz-opt').forEach(b => {
      b.disabled = true; b.style.opacity = '0.55';
      if (parseInt(b.dataset.j, 10) === j) { b.style.opacity = '1'; b.style.borderColor = '#16a34a'; b.style.background = '#f0fdf4'; }
    });
    try {
      await api(`/games/concours/${sid}/repondre`, { method: 'POST', body: { answer: j } });
      setTimeout(() => routes.quiz(), 450);
    } catch (e) { toast(e.message, 'err'); routes.quiz(); }
  },
  async quizPhoto(sid, decision) {
    if (decision === 'refuse' && !confirm('Confirmer le refus ? La demande ne vous sera plus jamais renvoyée.')) return;
    try { await api(`/games/concours/${sid}/photo`, { method: 'POST', body: { decision } }); toast('Votre choix a été enregistré ✓', 'ok'); routes.quiz(); }
    catch (e) { toast(e.message, 'err'); }
  },
  async quizEnvoyer(sid) {
    const inp = document.getElementById('qz-msg');
    if (!inp || !inp.value.trim()) return;
    try { await api(`/games/concours/${sid}/message`, { method: 'POST', body: { body: inp.value.trim() } }); routes.quiz(); }
    catch (e) { toast(e.message, 'err'); }
  },
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
    <p class="muted">${esc(MAINT.message || 'Klean Services est temporairement en maintenance. Nous revenons très vite. Merci de votre patience.')}</p>
    ${MAINT.until ? `<p class="small muted">Retour prévu : ${esc(MAINT.until.replace('T', ' à '))}</p>` : ''}
    <button class="btn mt" onclick="A.maintRetry()">Réessayer</button>
  </div>`;
}

function render() {
  // Un rendu complet remplace l’écran : aucun brouillon n’y survit implicitement.
  // Les écrans de formulaire réarment leur protection une fois leurs champs affichés.
  resetDraftGuard();
  currentChat = null;
  currentSupport = null;
  const h = (location.hash || '#/home').slice(2);
  const [route, ...rest] = h.split('/');
  const param = rest.join('/');
  if (route !== 'home') { const install=document.getElementById('install-cta'); if (install) install.remove(); }
  if (MAINT.active && MAINT.scope === 'F' && (!USER || USER.role !== 'pdg')) { maintenanceScreen(); return; }
  const publicRoutes = ['home','search','services','categories','request','jobs','avis-recherche','urgence','about','login','register','account'];
  if (!TOKEN && !publicRoutes.includes(route)) { publicAuthGate(); return; }
  if (USER && USER.must_change_password) { setTimeout(forcePasswordModal, 50); }
  const fn = routes[route] || routes.home;
  Promise.resolve(fn(param)).then(() => {
    if (normalHash(location.hash) === currentHash && pageNeedsDraftProtection(route)) armDraftProtection(document.getElementById('app'), route, true);
  }).catch(e => {
    $app.innerHTML = header('Erreur') + `<div class="content">${emptyState('⚠️', e.message || 'Une erreur est survenue.')}<button class="btn" onclick="render()">Réessayer</button></div>` + bottomNav('home');
  });
  window.scrollTo(0, 0);
}

/* ---------- Démarrage ---------- */
(async function init() {
  const splashStartedAt = Date.now();
  let splashReleased = false;
  // La sortie est planifiée indépendamment du réseau : un API lent ne laisse jamais le splash bloqué.
  const releaseSplash = () => { if (splashReleased) return; splashReleased = true; render(); };
  const splashTimer = setTimeout(releaseSplash, 3000);
  if ('serviceWorker' in navigator) {
    try { navigator.serviceWorker.register('/sw.js'); } catch { }
    navigator.serviceWorker.addEventListener('message', event => { const d = event.data || {}; if (d.type === 'navigate' && d.link && d.link.startsWith('#/')) nav(d.link); });
  }
  applyFont(localStorage.getItem('ks_font') || 16);
  await checkMaintenance();
  setInterval(async () => { const was = MAINT.active; await checkMaintenance(); if (was !== MAINT.active) render(); }, 60000);
  // Prix et disponibilité catalogue : l'accueil reste synchronisé avec le tableau de bord,
  // même s'il est déjà ouvert au moment où le PDG change un prix.
  setInterval(async () => {
    if (!TOKEN || (location.hash || '#/home') !== '#/home') return;
    try {
      const cityQuery = USER && USER.ville ? '?ville=' + encodeURIComponent(USER.ville) : '';
      const [services, populaires] = await Promise.all([api('/services' + cityQuery), api('/services/populaires' + cityQuery)]);
      if (JSON.stringify(services) !== JSON.stringify(SERVICES) || JSON.stringify(populaires) !== JSON.stringify(POPULAIRES)) { SERVICES = services; POPULAIRES = populaires; render(); }
    } catch { }
  }, 25000);
  if (TOKEN) {
    try {
      USER = await api('/me');
      if (USER.font_size) applyFont(USER.font_size);
      connectSSE(); refreshBadges();
    } catch { TOKEN = null; localStorage.removeItem('ks_token'); }
  }
  if (!location.hash) location.hash = '#/home';
  currentHash = normalHash(location.hash); navStack = [currentHash]; navCursor = 0;
  const releasedBeforeBoot = splashReleased;
  const splashWait = Math.max(0, 3000 - (Date.now() - splashStartedAt));
  if (!splashReleased && splashWait) await new Promise(resolve => setTimeout(resolve, splashWait));
  clearTimeout(splashTimer);
  releaseSplash();
  // Si les données de session ont fini de se charger après l'affichage initial, on rafraîchit l'écran.
  if (releasedBeforeBoot) render();
})();
