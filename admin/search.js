// admin/search.js - Grande barre de recherche
let searchTimer=null;
function initSearchBar(){
  const header=document.querySelector('.main') || document.getElementById('root');
  // Barre permanente en haut du dashboard
  if(document.getElementById('global-search')) return;
  const bar=document.createElement('div');
  bar.id='global-search';
  bar.style.cssText='position:sticky;top:0;z-index:20;background:#fff;border:1px solid #e2e8e6;border-radius:12px;padding:10px 14px;margin:14px 0;display:flex;gap:10px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.06)';
  bar.innerHTML=`
    <span style="font-size:18px">🔍</span>
    <input id="gs-input" placeholder="Rechercher : nom, téléphone, email, KP, métier, service, mission, transaction..." style="flex:1;border:none;outline:none;font-size:15px" autocomplete="off">
    <span class="small muted" style="white-space:nowrap">Entrée pour voir tout</span>
    <div id="gs-results" style="position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #e2e8e6;border-radius:12px;margin-top:8px;max-height:360px;overflow-y:auto;display:none;box-shadow:0 8px 24px rgba(0,0,0,.12)"></div>`;
  bar.style.position='relative';
  const root=document.getElementById('root');
  if(root) root.prepend(bar);
  const input=document.getElementById('gs-input');
  input.addEventListener('input', e=>{
    clearTimeout(searchTimer);
    const q=e.target.value.trim();
    if(q.length<2){ hideSearch(); return; }
    searchTimer=setTimeout(()=>doSearch(q), 300);
  });
  input.addEventListener('keydown', e=>{ if(e.key==='Enter'){ const q=input.value.trim(); if(q) doSearch(q,true); } if(e.key==='Escape') hideSearch(); });
  document.addEventListener('click', e=>{ if(!bar.contains(e.target)) hideSearch(); });
}
async function doSearch(q, full){
  try{
    const res=await api('/admin/search?q='+encodeURIComponent(q));
    const box=document.getElementById('gs-results');
    if(!res.length){ box.innerHTML=`<div style="padding:14px" class="muted">Aucun résultat pour "${esc(q)}"</div>`; box.style.display='block'; return; }
    box.innerHTML = res.map(r=>`
      <div onclick="openSearchResult('${r.view}','${r.id}','${esc(r.label)}')" style="padding:10px 14px;border-bottom:1px solid #f1f5f4;cursor:pointer;display:flex;justify-content:space-between;align-items:center">
        <div><b>${esc(r.label)}</b><br><span class="small muted">${esc(r.sub||r.type)} • ${esc(r.type)}</span></div>
        <span class="pill info">Ouvrir</span>
      </div>`).join('');
    box.style.display='block';
  }catch(e){ console.error(e); }
}
function hideSearch(){ const b=document.getElementById('gs-results'); if(b) b.style.display='none'; }
function openSearchResult(view,id,label){
  hideSearch();
  // Exemples: "KP004582" -> view users, "Plomberie" -> metiers
  if(view==='users'){ location.hash='#users'; setTimeout(()=>{ const el=document.querySelector(`[data-phone="${id}"]`)||document.querySelector('input[placeholder*="Rechercher"]'); if(el) el.scrollIntoView(); },300); toast('Ouverture: '+label,'ok'); }
  else if(view==='metiers'){ location.hash='#metiers'; }
  else if(view==='missions'){ location.hash='#missions'; }
  else if(view==='payments'){ location.hash='#payments'; }
  else location.hash='#'+view;
  // Force render
  if(typeof renderView==='function') renderView();
}
// Auto-init après login
setTimeout(initSearchBar, 800);
