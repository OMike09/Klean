/* Vérifications COLIS 18 — retour historique, protection brouillon et gestes non conflictuels. */
const fs = require('fs'), vm = require('vm');
let n=0, fail=0;
function ok(v, label){ n++; if(v) console.log('OK ',label); else { fail++; console.error('BAD',label); } }
function makeNavigationHarness(source) {
  const listeners = {}, elements = new Map();
  const document = {
    addEventListener:(type,fn)=>{(listeners[type] ||= []).push(fn)},
    getElementById:id=>elements.get(id)||null,
    createElement:()=>({style:{},innerHTML:'',appendChild(){},remove(){},querySelectorAll(){return[]},addEventListener(){}}),
    body:{appendChild(){}},
  };
  let entries=['#/home'], index=0, hash='#/home';
  const fire=type=>(listeners[type]||[]).forEach(fn=>fn());
  const location={};
  Object.defineProperty(location,'hash',{get:()=>hash,set:v=>{hash=String(v); entries=entries.slice(0,index+1);entries.push(hash);index++;fire('hashchange')}});
  const history={back:()=>{if(index>0){index--;hash=entries[index];fire('hashchange')}},go:d=>{if(index+d>=0&&index+d<entries.length){index+=d;hash=entries[index];fire('hashchange')}}};
  const window={_supportPoll:null,addEventListener:(type,fn)=>{(listeners[type] ||= []).push(fn)},scrollTo(){}};
  const ctx={document,window,location,history,navigator:{userAgent:'Android',platform:'Linux',maxTouchPoints:0},TOKEN:'token',navStack:[],suppressPush:false,pendingWriteOperations:0,toast(){},render(){},setInterval(){},clearInterval(){},setTimeout(){},clearTimeout(){},console};
  vm.createContext(ctx);
  vm.runInContext(source + `\ncurrentHash='#/home'; navStack=['#/home']; navCursor=0; this.inspectNav=()=>({stack:[...navStack],cursor:navCursor,current:currentHash,hash:location.hash});`,ctx);
  return ctx;
}
try {
  const app=fs.readFileSync('public/app.js','utf8');
  const start=app.indexOf('/* ---------- Navigation centralisée');
  const end=app.indexOf('function logout(',start);
  ok(start>=0 && end>start,'gestion de navigation centralisée présente');
  const h=makeNavigationHarness(app.slice(start,end));
  h.nav('#/services'); h.nav('#/services/12');
  let s=h.inspectNav();
  ok(s.current==='#/services/12' && s.cursor===2 && s.stack.length===3,'navigation mémorise les écrans réellement visités');
  h.back(); s=h.inspectNav();
  ok(s.current==='#/services' && s.cursor===1,'flèche Retour revient à la catégorie précédente');
  h.history.back(); s=h.inspectNav();
  ok(s.current==='#/home' && s.cursor===0,'retour navigateur/Android respecte le même historique');
  h.back(); s=h.inspectNav();
  ok(s.current==='#/home' && s.cursor===0,'premier écran ne crée ni erreur ni boucle');
  ok(app.includes('Vous avez des modifications non enregistrées. Voulez-vous quitter cette page ?') && app.includes('Continuer la modification') && app.includes('Quitter sans enregistrer'),'confirmation explicite des brouillons non enregistrés');
  ok(app.includes("started>44") && app.includes("Math.abs(dy)>Math.min(56, dx*.45)") && app.includes("gestureBlocked"),'balayage horizontal limité au bord et compatible avec défilement vertical');
  ok(app.includes("opts.back === 'contextual'") && app.includes("aria-label=\"Retour à l’écran précédent\""),'bouton Retour contextualisé sur écrans racines et disponible sur sous-pages');
  const admin=fs.readFileSync('public/admin/admin.js','utf8'), adminHtml=fs.readFileSync('public/admin/index.html','utf8');
  ok(admin.includes('function adminBack()') && admin.includes('ADMIN_STACK') && admin.includes('adminLeaveConfirm'),'historique et protection des brouillons appliqués au tableau de bord');
  ok(admin.includes('adminGestureBlocked') && adminHtml.includes('admin-back'),'bouton Retour et balayage compatible ajoutés au dashboard');
  console.log(`RESULT ${n-fail}/${n}, failed=${fail}`);
  process.exitCode=fail?1:0;
} catch(e) { console.error(e); process.exitCode=1; }
