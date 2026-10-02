// admin/metiers.js - Module Métiers > Sous-catégories > Services > Tâches
async function renderMetiers(){
  const metiers = await api('/admin/metiers');
  shell(`<h1>🏗️ Métiers → Sous-catégories → Services → Tâches</h1>
    <div class="panel">
      <div class="frow">
        <input id="m-search" placeholder="Rechercher métier/service/tâche..." oninput="filterMetiers()" style="flex:1">
        <button class="btn sm" onclick="createMetierPrompt()">+ Métier</button>
      </div>
      <div id="m-list"></div>
    </div>
    <div class="panel">
      <h2>Services populaires (accueil)</h2><div id="m-pop"></div>
      <h2>Services saisonniers</h2><div id="m-sais"></div>
      <h2>Par villes</h2><div id="m-villes"></div>
    </div>`);
  const list=document.getElementById('m-list');
  list.innerHTML = metiers.length ? `<table><tr><th>Métier</th><th>Icône</th><th>Sous-cat</th><th>Services</th><th>Tâches</th><th>Actif</th><th></th></tr>`+
    metiers.map(m=>`<tr><td><b>${esc(m.name)}</b></td><td>${esc(m.icon||'')}</td><td><button class="btn sm sec" onclick="manageSous(${m.id})">Gérer</button></td><td><button class="btn sm sec" onclick="manageServices(${m.id})">Gérer</button></td><td><button class="btn sm sec" onclick="manageTaches(${m.id})">Voir</button></td><td>${m.active?'✅':'❌'}</td><td><button class="btn sm" onclick="editMetier(${m.id})">✏️</button> <button class="btn sm warn" onclick="delMetier(${m.id})">🗑️</button></td></tr>`).join('')+'</table>' : '<div class="muted">Aucun métier. Cliquez + Métier</div>';
}
async function createMetierPrompt(){
  const name=prompt('Nom du métier'); if(!name) return;
  const icon=prompt('Icône (emoji)','🏗️')||'';
  await api('/admin/metiers',{method:'POST', body:{name,icon}});
  toast('Métier créé','ok'); renderMetiers();
}
async function delMetier(id){ if(!confirm('Supprimer ce métier ?')) return; await api('/admin/metiers/'+id,{method:'DELETE'}); renderMetiers(); }
async function manageSous(mid){
  const subs=await api('/admin/sous-categories?metier_id='+mid);
  const name=prompt('Nouvelle sous-catégorie pour métier #'+mid + '\nExistantes: '+subs.map(s=>s.name).join(', '));
  if(!name) return; await api('/admin/sous-categories',{method:'POST', body:{metier_id:mid, name}}); toast('Ajouté','ok');
}
function filterMetiers(){ const q=document.getElementById('m-search').value.toLowerCase(); document.querySelectorAll('#m-list tr').forEach(tr=>{ tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'; }); }
