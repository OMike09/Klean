/* ═══════════════════════════════════════════════════════════════
   🛰️  NET.JS — Connexion au serveur central KLEAN (temps réel)
   ----------------------------------------------------------------
   Chargé automatiquement quand l'application est servie par
   server.js. Si le serveur est absent (ouverture du fichier
   directement), l'application reste en mode démo/simulation.
   ═══════════════════════════════════════════════════════════════ */
'use strict';
/* 🧱 filet : si net.js est chargé sans index.html (outils, tests), la lecture sûre existe quand même */
if(typeof window.kLS === 'undefined'){
  window.kLS = (function(){
    var mem = {}, ok = false;
    try{ window.localStorage.setItem('__k','1'); window.localStorage.removeItem('__k'); ok = true; }catch(e){}
    function lire(k, d){ try{ if(ok){ var v = window.localStorage.getItem(k); return v===null?d:v; } }catch(e){} return Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:d; }
    return { memoire: !ok,
      get: function(k, d){ return lire(k, d===undefined?null:d); },
      set: function(k, v){ mem[k]=String(v); if(ok){ try{ window.localStorage.setItem(k,v); }catch(e){} } return true; },
      del: function(k){ delete mem[k]; if(ok){ try{ window.localStorage.removeItem(k); }catch(e){} } return true; },
      vider: function(){ mem={}; if(ok){ try{ window.localStorage.clear(); }catch(e){} } return true; } };
  })();
}
const NET = {
  on: false, ws: null,
  deviceId: null,
  agentId: kLS.get('k2_agentId') || null,
  searchTimeout: null, animIv: null,
  posWatch: false, pos: null, pollIv: null
};

/* 📡 GPS : distance entre deux points (mètres) */
function haversineM(lat1, lon1, lat2, lon2){
  const R = 6371000, rad = Math.PI/180;
  const dLat = (lat2-lat1)*rad, dLon = (lon2-lon1)*rad;
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
/* L'agent partage sa position en continu tant qu'il est en ligne */
function netStartPosWatch(){
  if(!navigator.geolocation || NET.posWatch) return;
  NET.posWatch = true;
  navigator.geolocation.watchPosition(pos=>{
    NET.pos = {lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy||0)};
    if(agent && agent.online && NET.on)
      wsSend({type:'agent_pos', agentId:NET.agentId, jeton: (agent.jeton||kLS.get('k2_agent_jeton')||''), lat:NET.pos.lat, lng:NET.pos.lng, acc:NET.pos.acc});
  }, ()=>{}, {enableHighAccuracy:true, maximumAge:15000});
}

(function netInit(){
  if (location.protocol === 'file:') return;              // ouverture directe → démo
  fetch('/api/health', {cache:'no-store'})
    .then(r => { if(!r.ok) throw 0; return r.json(); })
    .then(() => fetch('/api/config', {cache:'no-store'}).then(r=>r.json()).then(d=>{ NET.commission = (d.commission||25)/100; }).catch(()=>{}))
    .then(() => {
      NET.deviceId = kLS.get('k2_device');
      if(!NET.deviceId){
        NET.deviceId = (crypto.randomUUID ? crypto.randomUUID() : 'dev-'+Date.now());
        kLS.set('k2_device', NET.deviceId);
      }
      connectWS();
    })
    .catch(()=>{ /* serveur absent → mode démo */ });
})();

function connectWS(){
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/ws');
  NET.ws = ws;
  ws.onopen = () => {
    NET.on = true; NET._essais = 0;
    wsSend({type:'hello', role:'client', deviceId:NET.deviceId, clientId: (typeof client!=='undefined' && client && client.id) ? client.id : null});
    applyNetOverrides();
    toast('🛰️ Connecté au serveur KLEAN — temps réel activé');
    // si un profil agent existe et était en ligne → se réannoncer
    if (agent && agent.nom && (agent.online || kLS.get('k2_stayOnline')==='1')) {
      agent.online = true; try{ saveAll(); }catch(e){}
      netAnnounceOnline(); startProStayAlive();
    }
    if(typeof refreshProOrb==='function') refreshProOrb();
  };
  ws.onmessage = ev => { try { routeNet(JSON.parse(ev.data)); } catch(e){} };
  ws.onclose = () => {
    NET.on = false;
    /* 🔁 on ne laisse JAMAIS tomber un pro en veille : on retente sans fin, de plus en plus vite si besoin */
    NET._essais = (NET._essais || 0) + 1;
    const delai = Math.min(15000, 1500 * NET._essais);
    clearTimeout(NET._reconnT);
    NET._reconnT = setTimeout(()=>{ connectWS(); }, delai);
    try{ if(typeof renderVeille==='function') renderVeille(); }catch(e){}
  };
  ws.onerror = () => { try{ if(typeof renderVeille==='function') renderVeille(); }catch(e){} };
  if(!NET._pingIv) NET._pingIv = setInterval(() => wsSend({type:'ping'}), 25000);
  if(NET._statIv) return;
  NET._statIv = setInterval(()=>{
    if(NET.on && typeof agent!=='undefined' && agent.apply && agent.apply.status==='pending' && agent.apply.agentId){
      fetch('/api/agents/'+agent.apply.agentId+'/status', {cache:'no-store'}).then(r=>r.json()).then(d=>{
        if(d.status === 'approved') agentApplyApproved();
        else if(d.status === 'rejected'){ agent.apply = {status:'rejected', reason: d.rejectReason || 'dossier incomplet'}; saveAll(); renderAgentGate(); }
      }).catch(()=>{});
    }
  }, 12000);
}
function wsSend(o){ if(NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify(o)); }

/* ═════════════════════════════════════════════════════════════════════════════════════════
   🧾 LOT 109 — LE DEVIS STRUCTURÉ, VU PAR LE CLIENT
   Le client voit le détail ligne par ligne (main-d'œuvre, matériel, déplacement, autres
   frais, remise, délai, durée, conditions), puis :
     · ✅ il ACCEPTE  → le prix est VERROUILLÉ (plus personne ne le change en silence) ;
     · 🚫 il REFUSE   → il peut dire pourquoi ; le pro peut proposer une autre version.
   Une modification doit être MOTIVÉE et repasse par le client : le prix déjà accepté
   reste en vigueur tant qu'il n'a pas accepté la nouvelle version.
   ═════════════════════════════════════════════════════════════════════════════════════════ */
const DEVIS_NOM = { main_oeuvre: 'Main-d’œuvre', materiel: 'Matériel & produits', deplacement: 'Déplacement', autre: 'Autres frais' };
function devisFmt(n){ return Number(n || 0).toLocaleString('fr-FR') + ' F'; }
function devisEnteteClient(){
  return (typeof client !== 'undefined' && client && client.token) ? { 'X-Client-Token': client.token } : {};
}
function devisLignesHtml(d){
  return ['main_oeuvre', 'materiel', 'deplacement', 'autre'].filter(function (t) {
    return (d.lignes || []).some(function (l) { return l.type === t; });
  }).map(function (t) {
    return '<div style="margin:9px 0 0"><b style="font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">' + (DEVIS_NOM[t] || t) + '</b>'
      + (d.lignes || []).filter(function (l) { return l.type === t; }).map(function (l) {
        return '<div class="rline" style="font-size:12.5px"><span>' + l.libelle
          + (l.qte > 1 ? ' <small style="color:var(--muted)">(' + l.qte + ' × ' + devisFmt(l.pu) + ')</small>' : '')
          + '</span><span>' + devisFmt(l.montant) + '</span></div>';
      }).join('') + '</div>';
  }).join('');
}
/* 🏷️ LOT 112 — LA RÉFÉRENCE MARCHÉ, toujours avec sa source et sa date.
   Elle ne change aucun prix : elle dit seulement où se situe le montant proposé. */
function marcheBlocHtml(marche){
  if(!marche) return '';
  if(!marche.trouve) return '<div style="background:#f4f7f5;border:1px dashed var(--line);border-radius:10px;padding:8px 10px;margin-top:9px;font-size:11.5px;color:var(--muted)">'
    + '🏷️ Aucune référence de marché enregistrée pour ce service : aucune comparaison n’est faite sur ce montant.</div>';
  const src = (marche.sources && marche.sources[0]) ? marche.sources[0] : '';
  const date = (marche.refs && marche.refs[0]) ? marche.refs[0].date : '';
  const couleur = marche.dans ? '#0a8a62' : '#b45309';
  const fond = marche.dans ? '#eefaf3' : '#fff8e6';
  const bord = marche.dans ? '#9fd8bf' : '#ffe0a3';
  return '<div style="background:' + fond + ';border:1px solid ' + bord + ';border-radius:11px;padding:9px 10px;margin-top:9px;font-size:12px">'
    + '<b>🏷️ Référence marché : ' + devisFmt(marche.min) + ' – ' + devisFmt(marche.max) + '</b>'
    + (date ? ' <span style="color:var(--muted)">(' + date + ')</span>' : '')
    + '<div style="color:var(--muted);margin-top:3px">Source : ' + src + '</div>'
    + '<div style="margin-top:4px;font-weight:800;color:' + couleur + '">' + (marche.dans ? '✅ ' : '⚠️ ') + marche.message + '</div>'
    + (marche.dans ? '' : '<div style="margin-top:3px;color:var(--muted)">Le montant proposé est <b>conservé tel quel</b> : il est simplement signalé aux gestionnaires Klean.</div>')
    + '</div>';
}
function devisHtml(d, infos){
  infos = infos || {};
  const verrou = infos.verrou || null;
  const enAttente = d.statut === 'envoye';
  const accepte = d.statut === 'accepte';
  const modif = d.version > 1 && d.motif;
  let h = '<div style="background:var(--card);border:1.5px solid var(--line);border-radius:16px;padding:14px">';
  h += '<div style="display:flex;align-items:center;gap:8px"><b style="font-size:15px">🧾 Devis v' + d.version + '</b>'
    + '<span style="margin-left:auto;font-size:11px;padding:3px 9px;border-radius:99px;font-weight:700;'
    + (enAttente ? 'background:#fff3df;color:#a15c00">⏳ Attend votre réponse'
      : accepte ? 'background:#e7f6ec;color:#1d7a3d">🔒 Accepté'
      : 'background:#fdeaea;color:#b3261e">🚫 Refusé') + '</span></div>';
  if (modif) h += '<div style="background:#fff3df;border:1px solid #ffd591;border-radius:10px;padding:8px 10px;margin:9px 0 0;font-size:12.5px">'
    + '<b>🔁 Le professionnel demande une modification</b><br>Motif : ' + d.motif
    + '<br><small style="color:var(--muted)">Cette version remplace le devis v' + (d.version - 1) + '.</small></div>';
  if (verrou && enAttente) h += '<div style="background:#eef6ff;border:1px solid #bcd8ff;border-radius:10px;padding:8px 10px;margin:9px 0 0;font-size:12.5px">'
    + '🔒 <b>Vous avez déjà accepté ' + devisFmt(verrou.montant) + '</b> (devis v' + verrou.version + '). Ce prix reste en vigueur : la nouvelle version ne s’appliquera que si VOUS l’acceptez.</div>';
  h += devisLignesHtml(d);
  h += '<div class="rline" style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px"><span>Sous-total</span><span>' + devisFmt(d.totalAvantRemise) + '</span></div>';
  if (d.remise > 0) h += '<div class="rline"><span>Remise</span><span style="color:var(--pd)">− ' + devisFmt(d.remise) + '</span></div>';
  h += '<div class="rline" style="font-size:17px;font-weight:800"><span>TOTAL</span><span style="color:var(--p)">' + devisFmt(d.total) + '</span></div>';
  if (d.delai || d.duree) h += '<div class="rline" style="font-size:12.5px"><span>⏱ ' + (d.delai ? 'Délai : ' + d.delai : '') + (d.duree ? (d.delai ? ' · ' : '') + 'Durée : ' + d.duree : '') + '</span><span></span></div>';
  if (d.conditions) h += '<p style="font-size:12px;color:var(--muted);margin:7px 0 0">' + d.conditions + '</p>';
  h += marcheBlocHtml(d.marche);
  if (d.inhabituel) h += '<div style="background:#fff8e6;border:1px solid #ffe0a3;border-radius:10px;padding:8px 10px;margin-top:9px;font-size:12px">'
    + '⚠️ <b>Prix inhabituel</b> par rapport à l’estimation Klean' + (d.estimation && d.estimation.total ? ' (' + devisFmt(d.estimation.total) + ')' : '')
    + '. Il n’est pas supprimé : demandez une explication au professionnel si besoin.</div>';
  if (enAttente) {
    h += '<div id="devis-refus-zone" style="display:none;margin-top:10px">'
      + '<textarea id="devis-motif" rows="2" placeholder="Dites pourquoi vous refusez (facultatif)" style="width:100%;font:inherit;padding:9px;border:1.5px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)"></textarea></div>';
    h += '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">'
      + '<button type="button" class="act-btn green" style="flex:1;min-width:150px" onclick="devisRepondre(\'' + infos.missionId + '\',true)">✅ J’accepte ce prix</button>'
      + '<button type="button" class="act-btn" id="devis-refus-btn" style="flex:1;min-width:150px;color:var(--danger);border-color:#f5c6c7" onclick="devisBasculerMotif()">🚫 Je refuse</button></div>'
      + '<button type="button" id="devis-motif-envoi" class="act-btn" style="display:none;width:100%;margin-top:8px" onclick="devisRepondre(\'' + infos.missionId + '\',false)">Envoyer mon refus</button>'
      + '<p style="font-size:11.5px;color:var(--muted);margin:8px 0 0">En acceptant, le prix est <b>verrouillé</b> : plus personne (ni Klean, ni le professionnel) ne peut le changer sans vous demander.</p>';
  } else if (accepte) {
    h += '<p style="font-size:12.5px;margin:10px 0 0;color:var(--pd)">🔒 <b>Prix accepté et verrouillé</b>'
      + (d.accepteAt || d.at ? ' le ' + String(d.accepteAt || d.at).slice(0, 10) : '')
      + '. Toute modification devra être motivée et repassera par vous.</p>';
  } else {
    h += '<p style="font-size:12.5px;margin:10px 0 0;color:var(--muted)">Vous avez refusé ce devis'
      + (d.refuseMotif ? ' (motif : ' + d.refuseMotif + ')' : '') + '. Le professionnel peut en proposer un autre.</p>';
  }
  return h + '</div>';
}
function devisRendre(infos){
  const box = document.getElementById('trk-devis'); if (!box) return;
  infos = infos || {};
  const d = infos.devis;
  if (!d || !d.version) { box.innerHTML = ''; return; }
  box.innerHTML = devisHtml(d, { missionId: infos.missionId || '', verrou: infos.verrou || (typeof mission !== 'undefined' && mission && mission.prixVerrouille) || null });
}
async function devisCharger(mid){
  if (mid === undefined || mid === null || mid === '') return;
  try {
    const r = await fetch('/api/missions/' + mid + '/devis', { cache: 'no-store', headers: devisEnteteClient() });
    if (!r.ok) return;
    const d = await r.json();
    if (typeof mission !== 'undefined' && mission && mission.id === mid) { mission.devis = d.devis; mission.prixVerrouille = d.verrou || null; }
    devisRendre({ missionId: mid, devis: d.devis, verrou: d.verrou });
    /* un devis qui attend la réponse du client : on le signale aussi à l'accueil */
    const b = document.getElementById('devis-attente-pastille');
    if (b) b.style.display = d.enAttenteDeVotreReponse ? 'inline-block' : 'none';
    return d;
  } catch (e) { return null; }
}
function devisBasculerMotif(){
  const z = document.getElementById('devis-refus-zone'), b = document.getElementById('devis-motif-envoi');
  if (z) z.style.display = 'block';
  if (b) b.style.display = 'block';
  const t = document.getElementById('devis-motif'); if (t) t.focus();
}
async function devisRepondre(mid, accepte){
  if (!mid) return;
  const zone = document.getElementById('devis-motif');
  const motif = (zone && zone.value) ? zone.value : '';
  try {
    const r = await fetch('/api/missions/' + mid + '/devis/' + (accepte ? 'accepter' : 'refuser'), {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, devisEnteteClient()),
      body: JSON.stringify(accepte ? {} : { motif: motif })
    });
    const d = await r.json().catch(function () { return {}; });
    if (!r.ok) { toast('⚠️ ' + (d.error || 'Action impossible')); return; }
    if (accepte) {
      if (typeof mission !== 'undefined' && mission) { mission.prixTotal = d.prixTotal; mission.prixVerrouille = d.verrouille; }
      toast('🔒 Prix accepté et verrouillé : ' + devisFmt(d.prixTotal));
    } else {
      toast('🚫 Devis refusé' + (d.prixEnVigueur ? ' — ' + devisFmt(d.prixEnVigueur) + ' reste en vigueur' : ''));
    }
    await devisCharger(mid);
  } catch (e) { toast('⚠️ Réseau indisponible — réessayez'); }
}
window.devisRendre = devisRendre;
window.devisHtml = devisHtml;
window.devisRepondre = devisRepondre;
window.devisBasculerMotif = devisBasculerMotif;
window.devisCharger = devisCharger;

