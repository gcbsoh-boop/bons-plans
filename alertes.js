// Alertes personnalisées : compare les NOUVELLES offres de cette exécution aux souhaits
// de chaque personne et envoie une notification ntfy. Aucune dépendance : Node 18+.
// Variables secrètes : SUPABASE_URL, SUPABASE_SERVICE_KEY (jamais affichées).
// Si l'une manque, le script se termine sans bruit.
const fs = require('fs');
const path = require('path');

const MAX_PAR_PERSONNE = 5;
const URL_SB = String(process.env.SUPABASE_URL || '').trim().replace(/[/]+$/, '');
const CLE = String(process.env.SUPABASE_SERVICE_KEY || '').trim();

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Tous les mots du souhait doivent apparaître (début de mot), sans tenir compte des accents
const motsDe = (q) => norm(q).split(/[^a-z0-9]+/).filter(Boolean).map((w) => new RegExp('(^|[^a-z0-9])' + esc(w)));
const correspond = (res, titre) => { const t = norm(titre); return res.length > 0 && res.every((r) => r.test(t)); };

async function sb(chemin, opt = {}) {
  const r = await fetch(URL_SB + '/rest/v1/' + chemin, {
    ...opt,
    headers: { apikey: CLE, Authorization: 'Bearer ' + CLE, 'Content-Type': 'application/json', ...(opt.headers || {}) },
  });
  if (!r.ok) throw new Error('Supabase HTTP ' + r.status + ' sur ' + chemin.split('?')[0]);
  return r.status === 204 ? null : r.text().then((t) => (t ? JSON.parse(t) : null));
}
async function toutLire(chemin) {
  const out = [];
  for (let debut = 0; ; debut += 1000) {
    const page = await sb(chemin, { headers: { Range: debut + '-' + (debut + 999), 'Range-Unit': 'items' } });
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

function texteOffre(d) {
  const titre = String(d.titre || '').replace(/^(\s*\[[^\]]*\])+\s*/, '').slice(0, 140);
  const prix = typeof d.prix === 'number' ? d.prix.toFixed(2).replace('.', ',') + ' $' : '';
  return titre + (prix ? ' - ' + prix : '') + (d.magasin ? ' (' + d.magasin + ')' : '');
}

async function envoyer(sujet, souhait, d) {
  // Publication en JSON : accents et caractères spéciaux passent sans problème
  const corps = { topic: sujet, title: 'Bon plan : ' + souhait.slice(0, 100), message: texteOffre(d), tags: ['shopping_cart'] };
  if (/^https?:\/\//i.test(d.lien || '')) corps.click = d.lien;
  const r = await fetch('https://ntfy.sh/', { method: 'POST', body: JSON.stringify(corps), headers: { 'Content-Type': 'application/json' } });
  return r.ok;
}

async function main() {
  if (!URL_SB || !CLE) return; // pas configuré : on sort sans bruit
  let nouveaux = [];
  try { nouveaux = JSON.parse(fs.readFileSync(path.join(__dirname, 'nouveaux.json'), 'utf8')); } catch { return; }
  if (!Array.isArray(nouveaux) || !nouveaux.length) return;

  const profils = await toutLire('profils?select=user_id,ntfy_sujet&alertes_actives=eq.true');
  if (!profils.length) return;
  const souhaits = await toutLire('souhaits?select=user_id,texte');
  const depuis = new Date(Date.now() - 180 * 864e5).toISOString();
  const deja = await toutLire('alertes_envoyees?select=user_id,lien&envoye_le=gte.' + encodeURIComponent(depuis));
  const dejaSet = new Set(deja.map((x) => x.user_id + '|' + x.lien));
  const parUser = new Map();
  for (const s of souhaits) { if (!parUser.has(s.user_id)) parUser.set(s.user_id, []); parUser.get(s.user_id).push(s.texte); }

  let envoyes = 0, personnes = 0;
  for (const p of profils) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(p.ntfy_sujet || '')) continue;
    const liste = (parUser.get(p.user_id) || []).map((t) => ({ t, res: motsDe(t) }));
    if (!liste.length) continue;
    let n = 0;
    const faits = [];
    for (const d of nouveaux) {
      if (n >= MAX_PAR_PERSONNE) break;
      if (!d || !d.lien || dejaSet.has(p.user_id + '|' + d.lien)) continue;
      const w = liste.find((x) => correspond(x.res, d.titre));
      if (!w) continue;
      try {
        if (await envoyer(p.ntfy_sujet, w.t, d)) {
          n++; dejaSet.add(p.user_id + '|' + d.lien);
          faits.push({ user_id: p.user_id, lien: d.lien });
        }
      } catch { /* on réessaiera à la prochaine exécution */ }
      await sleep(400);
    }
    if (faits.length) {
      await sb('alertes_envoyees?on_conflict=user_id,lien', { method: 'POST', body: JSON.stringify(faits), headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } });
      await sb('profils?user_id=eq.' + encodeURIComponent(p.user_id), { method: 'PATCH', body: JSON.stringify({ dernier_envoi: new Date().toISOString() }), headers: { Prefer: 'return=minimal' } });
      envoyes += faits.length; personnes++;
    }
  }
  // Ménage : on oublie les envois de plus de 180 jours
  await sb('alertes_envoyees?envoye_le=lt.' + encodeURIComponent(depuis), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  console.error('Alertes : ' + envoyes + ' notification(s) pour ' + personnes + ' personne(s)');
}

// Une panne d'alertes ne doit jamais bloquer la mise à jour du site
main().catch((e) => { console.error('Alertes : erreur (' + String(e.message).slice(0, 120) + ')'); }).finally(() => process.exit(0));
