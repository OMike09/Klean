#!/usr/bin/env node
/** KLEAN guard — détecte les failles « rien ne clique » avant envoi.
 *  node klean-guard.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = __dirname;
const issues = [];
const add = (sev, file, kind, msg) => issues.push({ sev, file, kind, msg });

function nodeCheck(src) {
  const tmp = path.join('/tmp', 'klean-chk-' + Date.now() + '-' + Math.random() + '.js');
  fs.writeFileSync(tmp, src);
  const r = spawnSync('node', ['--check', tmp], { encoding: 'utf8' });
  try { fs.unlinkSync(tmp); } catch (e) {}
  return r.status === 0 ? null : (r.stderr || r.stdout || 'fail').slice(0, 240);
}

function scriptsOf(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, i = 0;
  while ((m = re.exec(html))) out.push({ i: ++i, src: m[1] });
  return out;
}

function definedFns(src) {
  const s = new Set();
  for (const m of src.matchAll(/(?:async\s+)?function\s+(\w+)/g)) s.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/g)) s.add(m[1]);
  for (const m of src.matchAll(/window\.(\w+)\s*=/g)) s.add(m[1]);
  return s;
}

function onclickCalls(html) {
  const calls = [];
  for (const m of html.matchAll(/onclick\s*=\s*"([^"]*)"/gi)) {
    for (const c of m[1].matchAll(/(?<![\w.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      calls.push({ name: c[1], snippet: m[1].slice(0, 90) });
    }
  }
  return calls;
}

const SKIP = new Set('alert confirm parseInt parseFloat setTimeout Number String Math JSON document window encodeURIComponent isNaN event history location fetch btoa atob Date Object Array Error click splice round replace reload stopPropagation getElementById querySelector if for while switch return typeof void new'.split(' '));

const files = ['index.html', 'admin.html', 'field.html', 'net.js', 'server.js', 'sw.js'];
let allSrc = '';
for (const f of files) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { add('HIGH', f, 'missing', 'fichier absent'); continue; }
  const t = fs.readFileSync(p, 'utf8');
  if (f.endsWith('.js')) {
    allSrc += '\n' + t;
    const err = nodeCheck(t);
    if (err) add('CRIT', f, 'syntax', err);
  } else {
    scriptsOf(t).forEach(sc => {
      allSrc += '\n' + sc.src;
      const err = nodeCheck(sc.src);
      if (err) add('CRIT', f + '#' + sc.i, 'syntax', err);
    });
  }
}

const defined = definedFns(allSrc);
for (const f of ['index.html', 'admin.html', 'field.html']) {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const local = new Set([...defined, ...definedFns(t)]);
  for (const c of onclickCalls(t)) {
    if (SKIP.has(c.name) || local.has(c.name)) continue;
    add('CRIT', f, 'onclick-dead', c.name + ' — ' + c.snippet);
  }
  if (f === 'index.html') {
    if (!/function goCreateClient\s*\(/.test(t)) add('HIGH', f, 'missing', 'goCreateClient');
    if (!/function goCreatePro\s*\(/.test(t)) add('HIGH', f, 'missing', 'goCreatePro');
    if (!/function goBookings\s*\(/.test(t)) add('HIGH', f, 'missing', 'goBookings');
    if (!/function clientRegister\s*\(/.test(t)) add('HIGH', f, 'missing', 'clientRegister');
    if (!/id=["']splash["']/.test(t)) add('MED', f, 'splash', 'pas de splash');
    else if (!/splash[\s\S]{0,400}click/.test(t) && !/addEventListener\('click',kill/.test(t)) add('MED', f, 'splash', 'splash non cliquable');
  }
}

const htmlAdm = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
if (!/async function saveComm/.test(htmlAdm)) add('CRIT', 'admin.html', 'await-no-async', 'saveComm doit être async');

const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
if (/online:\s*!!a\s*[,}]/.test(srv) && !/online:\s*!!a\.online/.test(srv) && !/onlineAgentIds/.test(srv)) {
  add('HIGH', 'server.js', 'online', 'online: !!a toujours vrai');
}

console.log('\n══ KLEAN GUARD ══');
if (!issues.length) console.log('OK — 0 faille bloquante détectée.');
else {
  issues.forEach(i => console.log(i.sev, i.kind, i.file, i.msg.replace(/\n/g, ' ')));
  console.log('TOTAL', issues.length);
}
const crit = issues.filter(i => i.sev === 'CRIT').length;
process.exit(crit ? 1 : 0);