/* 🔧 AUTO-RÉPARATION DE LA VEILLE — toutes les 30 s :
   - WebSocket coupé → on reconnecte
   - le serveur ne me voit plus (dernier contact > 70 s) → je me réannonce + heartbeat tout de suite
   - le GPS est tombé → je redemande une position
   Le pro reste « joignable » même après une coupure réseau, une mise en veille du téléphone ou un redémarrage du serveur. */
function veilleAutoRepare(){
  try{
    if(typeof agent==='undefined' || !agent || !agent.online) return;
    if(!agent.apply || agent.apply.status !== 'approved') return;
    if(!NET.on){ try{ connectWS(); }catch(e){} }
    else { netAnnounceOnline(); }
    if(typeof VEILLE==='object' && VEILLE && VEILLE.ok && VEILLE.lastSeenAge != null && VEILLE.lastSeenAge > 70){
      const tk = (agent && agent.jeton) || kLS.get('k2_agent_jeton') || '';
      try{ fetch('/api/agents/heartbeat',{method:'POST',headers:Object.assign({'Content-Type':'application/json'}, (tk?{'X-Agent-Token':tk}:{})),
        body: JSON.stringify(Object.assign({agentId:NET.agentId, stayOnline:true, jeton:tk, villeService:(agent.villeService||agent.ville||'')}, (NET.pos?{lat:NET.pos.lat,lng:NET.pos.lng,acc:NET.pos.acc}:{})))}).catch(()=>{}); }catch(e){}
      try{ toast('🛰️ Veille relancée — le serveur vous retrouve'); }catch(e){}
    }
    if(!NET.pos){ try{ netStartPosWatch(); }catch(e){} }
    try{ if(typeof verifierVeille==='function') verifierVeille(); }catch(e){}
  }catch(e){}
}
if(typeof window!=='undefined' && !window._kleanVeilleAuto){
  window._kleanVeilleAuto = true;
  setInterval(veilleAutoRepare, 30000);
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') setTimeout(veilleAutoRepare, 800); });
}

/* ───────── Remplacement des flux simulés par les flux réels ───────── */
function applyNetOverrides(){
  window.launchSearch   = netLaunchSearch;
  window.cancelSearch   = netCancelSearch;
  window.cancelMission  = netCancelMission;
  window.showRequest    = netShowRequest;
  window.answerRequest  = netAnswerRequest;
  window.toggleOnline   = netToggleOnline;
  window.quickOnboard   = netQuickOnboard;
  window.advanceMission = netAdvanceMission;
  window.forceRequest   = netForceInfo;
  window.renderAgentHist= netRenderAgentHist;
}

