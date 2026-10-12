/* Vérifications E2E COLIS 15 — partage, contenu, fréquentation, messages ciblés, villes et conversions. */
const BASE = (process.env.KLEAN_TEST_BASE || 'http://127.0.0.1:3000') + '/api';
let n = 0, fail = 0;
async function api(token, path, method = 'GET', body) {
  const r = await fetch(BASE + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({})); return { r, d };
}
function yes(ok, message) { n++; if (ok) console.log('OK ', message); else { fail++; console.error('BAD', message); } }
(async () => { try {
  const admin = (await api(null, '/auth/login', 'POST', { phone: 'admin', password: 'Klean@2026' })).d;
  yes(!!admin.token && admin.user.role === 'pdg', 'connexion PDG');
  const suffix = Date.now().toString().slice(-8);
  const client = (await api(null, '/auth/register', 'POST', { name: 'Client suivi', phone: '09' + suffix, password: 'abcd1234', address: 'Abidjan, Cocody', ville: 'Abidjan', accept_rules: true })).d;
  yes(!!client.token, 'compte client de contrôle créé');

  let r = await api(null, '/about'); const before = r.d;
  yes(r.r.status === 200 && Array.isArray(before.paragraphs) && before.paragraphs.length > 0, 'À propos public disponible');
  r = await api(admin.token, '/admin/about');
  yes(r.r.status === 200 && Array.isArray(r.d.draft), 'brouillon À propos accessible uniquement au PDG');
  const paragraphs = [{ heading: 'Contrôle publication', text: 'Texte publié par le test de synchronisation.' }];
  const aboutTitle = 'À propos — contrôle ' + suffix;
  r = await api(admin.token, '/admin/about', 'PUT', { title: aboutTitle, paragraphs });
  const draftOnly = await api(null, '/about');
  yes(r.r.status === 200 && draftOnly.d.title !== aboutTitle, 'brouillon non exposé avant publication');
  r = await api(admin.token, '/admin/about/publish', 'POST');
  const published = await api(null, '/about');
  yes(r.r.status === 200 && published.d.title === aboutTitle && published.d.paragraphs[0].text.includes('synchronisation'), 'publication À propos synchronisée côté client');

  r = await api(client.token, '/share/prepare', 'POST'); const share = r.d;
  yes(r.r.status === 200 && /^https?:/.test(share.url) && share.note.includes('ne prouve pas'), 'préparation partage avec limite de mesure honnête');
  r = await api(null, '/share/open/' + encodeURIComponent(share.url.split('ref=').pop()), 'POST');
  const shareStats = await api(admin.token, '/admin/shares/stats');
  yes(r.r.status === 200 && r.d.ok && shareStats.r.status === 200 && shareStats.d.clicks >= 1 && shareStats.d.opened >= 1, 'ouverture de lien et métriques de partage mesurées distinctement');
  const referred = (await api(null, '/auth/register', 'POST', { name: 'Filleul suivi', phone: '08' + suffix, password: 'abcd1234', ville: 'Abidjan', accept_rules: true, referral_token: share.url.split('ref=').pop() })).d;
  yes(!!referred.token, 'inscription depuis lien suivi');

  r = await api(client.token, '/activity', 'POST', { state: 'active' });
  const frequency = await api(admin.token, '/admin/frequentation?days=7');
  const frequencyCustom = await api(admin.token, '/admin/frequentation?from=2026-10-01&to=2026-10-13');
  yes(r.r.status === 200 && frequency.r.status === 200 && frequency.d.active >= 1 && Array.isArray(frequency.d.series) && Array.isArray(frequency.d.recent) && frequencyCustom.r.status === 200 && frequencyCustom.d.range.from === '2026-10-01', 'fréquentation issue d’interactions réelles, période personnalisée et détail autorisé');

  r = await api(admin.token, '/admin/general-messages', 'POST', { title: 'Contrôle ciblage', body: 'Message destiné aux comptes clients.', account_types: ['clients'], cities: [], mode: 'draft' });
  const draft = r.d;
  yes(r.r.status === 201 && draft.status === 'draft', 'message général enregistré en brouillon');
  r = await api(admin.token, '/admin/general-messages/' + draft.id + '/send', 'POST');
  const messages = await api(admin.token, '/admin/general-messages');
  const sent = messages.d.find(m => m.id === draft.id);
  yes(r.r.status === 200 && sent.status === 'sent' && sent.delivered_count <= sent.target_count && sent.delivery_state.includes('application'), 'message ciblé envoyé, historisé et sans doublon');

  r = await api(admin.token, '/admin/users/' + client.user.id + '/convert-pro', 'POST', { pro_type: 'particulier', exceptional: true, reason: 'Contrôle exceptionnel documenté' });
  const converted = await api(admin.token, '/admin/users/' + client.user.id);
  yes(r.r.status === 200 && converted.d.pro_status === 'approved' && converted.d.profile_incomplete && converted.d.pro, 'conversion exceptionnelle pro garde identité minimale et profil incomplet');
  const cities = (await api(null, '/villes')).d;
  const ownCity = await api(client.token, '/pro/service-location', 'PUT', { service_city: cities[0] });
  const blockedCity = await api(client.token, '/pro/service-location', 'PUT', { service_city: cities[1] });
  const adminCities = await api(admin.token, '/admin/pros/' + client.user.id + '/eligibility', 'PUT', { authorized_services: [], pro_type: 'particulier', capacity_level: 1, service_cities: [cities[0], cities[1]] });
  const extraCity = await api(client.token, '/pro/service-location', 'PUT', { service_city: cities[1] });
  yes(ownCity.r.status === 200 && blockedCity.r.status === 403 && adminCities.r.status === 200 && extraCity.r.status === 200, 'ville pro unique puis villes supplémentaires administrées appliquées côté serveur');

  r = await api(admin.token, '/admin/settings', 'PUT', { request_image_limit: '2', request_audio_max_seconds: '20', activity_active_minutes: '5', game_quiz_share: 'lien_ouvert' });
  const settings = await api(admin.token, '/admin/settings');
  yes(r.r.status === 200 && settings.d.request_image_limit === '2' && settings.d.game_quiz_share === 'lien_ouvert', 'réglages demande, activité et jeux enregistrés côté serveur');
  await api(admin.token, '/admin/settings', 'PUT', { flipfizz_enabled: '1', game_flipfizz_share: 'sans_partage' });
  const deniedGame = await api(client.token, '/games/flipfizz', 'POST', {});
  await api(admin.token, '/admin/settings', 'PUT', { game_flipfizz_share: 'lien_ouvert' });
  const allowedGame = await api(client.token, '/games/flipfizz', 'POST', {});
  yes(deniedGame.r.status === 403 && allowedGame.r.status === 200, 'critère jeu sans partage / lien mesuré contrôlé par le serveur');
  await api(admin.token, '/admin/settings', 'PUT', { game_quiz_share: 'tous', game_flipfizz_share: 'tous', flipfizz_enabled: '0' });

  console.log(`RESULT ${n - fail}/${n}, failed=${fail}`); process.exitCode = fail ? 1 : 0;
} catch (e) { console.error(e); process.exitCode = 1; } })();