/* ══════════ CÔTÉ CLIENT ══════════ */
async function netLaunchSearch(){
  c.nom = document.querySelector('#inp-nom').value.trim();
  c.tel = document.querySelector('#inp-tel').value.trim();
  const _bd = document.querySelector('#bk-desc');
  c.desc = (_bd ? _bd.value : '').trim().slice(0,280);
  c.photos = (window._customPhotos || []).slice(0, 3);
  if(document.querySelector('#inp-budget')) c.budget = parseInt((document.querySelector('#inp-budget').value||'').replace(/\D/g,'')) || 0;
  /* 📚 catalogue national : la chaîne comprise (catégorie → service → sous-service → tâche)
     et TOUTES les tâches cochées partent avec la demande — le pro doit les maîtriser. */
  try{
    if(c && typeof RECH !== 'undefined' && RECH && RECH.chaine && (!c.service || c.service === RECH.svc || RECH.svc === '')){
      c.chaine = RECH.chaine;
      const tas = [RECH.chaine.tache].concat(RECH.autres || []).filter(Boolean).slice(0, 8);
      if(tas.length) c.taches = tas;
    }
    if(c && typeof RECH !== 'undefined' && RECH && RECH.tachesDemandees && RECH.tachesDemandees.length > 1) c.taches = RECH.tachesDemandees.slice(0, 8);
  }catch(e){}
  if(c.service==='cours' && !c.desc) return toast('📖 Précisez la matière ou le domaine du coach');
  if(c.service==='custom' && (!c.desc || c.desc.length < 8)) return toast('📝 Décrivez votre besoin en quelques mots');
  if(!c.nom) return toast('Indiquez votre nom 👤');
  if(c.tel.replace(/\D/g,'').length < 8) return toast('Numéro invalide 📞');

  /* 👤 Un client doit être INSCRIT pour trouver un agent */
  if(typeof client === 'undefined' || !client || !client.token || !client.id){
    toast('👤 Créez votre compte gratuit (30 secondes) pour réserver — sécurité des professionnels 🛡️');
    setTimeout(() => {
      showView('view-account', document.querySelector('#nav-client .nav-btn[data-v=view-account]') || document.querySelector('#nav-client .nav-btn:last-child'), 'client');
    }, 700);
    return;
  }

  /* ⏸️ Maximum 3 missions actives simultanées */
  const _act = bookings.filter(b => !['terminee','annulee'].includes(b.status)).length;
  if(_act >= 3) return toast('⏸️ Vous avez déjà 3 missions en cours — attendez qu\'une se termine');

  const p = calcPrice(c);
  let created;
  try{
    const headers = {'Content-Type':'application/json'};
    if(typeof client!=='undefined' && client && client.token) headers['X-Client-Token'] = client.token;
    const r = await fetch('/api/missions', {
      method:'POST', headers,
      /* 💰 le prix affiché vient du MOTEUR DE TARIFICATION (serveur). On envoie les réponses
         détaillées (detail:true) : le serveur recalcule et c'est SON prix qui fait foi. */
      body: JSON.stringify({...c, detail:true,
        reponses:Object.assign({}, c.reponses||{}),      /* ❓ lot 108 : les réponses aux questions partent telles quelles */
        criteres:{ quantite:c.pieces, niveau:c.depth, etat:c.etat, urgence:c.urgence, options:Object.keys(c.extras||{}).filter(k=>c.extras[k]),
                   photos:(c.photos||[]).length, promo:c.promo, ville:(typeof cityName==='function'? cityName(c.city):(c.city||'')) },
        tarifVersion: (typeof TARIF!=='undefined' && TARIF && TARIF.version)||0,
        prixTotal:p.total, quote: c.service==='custom', photos: c.photos||[], deviceId:NET.deviceId, ville: (typeof cityName==='function'? cityName(c.city): (c.city||'')), cityNom: (typeof cityName==='function'? cityName(c.city): (c.city||''))})
    });
    created = await r.json().catch(()=>({}));
    if(!r.ok) return toast('⚠️ '+(created.error||'Demande refusée'));
  }catch(e){ return toast('Serveur injoignable — réessayez'); }

  mission = {
    id: created.id, ...JSON.parse(JSON.stringify(c)),
    prix: p, status:'recherche', createdAt:Date.now(),
    agent:null, dist: (typeof created.dist === 'number' ? created.dist : null), eta: 0, rated: 0
  };
  bookings.unshift({...mission}); saveAll();
  showView('view-search', document.querySelector('#nav-client .nav-btn:nth-child(3)'), 'client');
  const _cible = (c && c.cible) ? c.cible : null;
  document.querySelector('#search-msg').textContent = _cible
    ? ('🎯 Demande envoyée d’abord à ' + (_cible.nom||'votre pro') + ' — s’il ne répond pas en 25 s, elle part chez les autres pros du métier…')
    : '📡 Demande envoyée dans votre ville — GPS d’abord, sinon numéros pour appeler…';
  try{ delete c.cible; if(typeof rechBandeauCible==='function') rechBandeauCible(); }catch(e){}
  wsSend({type:'subscribe_mission', missionId: mission.id});
  startMatchBoard(mission.id, typeof cityName==='function'? cityName(c.city): (c.city||''));
  clearTimeout(NET.searchTimeout);
  NET.searchTimeout = setTimeout(()=>{
    if(mission && mission.status==='recherche'){
      document.querySelector('#search-msg').textContent = '🌍 Élargi à toute la Côte d’Ivoire — GPS ou appel…';
      startMatchBoard(mission.id, typeof cityName==='function'? cityName(c.city): (c.city||''), 'all');
    }
  }, 25000);
}
function startMatchBoard(missionId, ville, scope){
  clearInterval(NET.matchIv);
  const paint = async ()=>{
    const box=document.getElementById('match-board'); if(!box) return;
    try{
      const headers={};
      if(typeof client!=='undefined' && client && client.token) headers['X-Client-Token']=client.token;
      const q='ville='+encodeURIComponent(ville||'')+'&missionId='+encodeURIComponent(missionId||'')+'&scope='+(scope||'city')+(typeof c!=='undefined'&&c.lat?('&lat='+c.lat+'&lng='+c.lng):'');
      const d=await fetch('/api/match?'+q,{headers, cache:'no-store'}).then(r=>r.json());
      const row=(list, title)=>{
        if(!list||!list.length) return '';
        return '<b style="display:block;margin:10px 0 6px;font-size:13px">'+title+'</b>'+list.map(p=>{
          const km = (p.distTxt || (p.distKm!=null ? (p.distApprox?'≈ ':'📡 ')+p.distKm+' km' : '')) || '📞 Pas de GPS';
          const tel = p.telAffiche && p.tel ? ('<a href="tel:+225'+p.tel.replace(/^225/,'')+'" style="display:inline-block;margin-top:6px;background:#ff8a00;color:#1a1204;font-weight:900;padding:8px 12px;border-radius:10px;text-decoration:none">📞 Appeler '+p.tel+'</a>') : '<span style="font-size:11px;color:#6b7c73">En attente d’acceptation GPS</span>';
          return '<div style="background:#fff;border:1.5px solid #e4eae7;border-radius:14px;padding:10px 12px;margin-bottom:8px"><b>'+(p.nom||'Pro')+'</b> '+(p.online?'<span style="color:#0da678;font-size:11px;font-weight:800">● en ligne</span>':'<span style="color:#6b7c73;font-size:11px">hors ligne</span>')+'<br><small>'+(p.ville||'')+(p.quartier?' · '+p.quartier:'')+' · '+km+'</small><div>'+tel+'</div></div>';
        }).join('');
      };
      box.innerHTML = '<div style="background:#fff;border-radius:16px;padding:12px;border:1.5px solid #e4eae7"><b style="font-size:14px">Moteur KLEAN — mise en contact</b><p style="font-size:12px;color:#6b7c73;margin:4px 0 0">'+(d.nOnline||0)+' pro(s) en ligne · '+(d.nSame||0)+' dans votre ville · '+(d.nOther||0)+' ailleurs</p>'+row(d.sameCity,'🏙️ Dans votre ville')+row(d.otherCities,'🌍 Autres villes')+'</div>';
    }catch(e){}
  };
  paint();
  NET.matchIv = setInterval(paint, 4000);
}
function matchCardHTML(p){
  const km = (p.distTxt || (p.distKm!=null ? ((p.distApprox?'≈ ':'📡 ')+p.distKm+' km') : '')) || '📞 Sans GPS';
  const tel = (p.tel||'').replace(/\D/g,'');
  const call = (p.telAffiche && tel)
    ? ('<a href="tel:+225'+tel.replace(/^225/,'')+'" style="display:inline-block;margin:6px 6px 0 0;background:#ff8a00;color:#1a1204;font-weight:900;padding:8px 12px;border-radius:10px;text-decoration:none">📞 '+tel+'</a>'
      +'<a href="https://wa.me/225'+tel.replace(/^225/,'')+'" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px;background:#25d366;color:#fff;font-weight:900;padding:8px 12px;border-radius:10px;text-decoration:none">💬 WhatsApp</a>')
    : '<span style="font-size:11.5px;color:#0a8a62;font-weight:800">📡 GPS actif — réservez, il reçoit la demande</span>';
  const metier=(p.services&&p.services.length)?p.services.slice(0,3).join(', '):'';
  return '<div style="background:#fff;border:1.5px solid #e4eae7;border-radius:14px;padding:10px 12px;margin-bottom:8px"><b>'+(p.nom||'Pro')+'</b> '+(p.online?'<span style="color:#0da678;font-size:11px;font-weight:800">● en ligne</span>':'<span style="color:#6b7c73;font-size:11px">hors ligne</span>')+'<br><small>'+(p.ville||'')+(p.quartier?' · '+p.quartier:'')+' · '+km+(metier?' · '+metier:'')+'</small><div>'+call+'</div></div>';
}
async function loadHomeEngine(){
  const box=document.getElementById('engine-home'); if(!box) return;
  const ville = (typeof cityName==='function' && typeof c!=='undefined') ? cityName(c.city) : '';
  try{
    const headers={}; if(typeof client!=='undefined' && client && client.token) headers['X-Client-Token']=client.token;
    const svc=(typeof c!=='undefined'&&c.service)?c.service:'';
    const d=await fetch('/api/match?ville='+encodeURIComponent(ville)+'&scope=all&service='+encodeURIComponent(svc)+(typeof c!=='undefined'&&c.lat?('&lat='+c.lat+'&lng='+c.lng):''),{headers,cache:'no-store'}).then(r=>r.json());
    const empty='<p style="font-size:12.5px;color:#6b7c73;margin:8px 0 0">Aucun professionnel inscrit ici pour l’instant. Changez de ville ou réservez — la demande partira dès qu’un pro est en ligne.</p>';
    box.innerHTML = '<div style="background:#fff;border-radius:16px;padding:12px;border:1.5px solid #e4eae7"><b style="font-size:14.5px">📍 Moteur KLEAN — vous retrouver</b><p style="font-size:12px;color:#6b7c73;margin:4px 0 8px">Même ville d’abord (GPS ou appel). Puis les autres villes. Sans GPS, le numéro s’affiche.</p>'
      + (d.sameCity&&d.sameCity.length? '<b style="font-size:13px">🏙️ '+ville+'</b>'+d.sameCity.map(matchCardHTML).join('') : empty)
      + (d.otherCities&&d.otherCities.length? '<b style="display:block;margin-top:10px;font-size:13px">🌍 Autres villes</b>'+d.otherCities.slice(0,12).map(matchCardHTML).join('') : '')
      + '</div>';
  }catch(e){ box.innerHTML=''; }
}
async function loadProRoam(){
  const box=document.getElementById('pro-roam'); if(!box) return;
  const svcs=(agent&&agent.apply&&agent.apply.services)||(agent&&agent.services)||[];
  const svc=svcs[0]||'';
  const ici=(NET.pos?'📡 GPS actif — vous êtes visible là où vous êtes.':'📞 Sans GPS — les clients voient votre numéro.');
  try{
    const d=await fetch('/api/pros/peers?service='+encodeURIComponent(svc)+'&self='+encodeURIComponent(NET.agentId||''),{cache:'no-store'}).then(r=>r.json());
    const peers=(d.peers||[]).slice(0,15);
    box.innerHTML='<div style="background:#fff;border:1.5px solid #e4eae7;border-radius:14px;padding:12px"><b>🌍 Actif partout</b><p style="font-size:12px;color:#6b7c73;margin:4px 0 8px">'+ici+' Les clients cherchent votre métier partout en Côte d’Ivoire.</p>'
      +(peers.length?('<small style="font-weight:800">Autres pros du même domaine ('+svc+')</small>'+peers.map(p=>'<div style="padding:7px 0;border-bottom:1px solid #e4eae7;font-size:13px"><b>'+p.nom+'</b> · '+(p.ville||p.villeIci||'')+' '+(p.online?'●':'○')+(p.telAffiche&&p.tel?(' · '+p.tel):'')+'</div>').join('')):'<p style="font-size:12px;color:#6b7c73">Pas encore d’autre pro sur ce métier.</p>')
      +'</div>';
  }catch(e){ box.innerHTML='<div style="background:#fff;border-radius:14px;padding:12px;border:1.5px solid #e4eae7"><b>🌍 Actif partout</b><p style="font-size:12px;margin:4px 0 0;color:#6b7c73">'+ici+'</p></div>'; }
}
if(typeof window!=='undefined'){
  window.loadHomeEngine = loadHomeEngine;
  window.loadProRoam = loadProRoam;
  setTimeout(loadHomeEngine, 800); setInterval(loadHomeEngine, 20000);
  setTimeout(loadProRoam, 1200); setInterval(loadProRoam, 25000);
}


function netCancelSearch(){
  clearTimeout(NET.searchTimeout); clearInterval(NET.animIv); clearInterval(NET.matchIv);
  if(mission){ netCancelOnServer(); mission.status='annulee'; syncBooking(); mission=null; }
  searchTimers.forEach(clearTimeout);
  showView('view-home', document.querySelector('#nav-client .nav-btn'), 'client');
  toast('Recherche annulée');
}
function netCancelMission(){
  if(!mission || ['terminee','annulee','encours'].includes(mission.status)) return toast('Annulation impossible à ce stade');
  if(confirm('Annuler la mission ? (gratuit tant que l\'agent n\'est pas arrivé)')){
    netCancelOnServer();
    clearInterval(NET.animIv);
    mission.status='annulee'; syncBooking(); mission=null;
    showView('view-home', document.querySelector('#nav-client .nav-btn'), 'client');
    toast('Mission annulée');
  }
}
function netCancelOnServer(){
  fetch('/api/missions/'+mission.id+'/cancel', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'}).catch(()=>{});
}
function netStartRoute(){
  // animation visuelle du trajet (le statut réel vient du serveur + position GPS)
  clearInterval(sim);
  netStartTrackPoll();
  const start = {x: 40+Math.random()*80, y: 30+Math.random()*60};
  const ctrl  = {x:(start.x+CLIENT_POS.x)/2 + 30, y:(start.y+CLIENT_POS.y)/2 - 34};
  /* 📍 on n'invente PAS de distance : si le serveur n'en connaît pas, la route s'affiche sans chiffre */
  mission._route = {start, ctrl, end:CLIENT_POS, dist0: (typeof mission.dist === 'number' && mission.dist > 0) ? mission.dist : null, dur: 45, t: 0};
  document.querySelector('#route-path').setAttribute('d', `M${start.x} ${start.y} Q${ctrl.x} ${ctrl.y} ${CLIENT_POS.x} ${CLIENT_POS.y}`);
  renderTrack();
  clearInterval(NET.animIv);
  NET.animIv = setInterval(()=>{
    if(!mission || mission.status!=='enroute') return;
    mission._route.t += 1;
    const r = mission._route;
    const k = Math.min(0.9, (r.t / r.dur) * 0.9);      // on avance jusqu'à 90% et on attend l'événement "arrive"
    if(r.dist0 !== null && r.dist0 !== undefined){        /* chiffre connu seulement */
      mission.dist = Math.max(0.2, r.dist0*(1-k));
      mission.eta = Math.max(1, Math.round(r.dist0*4*(1-k)));
    }
    if(document.querySelector('#view-track').classList.contains('active')){
      const q = quad(r.start, r.ctrl, r.end, k);
      document.querySelector('#pin-agent').setAttribute('transform',`translate(${q.x},${q.y})`);
    }
    refreshTrackNumbers();
  },1000);
}
/* 📡 Suivi GPS : interroge le serveur pour la vraie position de l'agent */
function netStartTrackPoll(){
  clearInterval(NET.pollIv);
  NET.pollIv = setInterval(async ()=>{
    if(!mission || mission.status !== 'enroute') return;
    try{
      const r = await fetch('/api/missions/'+mission.id, {cache:'no-store',
        headers: (typeof client!=='undefined' && client && client.token) ? {'X-Client-Token': client.token} : {}});
      if(!r.ok) return;
      const d = await r.json();
      if(d.agentPos && typeof mission.lat === 'number' && mission.lat !== null){
        const km = haversineM(mission.lat, mission.lng, d.agentPos.lat, d.agentPos.lng)/1000;
        mission.dist = Math.max(km, 0.1);
        mission.eta  = Math.max(1, Math.ceil(mission.dist*4));
        refreshTrackNumbers();
        if(mission._route && document.querySelector('#view-track').classList.contains('active')){
          const p = Math.max(0, Math.min(0.95, 1 - mission.dist/Math.max(mission._route.dist0, 0.5)));
          const q = quad(mission._route.start, mission._route.ctrl, mission._route.end, p);
          document.querySelector('#pin-agent').setAttribute('transform',`translate(${q.x},${q.y})`);
        }
      }
    }catch(e){}
  }, 5000);
}
function netSnapArrive(){
  clearInterval(NET.animIv); clearInterval(NET.pollIv);
  if(mission && mission._route){
    const q = quad(mission._route.start, mission._route.ctrl, mission._route.end, 1);
    document.querySelector('#pin-agent').setAttribute('transform',`translate(${q.x},${q.y})`);
  }
  if(mission){ mission.dist = 0; }
}
function refreshTrackNumbers(){
  if(!mission) return;
  const km = document.querySelector('#trk-km'), eta = document.querySelector('#trk-eta');
  if(km) km.textContent = Math.max(mission.dist,0).toFixed(1)+' km';
  if(eta && mission.status==='enroute') eta.textContent = '~'+mission.eta+' min';
}
function netStartWork(){
  let wp = 0;
  clearInterval(NET.animIv); clearInterval(NET.pollIv);
  NET.animIv = setInterval(()=>{
    wp = Math.min(95, wp+3);                     // on attend le vrai événement "terminee" pour 100%
    if(document.querySelector('#view-track').classList.contains('active')){
      document.querySelector('#trk-progress').style.width = wp+'%';
      document.querySelector('#trk-progress-txt').textContent = 'Nettoyage en cours… '+wp+'%';
    }
  },1000);
}

/* ───────── Messages serveur ───────── */
function routeNet(msg){
  switch(msg.type){

    case 'agent_approved':
      if(agent.apply) agentApplyApproved();
      else { toast('🎉 Votre dossier est validé !'); renderAgentGate && renderAgentGate(); }
      break;

    case 'agent_rejected':
      if(agent.apply){ agent.apply = {status:'rejected', reason: msg.reason || 'dossier incomplet'}; saveAll(); renderAgentGate(); }
      toast('😕 Candidature non retenue');
      break;

    case 'agent_pending':
      toast('⏳ Dossier en vérification par KLEAN');
      break;

    case 'agent_denied':
      if(msg.reason === 'blocked'){
        agent.online = false; if(agent.apply) agent.apply = {status:'blocked'};
        saveAll(); try{ renderAgentGate && renderAgentGate(); }catch(e){}
        toast('⛔ Compte suspendu par le gestionnaire — contactez le support');
      }
      else if(msg.reason === 'apply'){ toast('🛡️ Envoyez d\'abord votre dossier de candidature'); if(agent.nom){ agent.nom=''; saveAll(); } renderAgentGate && renderAgentGate(); }
      else toast('🛡️ Accès agent refusé');
      break;

    case 'agent_registered':
      NET.agentId = msg.agentId;
      kLS.set('k2_agentId', msg.agentId);
      break;

    case 'rel_message':                  // 🤝 lot 118 : la mise en relation bouge (message ou prix)
      try{
        if(REL && REL.missionId === msg.missionId && typeof relCharger === 'function') relCharger(REL.missionId, REL.role);
        if(msg.role === 'pro') toast('💬 Nouveau message du professionnel');
      }catch(e){}
      break;

    case 'devis':                        // 🧾 nouveau devis, acceptation ou refus (lot 109)
      try{
        const mid = msg.missionId;
        try{ if(REL && REL.missionId === mid && typeof relCharger === 'function') relCharger(mid, REL.role); }catch(e2){}
        if(mid){ if(mission && mission.id === mid && msg.prixVerrouille){ mission.prixVerrouille = { montant: msg.prixVerrouille, version: msg.version, date: new Date().toISOString(), par: 'client' }; } devisCharger(mid); }
        if(msg.statut === 'envoye') toast('🧾 ' + (msg.version > 1 ? 'Devis modifié (v' + msg.version + ')' : 'Nouveau devis (v' + msg.version + ')') + ' : ' + devisFmt(msg.total) + ' — ouvrez le suivi pour répondre'
          + (msg.motif ? '\nMotif : ' + msg.motif : ''));
        else if(msg.statut === 'accepte') toast('🔒 Prix verrouillé : ' + devisFmt(msg.total));
        else if(msg.statut === 'refuse') toast('🚫 Devis refusé');
      }catch(e){}
      break;

    case 'quote_offer':
      if(mission && mission.id===msg.missionId){
        const ok=confirm('💰 KLEAN propose '+Number(msg.prix||0).toLocaleString('fr-FR')+' F pour votre demande sur mesure. Accepter ?');
        fetch('/api/missions/quote-reply',{method:'POST',headers:Object.assign({'Content-Type':'application/json'}, (typeof client!=='undefined'&&client&&client.token)?{'X-Client-Token':client.token}:{}), body:JSON.stringify({id:msg.missionId, accept:!!ok})}).then(r=>r.json()).then(d=>{
          if(ok && d.ok) toast('✅ Prix accepté — recherche d’un pro…');
          else toast('Demande annulée');
        }).catch(()=>{});
      } else toast('💰 Nouveau prix proposé pour une demande sur mesure');
      break;

    case 'paiement_update':           // 💳 statut d'un paiement (client & pro)
      try{
        if(typeof PAY_SUIVI !== 'undefined' && PAY_SUIVI && msg.paiement && msg.paiement.id === PAY_SUIVI.id){
          if(typeof payerMaj === 'function') payerMaj(msg.paiement);
        }
        const st = msg.paiement && msg.paiement.statut;
        if(st === 'reussi') toast('✅ Paiement ' + ((msg.paiement||{}).ref||'') + ' confirmé par Klean');
        else if(st === 'echoue') toast('❌ Paiement ' + ((msg.paiement||{}).ref||'') + ' refusé — voyez le motif');
      }catch(e){}
      break;

    case 'mission_request':            // → AGENT : nouvelle demande
      if(!agent.online || !agent.nom) break;
      if(incomingReq || activeMission) break;
      netShowRequest(msg.mission);
      /* 🎯 le client a demandé CE pro précisément depuis sa fiche */
      if(msg.mission && msg.mission.pourVous){
        toast('⭐ Le client vous a choisi directement — répondez vite !');
        try{
          const sub = document.querySelector('#req-sub');
          if(sub) sub.innerHTML = '<b style="color:#0a8a62">⭐ Demande directe — ce client vous a choisi</b><br>' + sub.innerHTML;
        }catch(e){}
      }
      break;

    case 'mission_taken':              // → AGENT : un autre agent a pris la demande
      if(incomingReq && incomingReq.id === msg.missionId){
        hideRequest(); toast('⚡ Mission prise par un autre agent');
      }
      break;

    case 'mission_reassigned':        // → AGENT : le gestionnaire lui a retiré cette mission
      if(incomingReq && incomingReq.id === msg.missionId) hideRequest();
      toast('⤴ Mission retirée — réattribuée par le gestionnaire');
      break;

    case 'support_msg':               // → PRO : l'équipe a répondu au support
      toast('💬 Réponse du support KLEAN' + (msg.par ? ' (' + msg.par + ')' : ''));
      try { if (window.supRefreshBadge) window.supRefreshBadge(); } catch (e) { }
      break;

    case 'services_deploy':           // → TOUS : le HQ a publié de nouveaux services
      try { if (window.kleanOnServicesDeploy) window.kleanOnServicesDeploy(msg); } catch (e) { }
      break;

    case 'catalogue_maj':             // → TOUS : le PDG a touché au catalogue national
      try { if (window.kleanOnCatalogueMaj) window.kleanOnCatalogueMaj(msg); } catch (e) { }
      break;

    case 'cities_deploy':             // → TOUS : le HQ a publié une ville
      try { if (window.kleanOnCitiesDeploy) window.kleanOnCitiesDeploy(msg); } catch (e) { }
      break;

    /* 🧩 LOT 123 — les grandes options de la page d'accueil (registre centralisé).
       Le PDG change un réglage ou demande une réparation : l'application suit SANS rechargement. */
    case 'accueil_maj':               // → TOUS : une option de l'accueil a changé
      try { if (window.kleanOnAccueilMaj) window.kleanOnAccueilMaj(msg); } catch (e) { }
      break;

    case 'accueil_ordre':             // → TOUS : le tableau de bord demande une réparation / actualisation
      try { if (window.kleanOnAccueilOrdre) window.kleanOnAccueilOrdre(msg); } catch (e) { }
      break;

    case 'job_candidature':           // → CLIENT : quelqu'un a proposé ses services pour votre demande
      toast('📨 ' + (msg.nom || 'Une personne') + ' s’est proposé(e) pour votre demande — KLEAN vous met en relation');
      try { if (window.kleanOnJobsMaj) window.kleanOnJobsMaj(msg); } catch (e) { }
      break;

    case 'avis_maj':                  // → TOUS : un avis de recherche a été publié / modéré
      try { if (window.kleanOnAvisMaj) window.kleanOnAvisMaj(msg); } catch (e) { }
      break;

    /* 💼 LOT 124 — recherche d'emploi & mise en relation : chacun est prévenu en direct */
    case 'trav_contact':              // → quelqu'un demande votre contact
      toast('🤝 ' + (msg.nom || 'Une personne') + ' veut vous contacter' + (msg.sujet ? ' — ' + msg.sujet : ''));
      try { if (window.kleanOnTravMaj) window.kleanOnTravMaj(msg); } catch (e) { }
      break;

    case 'trav_msg':                  // → nouveau message dans une discussion de mise en relation
      toast('💬 Nouveau message' + (msg.texte ? ' : ' + String(msg.texte).slice(0, 50) : ''));
      try { if (window.kleanOnTravMaj) window.kleanOnTravMaj(msg); } catch (e) { }
      break;

    case 'trav_decision':             // → le contact a été accepté ou refusé
      toast(msg.message || (msg.statut === 'acceptee' ? '✅ Contact accepté' : 'Demande de contact refusée'));
      try { if (window.kleanOnTravMaj) window.kleanOnTravMaj(msg); } catch (e) { }
      break;

    case 'trav_reponse':              // → quelqu'un propose ses services pour votre recherche
      toast('🙋 ' + (msg.nom || 'Quelqu’un') + ' propose ses services' + (msg.tel ? ' — ' + msg.tel : ''));
      try { if (window.kleanOnTravMaj) window.kleanOnTravMaj(msg); } catch (e) { }
      break;

    case 'trav_profil':               // → une personne correspond à ce que vous cherchez
      toast('💼 ' + (msg.resume || 'Une personne cherche du travail près de vous'));
      try { if (window.kleanOnTravMaj) window.kleanOnTravMaj(msg); } catch (e) { }
      break;

    case 'trav_besoin':               // → un professionnel recherche quelqu'un comme vous
      toast('🧑‍💼 ' + (msg.resume || 'On cherche quelqu’un qui correspond à votre profil'));
      try { if (window.kleanOnTravMaj) window.kleanOnTravMaj(msg); } catch (e) { }
      break;

    case 'veille_rappel':             // → PRO en veille : rappel GPS / sonnerie
      toast('🛰️ ' + (msg.text || 'Vérifiez votre GPS et vos sonneries'));
      try { if (typeof verifierVeille === 'function') verifierVeille(true); } catch (e) { }
      break;

    case 'mission_update': {           // → CLIENT (et agent assigné)
      // côté agent : le client a annulé
      if(activeMission && activeMission.id === msg.missionId && msg.status === 'annulee'){
        activeMission = null; renderAgentDash();
        toast('😕 Le client a annulé la mission');
        break;
      }
      if(!mission || mission.id !== msg.missionId) break;
      handleMissionUpdate(msg);
      break;
    }
  }
}
function handleMissionUpdate(msg){
  clearTimeout(NET.searchTimeout);
  const st = msg.status;
  if(st === 'accepted' && msg.agent){
    mission.agent = { nom: msg.agent.nom, note: msg.agent.note || 5, missions: msg.agent.missions || 0, tel: (msg.agent.tel||'').replace(/\D/g,''), photo: msg.agent.photo || null };
    mission.dist = (typeof msg.dist === 'number') ? msg.dist : (typeof mission.dist === 'number' ? mission.dist : null);
    // 📍 distance réelle si le serveur a la position GPS de l'agent
    if(msg.agentPos && typeof mission.lat === 'number' && mission.lat !== null){
      mission.dist = haversineM(mission.lat, mission.lng, msg.agentPos.lat, msg.agentPos.lng)/1000;
    }
    mission.status = 'enroute'; syncBooking();
    const card = document.querySelector('#found-card');
    card.style.display = 'block';
    document.querySelector('#found-agent').innerHTML = agentRowHTML(mission.agent, mission.dist);
    document.querySelector('#search-msg').innerHTML = '✅ <b style="color:var(--pd)">'+mission.agent.nom+' a accepté votre mission !</b>';
    setTimeout(()=>{ showView('view-track', document.querySelector('#nav-client .nav-btn:nth-child(3)'), 'client'); netStartRoute(); }, 2000);
  }
  else if(st === 'enroute'){ /* déjà en cours d'animation */ }
  else if(st === 'arrive'){
    mission.status = 'arrive'; syncBooking(); netSnapArrive(); renderTrack();
  }
  else if(st === 'encours'){
    mission.status = 'encours'; syncBooking(); renderTrack(); netStartWork();
  }
  else if(st === 'terminee'){
    clearInterval(NET.animIv);
    mission.status = 'terminee'; mission.dist = 0; syncBooking(); renderTrack();
    const bar = document.querySelector('#trk-progress');
    if(bar){ bar.style.width='100%'; document.querySelector('#trk-progress-txt').textContent='Nettoyage en cours… 100%'; }
    toast('✅ Mission terminée ! Notez votre agent ⭐');
  }
  else if(st === 'annulee'){
    mission.status = 'annulee'; syncBooking();
  }
}

/* ══════════ CÔTÉ AGENT ══════════ */
async function netEnsureAgentRegistered(){
  if(NET.agentId) return NET.agentId;
  const r = await fetch('/api/health').catch(()=>null);
  // l'inscription se fait via le WS agent_online (le serveur crée l'agent)
  return new Promise(resolve=>{
    const iv = setInterval(()=>{ if(NET.agentId){ clearInterval(iv); resolve(NET.agentId); } }, 300);
    netAnnounceOnline();
    setTimeout(()=>{ clearInterval(iv); resolve(NET.agentId); }, 5000);
  });
}
function netAnnounceOnline(){
  netStartPosWatch();
  wsSend({type:'agent_online', agentId:NET.agentId, nom:agent.nom, quartier:agent.quartier, tel:agent.tel, ville: agent.ville || (typeof cityName==='function'?cityName(typeof c!=='undefined'&&c.city): '') || '', villeService: agent.villeService || agent.ville || ''});
  try{ if(typeof verifierVeille==='function') verifierVeille(); }catch(e){}
}
async function netQuickOnboard(){
  const nom = document.querySelector('#ob-nom').value.trim();
  if(!nom) return toast('Indiquez votre nom 👤');
  agent.nom = nom; agent.quartier = document.querySelector('#ob-quartier').value; agent.online = true;
  saveAll(); renderAgentDash();
  netAnnounceOnline();
  toast('🎉 Bienvenue '+nom+' ! Vous êtes en ligne.');
}
function startProStayAlive(){
  try{ kLS.set('k2_stayOnline','1'); }catch(e){}
  netStartPosWatch();
  try{ if(navigator.wakeLock) navigator.wakeLock.request('screen').then(l=>{ window._kleanLock=l; }).catch(()=>{}); }catch(e){}
  try{ if(typeof agentPushActivate==='function') agentPushActivate(); else if(typeof agentPushEnsure==='function') agentPushEnsure(); }catch(e){}
  if(NET._hb) return;
  const beat=()=>{
    if(!agent || !agent.online || !NET.agentId) return;
    const body={agentId:NET.agentId, stayOnline:true, villeService: (agent && (agent.villeService||agent.ville)) || '',
      jeton: (agent && agent.jeton) || kLS.get('k2_agent_jeton') || ''};
    if(NET.pos){ body.lat=NET.pos.lat; body.lng=NET.pos.lng; body.acc=NET.pos.acc; }
    fetch('/api/agents/heartbeat',{method:'POST',headers:Object.assign({'Content-Type':'application/json'}, (body.jeton?{'X-Agent-Token':body.jeton}:{})),body:JSON.stringify(body)})
      .then(r=>r.ok?r.json():r.json().then(e=>({erreurHTTP:r.status, ...e})).catch(()=>({erreurHTTP:r.status})))
      .then(d=>{
        if(!d) return;
        /* 🔒 jeton refusé : ce téléphone doit confirmer son code d'accès (une seule fois) */
        if(d.code === 'jeton' || d.erreurHTTP === 401){
          if(!NET._jetonAlerte || (Date.now() - NET._jetonAlerte) > 120000){
            NET._jetonAlerte = Date.now();
            if(typeof recupererJeton === 'function') recupererJeton('Ce téléphone doit confirmer votre identité une fois pour envoyer votre position et recevoir les missions.');
          }
          return;
        }
        if(d.jeton && agent){ agent.jeton = d.jeton; try{ kLS.set('k2_agent_jeton', d.jeton); }catch(e){} }
        if(d.numPro && agent && !agent.numPro) agent.numPro = d.numPro;
        if(d.posRefusee){
          NET._posRefus = (NET._posRefus||0)+1;
          if(NET._posRefus === 3) toast('📡 Position refusée par le serveur — vérifiez votre GPS');
        }
      }).catch(()=>{});
    if(NET.on) netAnnounceOnline();
  };
  NET._hb=setInterval(beat, 20000);
  beat();
  if(!NET._vis){
    NET._vis=true;
    document.addEventListener('visibilitychange', ()=>{
      if(document.visibilityState==='visible' && agent && agent.online){
        try{ if(navigator.wakeLock) navigator.wakeLock.request('screen').then(l=>{ window._kleanLock=l; }).catch(()=>{}); }catch(e){}
        beat();
      }
    });
  }
}
function stopProStayAlive(){
  try{ kLS.del('k2_stayOnline'); }catch(e){}
  if(NET._hb){ clearInterval(NET._hb); NET._hb=null; }
  try{ window._kleanLock && window._kleanLock.release(); }catch(e){}
}
function netToggleOnline(){
  if(!agent.apply || agent.apply.status !== 'approved'){
    return toast('🛡️ Dossier à valider, ou liez le compte créé par le PDG/gest (tél + code)');
  }
  if(!agent.nom) return toast('Complétez d\'abord votre dossier 👤');
  agent.online = !agent.online; saveAll(); renderAgentDash();
  if(typeof refreshProOrb==='function') refreshProOrb();
  if(agent.online){
    agentAlertUnlock && agentAlertUnlock();
    netAnnounceOnline();
    startProStayAlive();
    toast('🟢 En ligne partout — GPS + sonnerie même en veille');
  } else {
    stopProStayAlive();
    wsSend({type:'agent_offline', agentId:NET.agentId});
    toast('⚪ Hors ligne'); hideRequest();
  }
}
function netForceInfo(){ toast('🛰️ Temps réel actif : les demandes arrivent toutes seules'); }

function netShowRequest(m){
  try{ if(typeof playAgentAlert === 'function') playAgentAlert(); }catch(e){}
  // 📍 Distance réelle GPS si on connaît notre position ET celle du client
  let distShown = m.dist || 0;
  if(NET.pos && typeof m.lat === 'number'){
    distShown = haversineM(NET.pos.lat, NET.pos.lng, m.lat, m.lng)/1000;
  }
  incomingReq = {
    id: m.id, service: m.service, pieces: m.pieces, depth: m.depth,
    extras:{}, prix:{total:m.prixTotal, svc:SERVICES.find(s=>s.id===m.service), baseSvc:m.prixTotal},
    client:m.clientNom, quartier:m.quartier, adresse:'', time:m.time, dist:distShown, clientLat:m.lat, clientLng:m.lng, server:true
  };
  const p = incomingReq.prix;
  const gain = p.total*(1-(NET.commission||0.25));
  const gpsTag = (NET.pos && typeof m.lat === 'number') ? ' (GPS réel 📡)' : '';
  document.querySelector('#req-sub').textContent = m.clientNom+' · 📍 '+m.quartier+' · '+distShown.toFixed(1)+' km de vous';
  document.querySelector('#req-lines').innerHTML = `
    <div class="rline"><span>${p.svc.ic} ${p.svc.nom}</span><span>${fmt(p.svc.base)}</span></div>
    <div class="rline"><span>🛏️ ${m.pieces} pièce(s) · ${m.depth}</span><span></span></div>
    <div class="rline"><span>🕐 ${formatDate(m.date||'')} à ${m.time}</span><span></span></div>
    ${m.desc ? `<div class=\"rline\" style=\"background:var(--pl);border-radius:8px;padding:6px 8px\"><span>📝 ${m.desc}</span><span></span></div>` : ''}
    ${(m.taches && m.taches.length) ? `<div class=\"rline\" style=\"background:#FFF8EE;border-radius:8px;padding:6px 8px\"><span>🧾 Tâches demandées : ${m.taches.join(' + ')}</span><span></span></div>` : ''}
    ${m.chaine ? `<div class=\"rline\"><span>📚 ${[m.chaine.categorie, m.chaine.service, m.chaine.sous].filter(Boolean).join(' › ')}</span><span></span></div>` : ''}
    ${m.reglemente ? `<div class=\"rline\" style=\"background:#FFF8EE;border-radius:8px;padding:6px 8px\"><span>🩺 Prestation réglementée — réservée aux professionnels habilités</span><span></span></div>` : ''}
    ${m.budget ? `<div class=\"rline\"><span>💰 Budget client indicatif</span><span>${fmt(m.budget)}</span></div>` : ''}
    <div class="rline"><span>📍 Distance${gpsTag}</span><span>${distShown.toFixed(1)} km</span></div>
    <div class="rline total"><span>Montant mission</span><span>${fmt(p.total)}</span></div>`;
  if(m.photos && m.photos.length){
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;margin-top:8px';
    row.innerHTML = m.photos.map((ph,i)=>`<button style="flex:1;padding:0;border:1px solid var(--line);border-radius:9px;overflow:hidden;background:var(--card2);cursor:pointer" onclick="viewMissionPhoto(${i})"><img src="${ph}" style="width:100%;height:70px;object-fit:cover;display:block"></button>`).join('');
    document.querySelector('#req-lines').appendChild(row);
    window._missionPhotos = m.photos;
  }
  document.querySelector('#req-gain').textContent = fmt(gain);
  document.querySelector('#req-modal-bg').classList.add('show');
  let left = 20; const CIRC = 144.5;
  document.querySelector('#req-count').textContent = left;
  document.querySelector('#req-ring').style.strokeDashoffset = 0;
  clearInterval(reqCountdown);
  reqCountdown = setInterval(()=>{
    left--;
    document.querySelector('#req-count').textContent = Math.max(0,left);
    document.querySelector('#req-ring').style.strokeDashoffset = CIRC*(1-left/20);
    if(left<=0){ hideRequest(); }
  },1000);
}
async function netAnswerRequest(accept){
  if(!incomingReq) return;
  if(!accept){ hideRequest(); return; }
  const reqId = incomingReq.id;
  let res;
  try{
    const r = await fetch('/api/missions/'+reqId+'/accept', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({agentId: NET.agentId})
    });
    res = r;
  }catch(e){ return toast('Serveur injoignable'); }
  if(res.status === 409){ hideRequest(); return toast('⚡ Trop tard — prise par un autre agent'); }
  if(!res.ok){ return toast('Erreur — réessayez'); }
  const data = await res.json();
  activeMission = {...incomingReq, clientTel: data.clientTel || '', stage:1, startedAt:Date.now(), server:true};
  hideRequest();
  renderAgentDash();
  toast('✓ Mission acceptée ! En route 🛵');
}
async function netAdvanceMission(){
  const STATUS = {1:'enroute', 2:'arrive', 3:'encours', 4:'terminee'};
  const st = STATUS[activeMission.stage];
  try{
    const r = await fetch('/api/missions/'+activeMission.id+'/status', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({agentId:NET.agentId, status: st})
    });
    if(!r.ok) throw 0;
    const data = await r.json();
    if(st === 'terminee'){
      const gain = data.gain, comm = data.comm;
      agent.gains.today += gain; agent.gains.total += gain; agent.gains.comm += comm;
      agent.missionsDone = data.stats.missionsDone; agent.rating = data.stats.rating;
      agent.hist.unshift({
        id:activeMission.id, service:activeMission.service, quartier:activeMission.quartier,
        date:new Date().toLocaleDateString('fr-FR',{day:'numeric',month:'short'}),
        montant:activeMission.prix.total, gain, comm, note:5
      });
      activeMission = null; saveAll(); renderAgentDash();
      toast('💰 +'+fmt(gain)+' ! Mission terminée.');
      return;
    }
    activeMission.stage++;
    renderMissionPanel();
  }catch(e){ toast('Erreur réseau — réessayez'); }
}
async function netRenderAgentHist(){
  freshGains();
  const el = document.querySelector('#agent-hist');
  el.innerHTML = '<div class="empty" style="padding:20px">Chargement…</div>';
  let data = null;
  if(NET.agentId){
    try{
      const r = await fetch('/api/agents/'+NET.agentId+'/summary');
      if(r.ok) data = await r.json();
    }catch(e){}
  }
  if(!data){ el.innerHTML = '<div class="empty" style="padding:30px 16px"><div class="ic">🧾</div><b>Pas encore de mission</b><p>Passez en ligne pour recevoir vos premières demandes réelles.</p></div>'; document.querySelector('#hist-total').innerHTML=''; return; }
  const st = data.stats;
  document.querySelector('#hist-total').innerHTML = `
    <div class="rline"><span>Missions réalisées</span><span>${st.missionsDone}</span></div>
    <div class="rline"><span>Vos gains (75%)</span><span style="color:var(--pd);font-weight:800">${fmt(st.gain)}</span></div>
    <div class="rline total"><span>Commission KLEAN (25%)</span><span>${fmt(st.comm)}</span></div>`;
  if(!st.hist.length){ el.innerHTML = '<div class="empty" style="padding:30px 16px"><div class="ic">🧾</div><b>Pas encore de mission</b><p>Passez en ligne pour recevoir vos demandes.</p></div>'; return; }
  el.innerHTML = st.hist.map(h=>{
    const svc = SERVICES.find(s=>s.id===h.service)||{ic:'🧹',nom:h.service};
    return `<div class="hist-item">
      <div><b>${svc.ic} ${svc.nom}</b><small>${h.date||''} · ${h.quartier||''} · ${'⭐'.repeat(h.note||5)}</small></div>
      <div class="amt"><b>+${fmt(h.gain)}</b><small>−${fmt(h.comm)} KLEAN</small></div>
    </div>`;
  }).join('');
  // synchronise le tableau de bord
  agent.missionsDone = st.missionsDone; agent.rating = st.rating; saveAll();
}

/* Afficher une photo de mission en grand */
function viewMissionPhoto(i){
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;display:flex;align-items:center;justify-content:center;padding:14px';
  ov.innerHTML = `<img src="${window._missionPhotos[i]}" style="max-width:100%;max-height:88vh;border-radius:12px"><button style="position:absolute;top:14px;right:16px;background:var(--card2);border:1px solid var(--line);color:var(--ink);font-size:20px;width:38px;height:38px;border-radius:50%;cursor:pointer">✕</button>`;
  ov.onclick = () => ov.remove();
  document.body.appendChild(ov);
}


/* ═══════════════════════ 📣 AFFICHE (mise à jour / annonce du PDG) ═══════════════════════
   → bandeau discret en haut de l'app + mémoire pour ne pas repousser deux fois la même annonce
   → bandeau « MISE À JOUR » affiché automatiquement quand le serveur change de version       */
function renderAnnonceBanner(a) {
  const el = document.getElementById('ann-bar');
  if (el) el.remove();
  return;
  let _dead = document.getElementById('ann-bar');
  if (!a) { if (_dead) _dead.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'ann-bar';
    el.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9400;max-width:520px;width:calc(100% - 20px);';
    document.body.appendChild(el);
  }
  const C = { maj: '#ffb020', info: '#15c98a', alerte: '#ff6b6b' }[a.type] || '#ffb020';
  const I = { maj: '\u2728', info: '\u2139\uFE0F', alerte: '\u26A0\uFE0F' }[a.type] || '\uD83D\uDCE3';
  const T = { maj: 'MISE À JOUR KLEAN', info: 'INFO KLEAN', alerte: 'IMPORTANT — KLEAN' }[a.type] || 'KLEAN';
  el.innerHTML =
    '<div style="background:var(--card);border:1.5px solid ' + C + ';border-radius:14px;padding:11px 13px;display:flex;align-items:flex-start;gap:9px;box-shadow:0 12px 34px rgba(0,0,0,.4)">' +
    '<span style="font-size:16px;flex:none">' + I + '</span>' +
    '<div style="flex:1;min-width:0">' +
    '<b style="font-size:10.5px;letter-spacing:.5px;color:' + C + '">' + T + '</b>' +
    '<div style="font-size:13px;line-height:1.45;margin-top:2px">' + a.message + '</div>' +
    (a.force ? '<button onclick="location.reload(true)" style="margin-top:7px;background:' + C + ';color:#10130f;border:none;font-weight:900;font-size:11.5px;padding:7px 13px;border-radius:9px;cursor:pointer;font-family:inherit">\uD83D\uDD04 Actualiser l\u2019application</button>' : '') +
    '</div>' +
    '<button onclick="fermerAnnonce()" style="flex:none;background:none;border:none;color:var(--muted);font-size:15px;cursor:pointer;padding:0 2px;line-height:1">\u2715</button>' +
    '</div>';
}
window._annId = null;
function fermerAnnonce() {
  if (window._annId) try { kLS.set('klean_ann_cachee', window._annId); } catch (e) { }
  const el = document.getElementById('ann-bar');
  if (el) el.remove();
}
async function checkAnnonce() {
  try {
    const r = await fetch('/api/annonce', { cache: 'no-store' });
    const d = await r.json();
    if (!d || !d.ok) return;
    if (d.version) {
      const lastV = kLS.get('klean_version');
      kLS.set('klean_version', d.version);
      if (lastV && lastV !== d.version && kLS.get('klean_ann_cachee') !== 'v' + d.version) {
        window._annId = 'v' + d.version;
        renderAnnonceBanner({ id: window._annId, type: 'maj', force: true, message: 'KLEAN vient d\u2019être modernisé (' + d.version + '). Rechargez pour profiter des dernières nouveautés.' });
        return;
      }
    }
    if (d.annonce && kLS.get('klean_ann_cachee') !== d.annonce.id) {
      window._annId = d.annonce.id;
      renderAnnonceBanner(d.annonce);
      return;
    }
    if (!d.annonce) renderAnnonceBanner(null);
  } catch (e) { /* silencieux : hivernage ou démo locale */ }
}
window.addEventListener('load', function () { checkAnnonce(); setInterval(checkAnnonce, 60000); syncSupFlag(); setInterval(syncSupFlag, 20000); });
async function syncSupFlag(){
  try{
    const d=await fetch('/api/config',{cache:'no-store'}).then(r=>r.json());
    window._supChatOff = d.supportChat===false;
    placeSupFab();
  }catch(e){}
}


/* ═══════════════════ 💬 SUPPORT INTERNE (client & pro ↔ équipe) ═══════════════════
   Bulle flottante en bas de l'app + fil direct avec l'équipe.
   Le client s'identifie par son jeton, le professionnel par son agentId.            */
function supId() {
  try {
    if (typeof client !== 'undefined' && client && client.token) return { h: { 'X-Client-Token': client.token }, body: {}, qs: '' };
  } catch (e) { }
  const aid = (NET && NET.agentId) || kLS.get('k2_agentId') || '';
  if (aid) return { h: { 'Content-Type': 'application/json' }, body: { agentId: aid }, qs: '?agentId=' + encodeURIComponent(aid) };
  return null;
}
let _supBuild = false, _supTimer = null, _supUnread = 0;
function supBuild() {
  if (_supBuild) return; _supBuild = true;
  const css = document.createElement('style');
  css.textContent = `
#sup-fab{display:none !important}
#sup-pane{position:fixed;left:0;right:0;bottom:0;z-index:9700;max-width:520px;margin:0 auto;background:var(--card);border-top-left-radius:20px;border-top-right-radius:20px;box-shadow:0 -14px 44px rgba(0,0,0,.5);padding:14px 14px 0;display:none;flex-direction:column;max-height:72vh}
#sup-msgs2{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:7px;padding:4px 2px;min-height:170px}
.sup-b{max-width:82%;border-radius:12px;padding:8px 11px;font-size:13.5px;line-height:1.42;word-break:break-word}
.sup-b small{display:block;margin-top:3px;font-size:9.5px;color:var(--muted)}`;
  document.head.appendChild(css);
  const oldFab = document.getElementById('sup-fab'); if (oldFab) oldFab.remove();
  const pane = document.createElement('div');
  pane.id = 'sup-pane';
  pane.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px">' +
    '<div><b style="font-size:15px">Contactez Klean-Service</b><div style="font-size:11px;color:var(--muted)">Échange direct avec l’équipe KLEAN</div></div>' +
    '<button onclick="supClose()" style="background:var(--card2);border:1px solid var(--line);color:var(--muted);width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:15px">✕</button></div>' +
    '<div id="sup-msgs2"></div>' +
    '<div style="display:flex;gap:7px;padding:10px 0 12px">' +
    '<input id="sup-in" maxlength="400" placeholder="Écrivez votre message…" style="flex:1;padding:12px;border-radius:12px;border:1.5px solid var(--line);background:var(--card2);color:var(--ink);font:inherit;font-size:13.5px">' +
    '<button onclick="supSend()" style="background:var(--p);border:none;color:#04130c;font-weight:900;padding:0 16px;border-radius:12px;cursor:pointer;font-family:inherit;font-size:14px">➤</button></div>';
  document.body.appendChild(pane);
  const oldFab2 = document.getElementById('sup-fab'); if (oldFab2) oldFab2.remove();
  setInterval(supRefreshBadge, 30000);
}
function placeSupFab(){
  const fab=document.getElementById('sup-fab'); if(fab) fab.remove();
  return;
  if(window._supChatOff){ if(fab) fab.style.display='none'; return; }
  if(!fab) return;
  const bar=document.getElementById('aff-bar');
  const on=bar && !bar.classList.contains('hidden') && bar.style.display!=='none';
  fab.style.bottom = on ? 'calc(138px + env(safe-area-inset-bottom, 0px))' : '96px';
}
async function supRefreshBadge() {
  const id = supId(); if (!id) return;
  try {
    const r = await fetch('/api/support/mine' + (id.qs ? id.qs + '&' : '?') + 'peek=1', { headers: id.h });
    const d = await r.json().catch(() => ({}));
    _supUnread = (d && d.unread) || 0;
    const b = document.getElementById('sup-bdg');
    if (b) { b.textContent = _supUnread > 9 ? '9+' : _supUnread; b.style.display = _supUnread ? 'flex' : 'none'; }
  } catch (e) { }
}
window.supRefreshBadge = supRefreshBadge;
function supRender(list) {
  const box = document.getElementById('sup-msgs2'); if (!box) return;
  if (list === null) {
    box.innerHTML = '<div class="sup-b" style="background:var(--card2);border:1px solid var(--line);align-self:center;color:var(--muted)">Créez un compte pour écrire au support.<small>Accueil → inscription en 1 min</small></div>';
    return;
  }
  box.innerHTML = (list || []).map(s => {
    const me = s.from === 'user';
    return '<div class="sup-b" style="align-self:' + (me ? 'flex-end;background:rgba(21,201,138,.16);border:1px solid rgba(21,201,138,.4)' : 'flex-start;background:var(--card2);border:1px solid var(--line)') + '">' +
      s.text + '<small>' + (me ? 'vous' : ('Support' + (s.par ? ' · ' + s.par : ''))) + ' · ' + (s.at || '').slice(11, 16) + '</small></div>';
  }).join('') || '<div class="sup-b" style="background:var(--card2);border:1px solid var(--line);align-self:flex-start">Bonjour ! 👋 Écrivez-nous ici — un souci de mission, une question, une idée ?<small>Support KLEAN</small></div>';
  box.scrollTop = box.scrollHeight;
}
function supOpen() {
  if (window._supChatOff) { toast('⛔ Contactez Klean-Service est désactivé par le PDG'); return; }
  supBuild();
  document.getElementById('sup-pane').style.display = 'flex';
  supLoad();
  if (_supTimer) clearInterval(_supTimer);
  _supTimer = setInterval(supLoad, 8000);
}
function supClose() {
  document.getElementById('sup-pane').style.display = 'none';
  if (_supTimer) { clearInterval(_supTimer); _supTimer = null; }
}
window.supClose = supClose;
async function supLoad() {
  const id = supId();
  if (!id) { supRender(null); return; }
  try {
    const r = await fetch('/api/support/mine' + id.qs, { headers: id.h });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) { supRender(null); return; }
    supRender(d.messages || []);
    if (d.unread) supRefreshBadge();
  } catch (e) { }
}
async function supSend() {
  const id = supId();
  const inp = document.getElementById('sup-in');
  const text = (inp && inp.value || '').trim();
  if (!id) { toast('🗣️ Créez d\u2019abord un compte pour écrire au support'); return; }
  if (text.length < 2) return;
  const r = await fetch('/api/support/send', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, id.h),
    body: JSON.stringify(Object.assign({ text }, id.body))
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { toast('⚠️ ' + (d.error || 'Envoi impossible')); return; }
  inp.value = '';
  supLoad();
}
window.supSend = supSend;
/* 📞 deux noms pour le même écran : le secours de la page (index.html) cherche d'abord « ...Reel ».
   Ainsi, si net.js est chargé, c'est TOUJOURS le vrai écran de contact qui s'ouvre ; sinon le secours
   prend le relais et le bouton n'est jamais muet. */
window.openKleanServiceReel = function(){ try{ supOpen(); }catch(e){} };
window.openKleanService = function(){ return window.openKleanServiceReel(); };
window.addEventListener('load', function(){ try{ supBuild(); const f=document.getElementById('sup-fab'); if(f) f.remove(); }catch(e){} });

/* ═════════════════════════════════════════════════════════════════════════
   🤝 LOT 118 — MISE EN RELATION CLIENT ↔ PROFESSIONNEL (dans l'application)
   · une demande → UN professionnel 1 → s'il refuse, UN professionnel 2 → fin ;
   · la conversation est courte : réponses rapides, 240 caractères, 8 messages ;
   · le PRIX a sa propre bulle, séparée des messages ;
   · ce qui sert à sortir de Klean (numéro, lien, WhatsApp…) est refusé.
   Rien n'est supprimé : le devis du lot 109 reste la seule source du prix.
   ═════════════════════════════════════════════════════════════════════════ */
let REL = { missionId: null, role: 'client', d: null, occupe: false, cible: '#trk-rel' };
function relEntetes(role) {
  if (role === 'pro') { try { return jetonProHeaders(); } catch (e) { return { 'Content-Type': 'application/json' }; } }
  return Object.assign({ 'Content-Type': 'application/json' }, devisEnteteClient());
}
function relFmt(n) { return Number(n || 0).toLocaleString('fr-FR') + ' FCFA'; }
const REL_ETAPE = {
  attente: '1️⃣ Mise en relation', devis: '2️⃣ Prix proposé — décision du client', prix_accepte: '3️⃣ Prix accepté',
  paiement: '4️⃣ Paiement', prestation: '5️⃣ Prestation en cours', prestation_terminee: '✅ Prestation terminée', annulee: '⛔ Demande arrêtée'
};
const REL_SENS = { en_attente: '⏳ en attente de sa réponse', accepte: '✅ a accepté', refuse: '❌ refusé / non disponible' };
async function relCharger(mid, role, cible) {
  if (!mid) return null;
  REL.missionId = mid; REL.role = role === 'pro' ? 'pro' : 'client';
  if (cible) REL.cible = cible;
  const box = document.querySelector(REL.cible);
  try {
    const r = await fetch('/api/missions/' + mid + '/rel', { cache: 'no-store', headers: relEntetes(REL.role) });
    if (!r.ok) { if (box) box.innerHTML = ''; return null; }
    REL.d = await r.json(); relRendre(); return REL.d;
  } catch (e) { if (box) box.innerHTML = ''; return null; }
}
function relRendre() {
  const box = document.querySelector(REL.cible);
  if (!box || !REL.d) return;
  box.innerHTML = relHtml(REL.d, REL.role);
}
function relHtml(d, role) {
  const pro = role === 'pro';
  const suite = (d.hist || []);
  const dem = d.demande || { version: 1, modif: null };
  let h = '<div style="border:1.5px solid rgba(194,65,12,.35);border-radius:16px;padding:12px;background:var(--pl)">'
    + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
    + '<b style="font-size:14px">🤝 Mise en relation</b>'
    + '<span style="margin-left:auto;font-size:11px;font-weight:900;background:#fff;border-radius:20px;padding:3px 9px;border:1px solid rgba(194,65,12,.35)">' + (REL_ETAPE[d.etape] || '') + '</span></div>'
    + '<div style="margin-top:7px;font-size:13px;font-weight:900;color:var(--pd)">' + (d.etatTxt || '') + '</div>'
    + '<p style="font-size:11.5px;color:var(--muted);margin:4px 0 0">Règle Klean : 1 demande → professionnel 1 → s’il refuse, professionnel 2 → fin. '
    + 'Jamais de 3ᵉ proposition ; après le 2ᵉ essai, la demande reprend le lendemain.</p>';
  /* ✍️ la demande et ses modifications : jamais perdues, visibles des deux côtés */
  h += '<div style="margin-top:8px;background:#fff;border:1px solid var(--line);border-radius:11px;padding:8px 9px;font-size:12px">'
    + '<b>📝 Demande v' + (dem.version || 1) + '</b> · ' + (d.desc ? String(d.desc).slice(0, 160) : '')
    + (dem.modif && dem.modif.statut === 'en_attente_nouveau_prix'
        ? '<div style="margin-top:4px;color:#b45309;font-weight:800">✍️ Le client a modifié sa demande le ' + String(dem.modif.at || '').replace('T',' ').slice(0,16)
          + (dem.modif.motif ? ' (« ' + dem.modif.motif + ' »)' : '') + ' — ' + (pro ? 'proposez un NOUVEAU prix.' : 'le prix accepté reste en vigueur jusqu’à votre décision sur le nouveau prix.') + '</div>'
        : (dem.modif && dem.modif.statut === 'nouvelle_proposition'
            ? '<div style="margin-top:4px;color:#b45309;font-weight:800">💰 Nouveau prix proposé pour cette demande modifiée — ' + (pro ? 'en attente de la décision du client.' : 'à accepter ou refuser.') + '</div>'
            : (dem.modif && dem.modif.statut === 'acceptee' ? '<div style="margin-top:4px;color:#0a8a62;font-weight:800">✅ Demande modifiée, nouveau prix accepté explicitement.</div>' : '')))
    + ((dem.hist || []).length > 1 ? '<details style="margin-top:4px"><summary style="cursor:pointer;color:var(--muted)">historique des modifications (' + ((dem.hist || []).length) + ')</summary>'
        + (dem.hist || []).map(function(x){ return '<div style="font-size:11px;color:var(--muted);border-top:1px solid var(--line);padding:3px 0">v' + x.version + ' · ' + String(x.at||'').replace('T',' ').slice(0,16) + ' · ' + (x.par||'') + ' · ' + (x.motif||'') + '</div>'; }).join('')
        + '</details>' : '')
    + '</div>'
    + (REL.role === 'client' ? '<button type="button" onclick="relModifierDemande()" style="margin-top:7px;background:#fff;border:1.5px solid var(--pd);color:var(--pd);border-radius:11px;padding:8px 11px;font-weight:900;font-size:12.5px;cursor:pointer">✍️ Modifier ma demande</button>' : '');
  /* les professionnels contactés */
  h += '<div style="margin-top:9px;display:flex;flex-direction:column;gap:5px">'
    + (d.pros || []).map(function (p) {
      return '<div style="display:flex;gap:7px;align-items:center;font-size:12.5px;background:#fff;border-radius:10px;padding:7px 9px">'
        + '<b>Pro ' + p.rang + '</b><span style="flex:1">' + (p.nom || '') + '</span><span style="font-weight:800">' + (REL_SENS[p.sens] || p.sens) + '</span></div>';
    }).join('') || '<div style="font-size:12.5px">Aucun professionnel encore contacté.</div>'
    + '</div>';
  /* 💰 la BULLE PRIX, séparée des messages */
  if (d.prix && d.prix.version) {
    const v = d.prix, vf = d.prixVerrouille;
    h += '<div style="margin-top:10px;border:2px solid ' + (vf ? '#0a8a62' : 'var(--p)') + ';border-radius:13px;padding:11px;background:#fff">'
      + '<div style="display:flex;align-items:center;gap:6px"><b style="font-size:13px">💰 PRIX</b>'
      + '<span style="margin-left:auto;font-size:11px;color:var(--muted)">devis v' + v.version + ' · ' + String(v.at || '').slice(0, 10) + '</span></div>'
      + '<div style="font-size:19px;font-weight:900;margin:6px 0 2px">Prix de devis : ' + relFmt(v.total).replace(' FCFA', ' FCFA') + '</div>'
      + (v.estModification ? '<div style="font-size:11.5px;color:var(--muted)">↻ nouvelle proposition après le premier prix</div>' : '');
    if (vf) h += '<div style="font-size:12.5px;font-weight:800;color:#0a8a62;margin-top:5px">🔒 Montant officiel de la prestation : ' + relFmt(vf.montant)
      + ' (accepté le ' + String(vf.date || '').slice(0, 16).replace('T', ' ') + ')</div>'
      + '<button type="button" class="act-btn" style="width:100%;margin-top:8px" onclick="relPayerMaintenant()">💳 Aller au paiement</button>';
    else if (v.statut === 'envoye' && !pro) h += '<div style="display:flex;gap:7px;margin-top:9px;flex-wrap:wrap">'
      + '<button type="button" class="act-btn green" style="flex:1;min-width:132px" onclick="relPrixDecision(\'accepter\')">✓ Accepter le prix</button>'
      + '<button type="button" class="act-btn" style="flex:1;min-width:132px;color:var(--danger);border-color:#f5c6c7" onclick="relBasculerMotif()">✕ Refuser</button>'
      + '<button type="button" class="act-btn" style="flex:1;min-width:132px" onclick="relPrecision()">↩ Demander une précision</button></div>'
      + '<div id="rel-motif-zone" style="display:none;margin-top:8px"><input id="rel-motif" placeholder="Pourquoi refusez-vous ce prix ? (facultatif)" style="width:100%;font:inherit;padding:9px;border:1.5px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)">'
      + '<button type="button" class="act-btn" style="width:100%;margin-top:7px" onclick="relPrixDecision(\'refuser\')">Envoyer mon refus — le droit au 2ᵉ professionnel s’ouvre</button></div>';
    else if (v.statut === 'envoye') h += '<div style="font-size:12.5px;margin-top:6px;color:var(--muted)">⏳ En attente de la décision du client.</div>';
    else if (v.statut === 'refuse') h += '<div style="font-size:12.5px;margin-top:6px;color:var(--muted)">🚫 Prix refusé par le client (le professionnel concerné sort du jeu).</div>';
    h += marcheBlocHtml(v.marche);   /* 🏷️ lot 112 : la référence marché, avec sa source et sa date */
    if (pro && (d.etat === 'pro1_accepte' || d.etat === 'pro2_accepte'))
      h += '<div style="margin-top:9px"><input id="rel-prix-montant" type="number" min="500" step="500" placeholder="Montant en FCFA (ex : 25000)" style="width:100%;font:inherit;padding:9px;border:1.5px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)">'
        + '<input id="rel-prix-libelle" placeholder="Ce que comprend ce prix (ex : main-d’œuvre + produit)" style="width:100%;font:inherit;padding:9px;border:1.5px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);margin-top:6px">'
        + '<button type="button" class="act-btn green" style="width:100%;margin-top:7px" onclick="relPrixEnvoyer()">💰 Envoyer mon prix au client</button></div>';
    h += '</div>';
  }
  /* le fil des messages */
  h += '<div style="margin-top:10px;max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:6px" id="rel-fil">'
    + (d.msgs || []).map(function (m) {
      if (m.type === 'prix') return '<div style="align-self:' + (m.role === role ? 'flex-end' : 'flex-start') + ';max-width:88%;border-radius:12px;padding:8px 10px;font-size:12.5px;font-weight:800;background:' + (m.decision === 'accepte' ? '#e6f7ef' : (m.decision === 'refuse' ? '#fdeaea' : '#fff8e6')) + ';border:1px solid ' + (m.decision === 'accepte' ? '#9fd8bf' : (m.decision === 'refuse' ? '#f0b5b5' : '#f0d79a')) + '">'
        + '💰 PRIX : ' + relFmt(m.montant) + (m.decision ? (m.decision === 'accepte' ? ' — ✓ accepté' : ' — ✕ refusé') : ' — proposition') + '</div>';
      if (m.type === 'systeme' || m.role === 'systeme') return '<div style="align-self:stretch;font-size:11.5px;color:#6b5b45;background:#fff6e8;border:1px dashed #e8cf9f;border-radius:10px;padding:7px 9px">' + m.texte + '</div>';
      return '<div style="align-self:' + (m.role === role ? 'flex-end' : 'flex-start') + ';max-width:88%;background:' + (m.role === role ? '#fff' : '#f2f6f4') + ';border:1px solid var(--line);border-radius:12px;padding:8px 10px;font-size:13px">'
        + '<b style="font-size:11px;color:var(--muted);display:block">' + (m.de) + ' · ' + String(m.at || '').slice(11, 16) + '</b>' + m.texte + '</div>';
    }).join('')
    + '</div>';
  /* les réponses rapides (uniquement ce qui est utile à cette étape) */
  const rp = (d.rapides || {})[role] || [];
  h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">'
    + rp.map(function (t) { return '<button type="button" class="act-btn" style="font-size:11.5px;padding:6px 9px" onclick="relRapide(' + JSON.stringify(t).replace(/"/g, '&quot;') + ')">' + t + '</button>'; }).join('')
    + '</div>';
  /* écrire (court) */
  const max = (d.limites || {}).msgMaxCar || 240;
  h += '<div style="display:flex;gap:6px;margin-top:9px;align-items:center">'
    + '<input id="rel-saisie" maxlength="' + max + '" placeholder="Message court (max ' + max + ' caractères)" style="flex:1;font:inherit;padding:9px;border:1.5px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)">'
    + '<button type="button" class="act-btn" onclick="relEnvoyer()">Envoyer</button></div>'
    + '<p style="font-size:11px;color:var(--muted);margin:6px 0 0">✂️ Conversation courte : ' + ((d.limites || {}).msgMaxParCote || 8) + ' messages maximum chacun, '
    + max + ' caractères par message. 🛡️ Les numéros, liens et contacts extérieurs sont refusés — la prestation et le paiement passent par Klean.</p>';
  /* fin de recherche : reprise demain */
  if (d.etat === 'aucun_pro') {
    h += '<div style="margin-top:9px;border-top:1px dashed rgba(194,65,12,.4);padding-top:9px">';
    if (d.prochaineLe) h += '<p style="font-size:12px;margin:0 0 7px">⏸️ Après 2 professionnels, la recherche s’arrête. Vous pourrez reprendre <b>le ' + String(d.prochaineLe).slice(0, 10) + ' à ' + String(d.prochaineLe).slice(11, 16) + '</b>.</p>';
    if (!pro) h += '<button type="button" class="act-btn" style="width:100%" onclick="relRelancer()">🔁 Reprendre la recherche</button>';
    h += '</div>';
  }
  if (d.signale) h += '<div style="margin-top:9px;background:#fdeaea;border:1.5px solid #f0b5b5;border-radius:11px;padding:9px;font-size:12px">⛔ Cette relation a été arrêtée (manquement aux règles ou décision d’un gestionnaire). Aucune autre mise en relation ne reprendra ici.</div>';
  /* traçabilité visible */
  if (suite.length) h += '<details style="margin-top:9px"><summary style="font-size:11.5px;color:var(--muted);cursor:pointer">🗂️ Historique (consultable par les gestionnaires en cas de litige)</summary>'
    + '<div style="font-size:11px;color:var(--muted);margin-top:6px">' + suite.slice(-12).reverse().map(function (x) {
      return '<div>• ' + String(x.at || '').slice(0, 16).replace('T', ' ') + ' — ' + x.quoi + (x.detail ? ' : ' + x.detail : '') + '</div>';
    }).join('') + '</div></details>';
  return h + '</div>';
}
/* envois */
async function relAppel(chemin, corps, okTxt) {
  if (REL.occupe || !REL.missionId) return null;
  REL.occupe = true;
  try {
    const r = await fetch('/api/missions/' + REL.missionId + '/rel' + chemin, { method: 'POST', headers: relEntetes(REL.role), body: JSON.stringify(corps || {}) });
    const d = await r.json().catch(function () { return {}; });
    REL.occupe = false;
    if (d && d.rel) { REL.d = d.rel; relRendre(); }
    else { await relCharger(REL.missionId, REL.role); }
    if (!r.ok) { toast(d.error || 'Action impossible'); return null; }
    if (okTxt) toast(okTxt);
    return d;
  } catch (e) { REL.occupe = false; toast('⚠️ Réseau indisponible — réessayez'); return null; }
}
function relEnvoyer() {
  const i = document.getElementById('rel-saisie'); const t = i ? (i.value || '').trim() : '';
  if (!t) return toast('Écrivez un message court');
  return relAppel('/message', { texte: t }, null).then(function (d) { if (d && i) i.value = ''; });
}
function relPrecision() { const i = document.getElementById('rel-saisie'); if (i) { i.focus(); i.value = 'J’ai besoin d’une précision : '; } toast('✍️ Écrivez votre précision en une phrase'); }
function relRapide(t) {
  const d = REL.d || {};
  if (REL.role === 'pro') {
    if (/prix pour ce devis/i.test(t)) { const z = document.getElementById('rel-prix-montant'); if (z) { z.focus(); z.scrollIntoView({ block: 'center' }); } return toast('💰 Écrivez le montant, puis envoyez votre prix'); }
    if (/précision/i.test(t)) { const i = document.getElementById('rel-saisie'); if (i) { i.focus(); i.value = 'J’ai besoin d’une précision : '; } return; }
    return relAppel('/reponse', { sens: 'auto', texte: t }, 'Réponse envoyée au client ✓');
  }
  if (/J’accepte le prix/.test(t) || /J'accepte le prix/.test(t)) return relPrixDecision('accepter');
  if (/Je refuse le prix/.test(t)) return relPrixDecision('refuser');
  if (/une précision à ajouter/i.test(t)) return relPrecision();
  if (/Modifier ma demande/i.test(t)) return relModifierDemande();
  if (/^Annuler/.test(t)) return relAnnuler();
  return relAppel('/message', { texte: t, rapide: true }, null);
}
/* ✍️ LOT 112 — MODIFIER MA DEMANDE : le client corrige sa demande ; rien n'est supprimé,
   tout est conservé (avant/après, motif, date) et un prix déjà accepté n'est jamais touché. */
function relModifierDemande(){
  const d = REL.d || {};
  const ov0 = document.getElementById('rel-modif-ov'); if(ov0) ov0.remove();     /* jamais d’écran invisible qui bloque le tactile */
  const rep = (d.tarif && d.tarif.reponses) || [];
  const ch = (k, v, lib) => '<label style="display:block;font-size:12px;font-weight:800;margin-top:9px">' + lib
    + '</label><input id="rm-' + k + '" value="' + String(v == null ? '' : v).replace(/"/g,'&quot;') + '" style="width:100%;padding:9px;border:1.5px solid var(--line);border-radius:10px;background:#fff;font-size:14px">';
  const ov = document.createElement('div');
  ov.id = 'rel-modif-ov';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9998;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:14px';
  ov.innerHTML = '<div style="background:var(--bg);border-radius:16px;padding:14px;max-width:520px;width:100%;margin:auto 0">'
    + '<div style="display:flex;align-items:center;gap:8px"><b style="font-size:15px">✍️ Modifier ma demande</b>'
    + '<button type="button" onclick="document.getElementById(\'rel-modif-ov\')&&document.getElementById(\'rel-modif-ov\').remove()" style="margin-left:auto;border:none;background:#fff;border-radius:9px;padding:6px 10px;font-weight:900;cursor:pointer">Fermer ✕</button></div>'
    + '<p style="font-size:11.5px;color:var(--muted);margin:6px 0 0">Vous précisez ce qui a changé — l’ancienne version est <b>conservée</b> et peut être consultée. '
    + 'Le métier ne change pas ici (pour un autre métier, annulez et créez une nouvelle demande).</p>'
    + '<div id="rm-prix" style="margin-top:8px"></div>'
    + ch('desc', d.desc || '', 'Ce que vous voulez (description)')
    + ch('pieces', d.pieces || 1, 'Nombre de pièces / d’éléments')
    + ch('quartier', d.quartier || '', 'Quartier')
    + ch('adresse', d.adresse || '', 'Adresse exacte (jamais publique : transmise au seul professionnel en relation)')
    + '<div style="display:flex;gap:8px">'
      + '<div style="flex:1">' + ch('date', d.date || '', 'Date souhaitée (AAAA-MM-JJ)') + '</div>'
      + '<div style="flex:1">' + ch('time', d.time || '', 'Heure (HH:MM)') + '</div>'
    + '</div>'
    + '<b style="display:block;font-size:12.5px;margin-top:12px">🔎 Précisions déjà données</b>'
    + '<div id="rm-rep">' + (rep.length ? rep.map(function(x,i){
        return '<div style="display:flex;gap:6px;margin-top:6px"><input id="rm-q' + i + '" value="' + String(x.q||'').replace(/"/g,'&quot;') + '" style="flex:1;padding:8px;border:1.5px solid var(--line);border-radius:9px;font-size:12.5px">'
          + '<input id="rm-v' + i + '" value="' + String(x.v||'').replace(/"/g,'&quot;') + '" style="flex:1;padding:8px;border:1.5px solid var(--line);border-radius:9px;font-size:12.5px"></div>';
      }).join('') : '<div style="font-size:11.5px;color:var(--muted)">Aucune précision pour l’instant.</div>') + '</div>'
    + '<div style="display:flex;gap:6px;margin-top:7px"><input id="rm-qn" placeholder="Nouvelle précision (ex : accès au 3ᵉ étage)" style="flex:1;padding:8px;border:1.5px solid var(--line);border-radius:9px;font-size:12.5px">'
      + '<input id="rm-vn" placeholder="Votre réponse" style="flex:1;padding:8px;border:1.5px solid var(--line);border-radius:9px;font-size:12.5px"></div>'
    + ch('motif', '', 'Pourquoi ce changement ? (obligatoire, gardé dans l’historique)')
    + '<button type="button" id="rm-envoyer" style="width:100%;margin-top:12px;background:var(--pd);color:#fff;border:none;border-radius:12px;padding:13px;font-weight:900;font-size:14px;cursor:pointer">✍️ Enregistrer la modification</button>'
    + '<div id="rm-msg" style="font-size:12px;margin-top:8px"></div></div>';
  document.body.appendChild(ov);
  const pv = document.getElementById('rm-prix');
  if(pv) pv.innerHTML = (d.prixVerrouille || (d.prix && d.prix.statut === 'accepte'))
    ? '<div style="background:#fff8e6;border:1px solid #ffe0a3;border-radius:11px;padding:8px 10px;font-size:12px">🔒 Un prix a déjà été accepté (<b>' + relFmt(d.prixEnVigueur) + '</b>). Il <b>reste en vigueur</b> : votre modification ouvrira une <b>nouvelle proposition</b>, que vous accepterez ou refuserez vous-même.</div>'
    : '';
  const b = document.getElementById('rm-envoyer');
  if(b) b.onclick = function(){
    const v = id => { const e = document.getElementById(id); return e ? e.value : ''; };
    const reps = [];
    for(let i = 0; i < 20; i++){
      const q = document.getElementById('rm-q' + i); if(!q) break;
      const val = document.getElementById('rm-v' + i);
      if(q.value.trim()) reps.push({ q: q.value.trim(), v: (val ? val.value : '').trim() });
    }
    if(v('rm-qn').trim()) reps.push({ q: v('rm-qn').trim(), v: v('rm-vn').trim() });
    if(!v('rm-motif').trim()) return toast('✍️ Dites pourquoi vous modifiez (une phrase)');
    b.disabled = true; b.textContent = '⏳ Enregistrement…';
    fetch('/api/missions/' + REL.missionId + '/demande/modifier', { method:'POST', headers: relEntetes('client'),
      body: JSON.stringify({ motif: v('rm-motif'), desc: v('rm-desc'), pieces: v('rm-pieces'), quartier: v('rm-quartier'),
        adresse: v('rm-adresse'), date: v('rm-date'), time: v('rm-time'), reponses: reps }) })
      .then(r => r.json().then(j => ({ ok:r.ok, j:j })))
      .then(function(x){
        b.disabled = false; b.textContent = '✍️ Enregistrer la modification';
        const msg = document.getElementById('rm-msg');
        if(!x.ok){ if(msg) msg.innerHTML = '<b style="color:var(--danger)">' + ((x.j && x.j.error) || 'Impossible') + '</b>'; return; }
        if(msg) msg.innerHTML = '<b style="color:#0a8a62">✅ ' + x.j.message + '</b>';
        toast('✍️ Demande modifiée (v' + x.j.version + ')');
        if(x.j.rel){ REL.d = x.j.rel; relRendre(); }
        setTimeout(function(){ const o = document.getElementById('rel-modif-ov'); if(o) o.remove(); }, 1400);
      })
      .catch(function(){ b.disabled = false; b.textContent = '✍️ Enregistrer la modification'; toast('⚠️ Réseau indisponible — réessayez'); });
  };
}
function relPrixEnvoyer() {
  const m = document.getElementById('rel-prix-montant'), l = document.getElementById('rel-prix-libelle');
  const montant = m ? Number(m.value) : 0;
  if (!montant || montant < 500) return toast('Indiquez un montant en FCFA (minimum 500)');
  return relAppel('/prix', { montant: montant, libelle: l ? l.value : '' }, '💰 Prix envoyé au client ✓');
}
function relBasculerMotif() { const z = document.getElementById('rel-motif-zone'); if (z) z.style.display = 'block'; }
function relPrixDecision(dec) {
  const z = document.getElementById('rel-motif');
  const motif = z ? (z.value || '') : '';
  if (dec === 'accepter' && !confirm('Accepter ce prix ? Il devient le montant OFFICIEL de la prestation et ne pourra plus être changé sans votre accord.')) return;
  return relAppel('/prix-decision', { decision: dec, motif: motif }, dec === 'accepter' ? '🔒 Prix accepté — montant officiel' : '🚫 Prix refusé — droit à un 2ᵉ professionnel');
}
function relAnnuler() {
  if (!confirm('Annuler cette demande ? La conversation sera fermée.')) return;
  return relAppel('/annuler', {}, '⛔ Demande annulée');
}
function relRelancer() { return relAppel('/relancer', {}, '🔁 Nouvelle recherche lancée'); }
function relPayerMaintenant() { try { if (typeof payerOuvrir === 'function') payerOuvrir(); else toast('💳 Le paiement s’ouvre à l’étape suivante'); } catch (e) { toast('💳 Le paiement s’ouvre à l’étape suivante'); } }
/* le professionnel répond depuis SA carte de demande (accepter / refuser) */
async function relRepondrePro(mid, sens, texte) {
  try {
    const r = await fetch('/api/missions/' + mid + '/rel/reponse', { method: 'POST', headers: relEntetes('pro'), body: JSON.stringify({ sens: sens || 'auto', texte: texte || '' }) });
    const d = await r.json().catch(function () { return {}; });
    if (!r.ok) return d;
    return d;
  } catch (e) { return {}; }
}
window.relCharger = relCharger; window.relRendre = relRendre; window.relEnvoyer = relEnvoyer;
window.relRapide = relRapide; window.relModifierDemande = relModifierDemande; window.relPrixEnvoyer = relPrixEnvoyer; window.relPrixDecision = relPrixDecision;
window.relBasculerMotif = relBasculerMotif; window.relAnnuler = relAnnuler; window.relRelancer = relRelancer;
window.relPrecision = relPrecision; window.relPayerMaintenant = relPayerMaintenant; window.relRepondrePro = relRepondrePro;
