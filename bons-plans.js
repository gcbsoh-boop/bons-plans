// Chercheur de bons plans (Canada). Aucune dépendance : Node 18+ seulement.
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const UA = 'bons-plans-perso/1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lireJson = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8').replace(/^﻿/, ''));

// ---------- 0. Comptes (Supabase, facultatif) ----------
// Valeurs PUBLIQUES seulement (URL + clé anon). Sans elles, le site fonctionne comme avant.
function configSupabase() {
  let url = process.env.SUPABASE_URL || '', key = process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) {
    try { const j = lireJson('supabase.json'); url = url || j.SUPABASE_URL || ''; key = key || j.SUPABASE_ANON_KEY || ''; } catch { /* pas de fichier */ }
  }
  url = String(url).trim().replace(/[/]+$/, ''); key = String(key).trim();
  if (!/^https:[/][/][A-Za-z0-9.-]+$/.test(url) || key.length < 20 || !/^[A-Za-z0-9._-]+$/.test(key)) return null;
  // Garde-fou : jamais une clé secrète dans une page publique
  let role = '';
  try { role = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString('utf8')).role || ''; } catch { /* clé non JWT */ }
  if (role === 'service_role' || key.startsWith('sb_secret_')) {
    console.error('ATTENTION : une clé secrète a été fournie à la place de la clé publique. Comptes désactivés.');
    return null;
  }
  return { url, key };
}
const SB = configSupabase();

// ---------- 1. Téléchargement ----------
async function telecharger(url) {
  for (let essai = 1; essai <= 3; essai++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
        signal: ctrl.signal,
      });
      if (r.status === 429 && essai < 3) { await sleep(6000 * essai); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } finally { clearTimeout(t); }
  }
  throw new Error('trop de tentatives');
}

// ---------- 2. Analyse XML simple ----------
const decoder = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&');
const balise = (bloc, nom) => {
  const m = bloc.match(new RegExp('<' + nom + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + nom + '>', 'i'));
  return m ? decoder(m[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
};
function analyser(xml, source) {
  const blocs = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return blocs.map((b) => {
    const titre = balise(b, 'title');
    const a = b.match(/<link[^>]*\shref=["']([^"']+)["']/i);
    const lien = a ? decoder(a[1]) : balise(b, 'link');
    const dateTxt = balise(b, 'pubDate') || balise(b, 'published') || balise(b, 'updated') || balise(b, 'dc:date');
    const d = new Date(dateTxt);
    return { titre, lien, date: isNaN(d) ? null : d.getTime(), source };
  }).filter((x) => x.titre && /^https?:\/\//i.test(x.lien));
}

// ---------- 3. Classement ----------
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const echapper = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function motRegex(mot) {
  const m = echapper(norm(mot.trim()));
  return new RegExp('(^|[^a-z0-9])' + m + '(?![a-z0-9])');
}
function preparerRegles(cfg) {
  const regles = {};
  for (const [cat, mots] of Object.entries(cfg.categories)) regles[cat] = mots.map(motRegex);
  const ordre = cfg.ordre_priorite || Object.keys(cfg.categories);
  const magasins = (cfg.magasins || []).map((n) => ({ nom: n, re: motRegex(n) }));
  return { regles, ordre, magasins };
}
function classer(titre, R) {
  const t = norm(titre);
  let meilleur = 'Autre', max = 0;
  for (const cat of R.ordre) {
    const n = (R.regles[cat] || []).filter((re) => re.test(t)).length;
    if (n > max) { max = n; meilleur = cat; }
  }
  return meilleur;
}
function magasinDe(titre, R) {
  const t = norm(titre);
  // Format RFD : "[Magasin] Produit ..." en tête
  const crochet = titre.match(/^\s*\[([^\]]{2,30})\]/);
  if (crochet) {
    const c = norm(crochet[1]);
    const connu = R.magasins.find((m) => c.includes(norm(m.nom)));
    return connu ? connu.nom : crochet[1].trim();
  }
  const trouve = R.magasins.find((m) => m.re.test(t));
  return trouve ? trouve.nom : '';
}
function extraire(titre) {
  let prix = null, pct = null;
  const re = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s?\$/g;
  const cands = [];
  let m;
  while ((m = re.exec(titre))) {
    const v = parseFloat((m[1] || m[2]).replace(/,(\d{3})/g, '$1').replace(',', '.'));
    if (isNaN(v) || v <= 0) continue;
    const avant = titre.slice(0, m.index), apres = titre.slice(m.index + m[0].length);
    // seuils, plafonds, rabais : ce ne sont pas le prix du produit
    if (/^\s*\+/.test(apres)) continue;
    if (/^\s*(?:off\b|de rabais|rabais|back\b|cash\s?back|gift\s?card|carte[- ]cadeau|en cr[ée]dit|credit\b|savings?\b|d['’]?\s?[ée]conomie)/i.test(apres)) continue;
    if (/(?:\bover|\bon|orders? of|\bspend|\bmin(?:imum)?\.?|\bplus de|à l['’]achat de|purchases? of|\bup to|jusqu['’]\s?[àa]|\bmax\.?|\bsave|\bget|\bbuy|\bwas|\breg(?:ular)?\.?|\bmsrp|\bavant|au lieu de|\bcoupon|\bcode)\s*$/i.test(avant)) continue;
    cands.push({ v, avantReg: /^\s*\(?\s*(?:reg\b|regular|was\b|msrp|au lieu de|avant)/i.test(apres) });
  }
  const choix = cands.find((c) => c.avantReg) || cands[0];
  if (choix) prix = choix.v;
  const c = titre.match(/(\d{1,2}|100)\s?%(?!\s*(?:wool|laine|cotton|coton|polyester|nylon|juice|jus|pure|natural|organic|recycled|merino|cashmere|silk|soie|linen|lin|leather|cuir|arabica))/i);
  if (c) pct = +c[1];
  if (pct === null && prix) {
    const av = titre.match(/(?:was|reg(?:ular)?\.?|msrp|avant|orig(?:inal)?\.?|au lieu de)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i);
    if (av && +av[1] > prix) pct = Math.round((1 - prix / +av[1]) * 100);
  }
  return { prix, pct };
}

// ---------- 4. Score et doublons ----------
function score(x, maintenant) {
  const heures = x.date ? Math.max(0, (maintenant - x.date) / 36e5) : 24;
  const fraicheur = Math.max(0, 50 - 2 * heures);
  return Math.round((Math.min(x.pct || 0, 90) * 0.8 + fraicheur + (x.prix !== null ? 2 : 0)) * 10) / 10;
}
function sansDoublons(liste) {
  const vus = new Set();
  return liste.filter((x) => {
    const cle = norm(x.titre).replace(/[^a-z0-9]+/g, ' ').trim();
    const lien = x.lien.replace(/[#?].*$/, '') + (/viewtopic/.test(x.lien) ? x.lien.match(/t=\d+/)?.[0] || '' : '');
    if (vus.has(cle) || vus.has(lien)) return false;
    vus.add(cle); vus.add(lien);
    return true;
  });
}

// ---------- 5. Page HTML ----------
const HTML_DEBUT = String.raw`<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bons plans</title>
<style>
:root{--bg:#f5f6f8;--carte:#fff;--txt:#1b1f27;--sec:#5b6472;--ligne:#dfe3ea;--acc:#d62839;--vert:#1a8f4c}
@media(prefers-color-scheme:dark){:root{--bg:#14171c;--carte:#1e232b;--txt:#e8ebf0;--sec:#a9b3c1;--ligne:#2e3540;--acc:#ff5468;--vert:#2fa862}}
*{box-sizing:border-box}body{margin:0;font:18px/1.4 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--txt)}
.cont{max-width:1100px;margin:0 auto;padding:0 16px 40px}
header{padding:24px 0 8px;text-align:center}
h1{font-size:2rem;margin:0 0 4px}.maj{color:var(--sec);margin:0 0 16px;font-size:1rem}
#q{width:100%;font:inherit;font-size:1.25rem;padding:16px 18px;border:2px solid var(--ligne);border-radius:14px;background:var(--carte);color:var(--txt)}
#q:focus{outline:none;border-color:var(--acc)}
h2{font-size:1.4rem;margin:26px 0 12px}
#cats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:18px}
#cats button{font:inherit;font-size:1.05rem;font-weight:600;padding:14px 8px;border:2px solid var(--ligne);border-radius:14px;background:var(--carte);color:var(--txt);cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:4px}
#cats button b{font-size:1.9rem;font-weight:400;line-height:1}
#cats button.on{background:var(--acc);border-color:var(--acc);color:#fff}
#filtre{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px}
#filtre button{font:inherit;padding:8px 14px;border-radius:99px;border:0;background:var(--acc);color:#fff;cursor:pointer}
.grille{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.carte{background:var(--carte);border:1px solid var(--ligne);border-radius:16px;padding:18px;display:flex;flex-direction:column;gap:10px;cursor:pointer}
.carte:hover{border-color:var(--acc);box-shadow:0 2px 10px rgba(0,0,0,.12)}
.carte .t{color:var(--txt);font-weight:600;font-size:1.1rem;text-decoration:none}
.label{font-weight:700;color:var(--acc)}
.prixl{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.prix{font-size:2rem;font-weight:800}.pct{background:var(--vert);color:#fff;font-weight:700;padding:3px 12px;border-radius:99px;font-size:1.1rem}
.bas{display:flex;flex-wrap:wrap;gap:8px;align-items:center;color:var(--sec);font-size:.95rem;margin-top:auto}
.chip{font:inherit;font-size:.95rem;padding:4px 12px;border-radius:99px;border:1px solid var(--ligne);background:var(--bg);color:var(--txt);cursor:pointer}
.chip:hover{border-color:var(--acc)}
.vide{padding:30px 0;color:var(--sec);font-size:1.1rem}
@media(max-width:480px){h1{font-size:1.6rem}.grille{grid-template-columns:1fr}}
</style></head><body><div class="cont">
<header><h1>Bons plans</h1><p class="maj" id="maj"></p>
<input id="q" type="search" placeholder="🔍 Que cherchez-vous ? (ex. : écran, vol, pizza)" aria-label="Rechercher"></header>
<div id="cats"></div><div id="filtre"></div>
<div id="liste"></div><div class="vide" id="vide" hidden>Aucun bon plan ne correspond.</div>
</div>
<script type="application/json" id="donnees">`;
const HTML_FIN = String.raw`</script>
<script>
const D=JSON.parse(document.getElementById('donnees').textContent);
const $=s=>document.querySelector(s);let cat='',mag='';
const ICONES={'Informatique':'\u{1F4BB}','Électronique':'\u{1F4FA}','Épicerie':'\u{1F6D2}','Maison':'\u{1F3E0}','Vêtements':'\u{1F455}','Sport':'\u26FA','Jeux vidéo':'\u{1F3AE}','Voyage':'\u2708\uFE0F','Auto':'\u{1F697}','Autre':'\u{1F4E6}'};
function age(t){if(!t)return'';const m=Math.round((Date.now()-t)/6e4);if(m<60)return'il y a '+Math.max(m,1)+' min';const h=Math.round(m/60);return h<48?'il y a '+h+' h':'il y a '+Math.round(h/24)+' j'}
function court(t){t=t.replace(/^(\s*\[[^\]]*\])+\s*/,'').replace(/^\s*[-:–]\s*/,'').trim()||t;if(t.length>90){t=t.slice(0,90);t=t.slice(0,t.lastIndexOf(' ')>50?t.lastIndexOf(' '):90)+'\u2026'}return t}
function label(d){return d.score>=70||(d.pct||0)>=50?'\u{1F525} Super affaire':(d.pct||0)>=25?'\u{1F44D} Bonne affaire':''}
function el(tag,cl,txt){const e=document.createElement(tag);if(cl)e.className=cl;if(txt!==undefined)e.textContent=txt;return e}
function carte(d){const c=el('div','carte');c.tabIndex=0;c.setAttribute('role','link');
const ouvrir=()=>window.open(d.lien,'_blank','noopener');c.onclick=ouvrir;c.onkeydown=e=>{if(e.key==='Enter')ouvrir()};
const l=label(d);if(l)c.append(el('div','label',l));
const a=el('a','t',court(d.titre));a.href=d.lien;a.target='_blank';a.rel='noopener noreferrer';a.onclick=e=>e.stopPropagation();c.append(a);
const p=el('div','prixl');if(d.prix!==null)p.append(el('span','prix',d.prix.toFixed(2).replace('.',',')+' $'));if(d.pct!==null&&d.pct>0)p.append(el('span','pct','-'+d.pct+' %'));if(p.children.length)c.append(p);
const b=el('div','bas');if(d.magasin){const s=el('button','chip',d.magasin);s.title='Voir seulement ce magasin';s.onclick=e=>{e.stopPropagation();mag=d.magasin;rendre();window.scrollTo({top:0,behavior:'smooth'})};b.append(s)}
const ag=age(d.date);if(ag)b.append(el('span','',ag));c.append(b);return c}
function boutons(){const z=$('#cats');z.innerHTML='';
D.ordre.filter(c=>D.deals.some(d=>d.categorie===c)).forEach(c=>{const b=el('button',c===cat?'on':'');const i=el('b','',ICONES[c]||'\u{1F4E6}');b.append(i,document.createTextNode(c));b.onclick=()=>{cat=cat===c?'':c;rendre()};z.append(b)})}
function section(titre,liste){const z=$('#liste');z.append(el('h2','',titre));const g=el('div','grille');liste.forEach(d=>g.append(carte(d)));z.append(g)}
function rendre(){const q=$('#q').value.toLowerCase().trim();boutons();
const f=$('#filtre');f.innerHTML='';if(mag){const x=el('button','','\u2715 '+mag);x.onclick=()=>{mag='';rendre()};f.append(x)}
const l=D.deals.filter(d=>(!cat||d.categorie===cat)&&(!mag||d.magasin===mag)&&(!q||(d.titre+' '+d.magasin+' '+d.categorie).toLowerCase().includes(q)));
l.sort((a,b)=>b.score-a.score);const z=$('#liste');z.innerHTML='';$('#vide').hidden=l.length>0;
if(!l.length)return;
if(!q&&!cat&&!mag){section('Les 10 meilleures affaires du moment',l.slice(0,10));if(l.length>10)section('Toutes les autres offres',l.slice(10))}
else section((cat?(ICONES[cat]||'')+' '+cat+' : ':'')+l.length+' offre'+(l.length>1?'s':''),l)}
$('#q').addEventListener('input',rendre);
const m=Math.round((Date.now()-D.genere)/6e4);$('#maj').textContent='Mis à jour '+(m<1?'à l\u2019instant':m<60?'il y a '+m+' min':m<48*60?'il y a '+Math.round(m/60)+' h':'il y a '+Math.round(m/1440)+' j');
rendre();
</script></body></html>`;

// ---------- 5b. Site public (dossier site/) ----------
const DIVULGATION = 'Certains liens peuvent être des liens affiliés : nous pouvons recevoir une commission, sans coût supplémentaire pour vous.';
const CSS_SITE = `
nav.menu{display:flex;flex-wrap:wrap;gap:6px 20px;justify-content:center;padding:14px 0;border-bottom:1px solid var(--ligne)}
nav.menu a{color:var(--txt);text-decoration:none;font-weight:600;padding:6px 2px;border-bottom:2px solid transparent}
nav.menu a:hover,nav.menu a[aria-current]{border-bottom-color:var(--acc)}
.hero{font-size:1.15rem;color:var(--sec);margin:0 auto 12px;max-width:640px}
footer.pied{margin-top:40px;padding-top:18px;border-top:1px solid var(--ligne);color:var(--sec);font-size:.95rem;text-align:center}
footer.pied a{color:var(--sec)}
.texte{max-width:760px;margin:0 auto;padding:8px 0}.texte h1{margin-top:28px}.texte a{color:var(--acc)}
.avis{background:var(--carte);border:1px dashed var(--acc);border-radius:12px;padding:12px 16px}
.large{max-width:900px}
#ajout{display:flex;gap:8px;margin:12px 0 20px}#ajout input{flex:1;min-width:0;font:inherit;font-size:1.2rem;padding:14px 16px;border:2px solid var(--ligne);border-radius:14px;background:var(--carte);color:var(--txt)}
#ajout button{font:inherit;font-weight:700;padding:0 20px;border:0;border-radius:14px;background:var(--acc);color:#fff;cursor:pointer}
.souhait{background:var(--carte);border:1px solid var(--ligne);border-radius:16px;padding:16px;margin-bottom:14px}
.souhait .tete{display:flex;justify-content:space-between;gap:10px;align-items:center}.souhait h3{margin:0;font-size:1.3rem}
.souhait .x{font:inherit;border:0;background:none;color:var(--sec);cursor:pointer;font-size:1.2rem}
.conseil{display:inline-block;font-weight:700;padding:6px 14px;border-radius:99px;margin:10px 0;color:#fff}
.conseil.vert{background:var(--vert)}.conseil.orange{background:#d9780f}.conseil.gris{background:#6b7380}
.souhait ul{list-style:none;margin:8px 0 0;padding:0}.souhait li{padding:6px 0;border-top:1px solid var(--ligne)}
.souhait li a{color:var(--txt);text-decoration:none}.souhait li b{color:var(--acc)}
.boite{background:var(--carte);border:1px solid var(--ligne);border-radius:16px;padding:14px 16px;margin:12px 0 20px}.boite h2,.boite h3{margin:4px 0 8px}
.ligne{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.ligne input{flex:1;min-width:200px;font:inherit;padding:12px;border:2px solid var(--ligne);border-radius:12px;background:var(--bg,var(--carte));color:var(--txt)}
.boite button{font:inherit;font-weight:700;padding:10px 16px;border:0;border-radius:12px;background:var(--acc);color:#fff;cursor:pointer;margin:4px 6px 4px 0}.boite button.sec{background:none;color:var(--acc);border:1px solid var(--acc)}
.etapes{padding-left:22px}.etapes li{margin:8px 0}code.sujet{background:var(--ligne);padding:2px 8px;border-radius:8px;word-break:break-all}.bascule{display:block;margin:10px 0;font-weight:600}
.petit{color:var(--sec);font-size:.95rem;margin:4px 0}.spark{display:block;margin:6px 0}
`;
const menuSite = (actif, local) => '<nav class="menu" aria-label="Navigation principale">' +
  (local ? [['bons-plans.html', 'Aubaines', 'a'], ['souhaits.html', 'Ma liste', 's']]
    : [['index.html', 'Aubaines', 'a'], ['souhaits.html', 'Ma liste', 's'], ['a-propos.html', 'À propos', 'p'], ['confidentialite.html', 'Confidentialité', 'c']])
    .map(([h, t, k]) => '<a href="' + h + '"' + (k === actif ? ' aria-current="page"' : '') + '>' + t + '</a>').join('') +
  (SB ? '<a href="souhaits.html#compte" id="lien-compte">Se connecter</a>' : '') + '</nav>';
const piedSite = '<footer class="pied"><p>' + DIVULGATION + '</p><p>Bons Plans Canada · <a href="a-propos.html">À propos</a> · <a href="confidentialite.html">Confidentialité</a></p></footer>';
const DESC_SITE = 'Les meilleures aubaines au Canada, triées pour vous, mises à jour chaque heure.';
function pageSite(titre, actif, corps, local) {
  return '<!DOCTYPE html>\n<html lang="fr-CA"><head><meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>' + titre + ' – Bons Plans Canada</title>\n<meta name="description" content="' + DESC_SITE + '">\n<meta name="color-scheme" content="light dark">\n' +
    '<style>' + HTML_DEBUT.match(/<style>([\s\S]*?)<\/style>/)[1] + CSS_SITE + '</style></head><body><div class="cont">\n' +
    '<header><p style="font-size:1.6rem;font-weight:800;margin:0">Bons Plans Canada</p></header>' + menuSite(actif, local) +
    '<main class="texte' + (actif === 's' ? ' large' : '') + '">' + corps + '</main>' + (local ? '' : piedSite) + '</div></body></html>\n';
}

// ---------- 5c. Historique des prix et page « Ma liste » ----------
const JOURS_HISTO = 365;
const jourDe = (t) => new Date(t).toISOString().slice(0, 10);
let NOUVEAUX = [];
function majHistorique(deals, maintenant) {
  const f = path.join(DIR, 'historique.json');
  let h = [];
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(j)) h = j; } catch { /* premier passage */ }
  const limite = jourDe(maintenant - JOURS_HISTO * 864e5);
  h = h.filter((x) => x && x.d >= limite && x.t);
  const cle = (x) => x.d + '|' + norm(x.t) + '|' + (x.m || '');
  const vus = new Set(h.map(cle));
  const auj = jourDe(maintenant);
  let ajouts = 0;
  for (const d of deals) {
    const x = { d: auj, t: d.titre, c: d.categorie, m: d.magasin, p: d.prix, o: d.pct, l: d.lien };
    if (vus.has(cle(x))) continue;
    vus.add(cle(x)); h.push(x); ajouts++;
    NOUVEAUX.push({ titre: d.titre, lien: d.lien, prix: d.prix, magasin: d.magasin });
  }
  fs.writeFileSync(f, JSON.stringify(h));
  console.error('Historique : ' + h.length + ' offres (+' + ajouts + ')');
  // Version compacte pour la page : [jour, titre, catégorie, magasin, prix, % de rabais], seulement les offres avec prix
  return h.filter((x) => x.p !== null && x.p !== undefined).map((x) => [x.d, x.t.slice(0, 110), x.c, x.m, x.p, x.o]);
}
const CORPS_SOUHAITS = String.raw`<h1>Ma liste de souhaits</h1>
<p class="petit" id="intro">Écrivez un produit avec vos mots (ex. : télé 55, rtx 4070). On le surveille pour vous. Votre liste reste dans ce navigateur : aucun compte.</p>
<section id="compte"></section><script type="application/json" id="config-sb">__SB__</script>
<form id="ajout"><input id="mot" type="text" placeholder="Que voulez-vous acheter ?" aria-label="Produit" autocomplete="off"><button type="submit">Ajouter</button></form>
<div id="souhaits"></div>
<p class="petit">Les conseils sont des tendances générales, pas une garantie.</p>
<script type="application/json" id="donnees-s">__DONNEES__</script>
<script>
const D=JSON.parse(document.getElementById('donnees-s').textContent);
const MOIS=['','janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const norm=s=>s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
const esc=s=>s.replace(/[.*+?^$\{}()|[\]\\]/g,'\\$&');
const mre=m=>new RegExp('(^|[^a-z0-9])'+esc(norm(m.trim()))+'(?![a-z0-9])');
function classer(t){t=norm(t);let best='',max=0;for(const c of D.cfg.ordre_priorite||Object.keys(D.cfg.categories)){const n=(D.cfg.categories[c]||[]).filter(m=>mre(m).test(t)).length;if(n>max){max=n;best=c}}return best}
function mots(q){return norm(q).split(/[^a-z0-9]+/).filter(Boolean).map(w=>new RegExp('(^|[^a-z0-9])'+esc(w)))}
const tout=(res,t)=>{t=norm(t);return res.every(r=>r.test(t))};
function ecrire(l){window.__l=l;try{localStorage.setItem('souhaits',JSON.stringify(l))}catch(e){}}
function el(tag,cl,txt){const e=document.createElement(tag);if(cl)e.className=cl;if(txt!==undefined)e.textContent=txt;return e}
const eur=v=>v.toFixed(2).replace('.',',')+' $';
function jolie(d){const p=d.split('-');return +p[2]+' '+MOIS[+p[1]]+' '+p[0]}
function spark(pts){const W=160,H=36,v=pts.map(p=>p[1]),lo=Math.min(...v),hi=Math.max(...v),r=hi-lo||1;
const xy=pts.map((p,i)=>(4+i*(W-8)/(pts.length-1)).toFixed(1)+','+(H-4-(p[1]-lo)/r*(H-8)).toFixed(1)).join(' ');
const s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('viewBox','0 0 '+W+' '+H);s.setAttribute('width',W);s.setAttribute('height',H);s.setAttribute('class','spark');s.setAttribute('role','img');s.setAttribute('aria-label','Historique des prix');
const pl=document.createElementNS('http://www.w3.org/2000/svg','polyline');pl.setAttribute('points',xy);pl.setAttribute('fill','none');pl.setAttribute('stroke','currentColor');pl.setAttribute('stroke-width','2');s.append(pl);return s}
function conseil(cat,courant,minHisto,aOffre){
const cal=D.cal.categories[cat],mc=new Date().getMonth()+1;
if(!aOffre)return['gris','\u{1F50E} Pas encore d’offre — on surveille'];
const bons=cal&&cal.mois||[];
if((courant!==null&&minHisto!==null&&courant<=minHisto)||bons.includes(mc))return['vert','✅ Achète maintenant'];
if(!bons.length)return['vert','✅ Achète maintenant'];
const suiv=bons.slice().sort((a,b)=>((a-mc+12)%12)-((b-mc+12)%12))[0];
return['orange','⏳ Attends — ça baisse souvent en '+MOIS[suiv]]}
function carte(q,i){
const res=mots(q),cat=classer(q);
const actuels=D.deals.filter(d=>tout(res,d.titre)).sort((a,b)=>(a.prix===null)-(b.prix===null)||a.prix-b.prix);
const hist=D.hist.filter(h=>tout(res,h[1]));
const prixAct=actuels.filter(d=>d.prix!==null).map(d=>d.prix),courant=prixAct.length?Math.min(...prixAct):null;
let mini=null,quand='';const parJour={};
hist.forEach(h=>{if(mini===null||h[4]<mini){mini=h[4];quand=h[0]}parJour[h[0]]=Math.min(parJour[h[0]]??Infinity,h[4])});
const pts=Object.keys(parJour).sort().map(d=>[d,parJour[d]]);
const c=el('div','souhait'),t=el('div','tete');t.append(el('h3','',q));
const x=el('button','x','✕');x.title='Retirer';x.setAttribute('aria-label','Retirer '+q);x.onclick=()=>retirer(i);t.append(x);c.append(t);
const [k,txt]=conseil(cat,courant,pts.length>=14?mini:null,actuels.length>0);c.append(el('div','conseil '+k,txt));
if(mini!==null)c.append(el('p','petit','Prix le plus bas vu : '+eur(mini)+' ('+jolie(quand)+')'));
if(pts.length>=2)c.append(spark(pts));
if(actuels.length){const u=el('ul');actuels.slice(0,5).forEach(d=>{const li=el('li');const a=el('a','',d.titre.replace(/^(\s*\[[^\]]*\])+\s*/,'').slice(0,90));a.href=d.lien;a.target='_blank';a.rel='noopener noreferrer';li.append(a);if(d.prix!==null)li.append(document.createTextNode(' — '),el('b','',eur(d.prix)));if(d.magasin)li.append(document.createTextNode(' · '+d.magasin));u.append(li)});c.append(u)}
return c}
function rendre(){const z=document.getElementById('souhaits');z.innerHTML='';const l=lire();
if(!l.length){z.append(el('p','petit','Votre liste est vide. Ajoutez un produit ci-dessus.'));return}
l.forEach((q,i)=>z.append(carte(q,i)))}
document.getElementById('ajout').onsubmit=e=>{e.preventDefault();const i=document.getElementById('mot'),v=i.value.trim();if(!v)return;i.value='';ajouter(v)};
const CFG=JSON.parse(document.getElementById('config-sb').textContent||'{}');
let SBC=null,SBU=null,SBL=[],PROFIL=null;
function lireLocal(){try{const l=JSON.parse(localStorage.getItem('souhaits')||'[]');return Array.isArray(l)?l:[]}catch(e){return window.__l||[]}}
function lire(){return SBU?SBL.map(s=>s.texte):lireLocal()}
function erreur(m){const z=document.getElementById('msg-compte');if(z)z.textContent=m||'Oups, un problème est survenu. Réessayez dans un instant.'}
async function charger(){const r=await SBC.from('souhaits').select('id,texte').order('cree_le',{ascending:true});if(r.error){erreur();return false}SBL=r.data||[];return true}
async function retirer(i){
if(!SBU){const l=lire();l.splice(i,1);ecrire(l);rendre();return}
const s=SBL[i];if(!s)return;const r=await SBC.from('souhaits').delete().eq('id',s.id);if(r.error){erreur();return}await charger();rendre()}
async function ajouter(v){
if(!SBU){const l=lire();if(!l.includes(v))l.push(v);ecrire(l);rendre();return}
if(SBL.some(s=>s.texte===v))return;
const r=await SBC.from('souhaits').insert({texte:v.slice(0,100)});if(r.error){erreur('Impossible d’ajouter (limite de 50 souhaits ?).');return}await charger();rendre()}
function lienCompte(t){const a=document.getElementById('lien-compte');if(a)a.textContent=t}
function chargerScript(src,sri){return new Promise((ok,ko)=>{const s=document.createElement('script');s.src=src;if(sri){s.integrity=sri;s.crossOrigin='anonymous'}s.onload=ok;s.onerror=ko;document.head.append(s)})}
async function initCompte(){
if(!CFG.url||!CFG.key)return;
document.getElementById('intro').textContent='Écrivez un produit avec vos mots (ex. : télé 55, rtx 4070). On le surveille pour vous. Sans compte, votre liste reste dans ce navigateur. Avec un compte (gratuit), elle vous suit partout et vous pouvez recevoir des alertes.';
try{await chargerScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js','sha256-hZaWX+kY5lZgChtWjToWj1wNPSKmAIhrtvRKZVXbAec=');
SBC=window.supabase.createClient(CFG.url,CFG.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}})}
catch(e){const z=document.getElementById('compte');z.className='boite';z.textContent='Les comptes sont indisponibles pour le moment. Votre liste locale fonctionne toujours.';return}
SBC.auth.onAuthStateChange((ev)=>{if(ev==='SIGNED_IN'||ev==='SIGNED_OUT'||ev==='USER_UPDATED')setTimeout(appliquer,0)});
appliquer()}
async function appliquer(){
const r=await SBC.auth.getSession();const u=r.data&&r.data.session?r.data.session.user:null;
if(u&&SBU&&u.id===SBU.id)return;
SBU=u;SBL=[];PROFIL=null;
if(SBU){await charger();await chargerProfil()}
lienCompte(SBU?'Mon compte':'Se connecter');dessinerCompte();rendre()}
async function chargerProfil(){
let r=await SBC.from('profils').select('ntfy_sujet,alertes_actives').maybeSingle();
if(!r.error&&!r.data){await SBC.from('profils').insert({});r=await SBC.from('profils').select('ntfy_sujet,alertes_actives').maybeSingle()}
PROFIL=r.error?null:r.data}
function dessinerCompte(){
const z=document.getElementById('compte');z.innerHTML='';z.className='boite';
const msg=el('p','petit');msg.id='msg-compte';msg.setAttribute('role','status');
if(!SBU){
z.append(el('h2','','Se connecter (facultatif)'));
z.append(el('p','petit','Entrez votre courriel : on vous envoie un lien de connexion. Pas de mot de passe.'));
const f=el('form','ligne'),i=el('input');i.type='email';i.required=true;i.placeholder='votre@courriel.com';i.autocomplete='email';i.setAttribute('aria-label','Courriel');
const b=el('button','','Recevoir mon lien');b.type='submit';f.append(i,b);
f.onsubmit=async e=>{e.preventDefault();b.disabled=true;msg.textContent='Envoi en cours…';
const r=await SBC.auth.signInWithOtp({email:i.value.trim(),options:{emailRedirectTo:location.href.split('#')[0].split('?')[0]}});
b.disabled=false;msg.textContent=r.error?'Impossible d’envoyer le lien. Vérifiez le courriel et réessayez.':'C’est envoyé ! Ouvrez votre courriel et cliquez sur le lien (pensez à regarder les indésirables).'};
z.append(f,msg);return}
z.append(el('h2','','Mon compte'));
z.append(el('p','petit','Connecté : '+(SBU.email||'')));
const loc=lireLocal();
if(loc.length&&!localStorage.getItem('import-fait')){
const o=el('div','avis');o.append(el('p','','Vous avez '+loc.length+' souhait'+(loc.length>1?'s':'')+' sur cet appareil. Les ajouter à votre compte ?'));
const oui=el('button','','Oui, les ajouter'),non=el('button','sec','Non merci');
oui.onclick=async()=>{const ex=new Set(SBL.map(s=>s.texte));const nv=loc.filter(t=>!ex.has(t)).slice(0,50).map(t=>({texte:String(t).slice(0,100)}));
if(nv.length){const r=await SBC.from('souhaits').insert(nv);if(r.error){erreur('Import impossible (limite de 50 souhaits ?).');return}}
try{localStorage.removeItem('souhaits');localStorage.setItem('import-fait','1')}catch(e){}await charger();dessinerCompte();rendre()};
non.onclick=()=>{try{localStorage.setItem('import-fait','1')}catch(e){}dessinerCompte()};
o.append(oui,non);z.append(o)}
z.append(alertes());
const q=el('button','sec','Se déconnecter');q.onclick=async()=>{await SBC.auth.signOut();SBU=null;SBL=[];PROFIL=null;lienCompte('Se connecter');dessinerCompte();rendre()};
z.append(q,msg)}
function alertes(){
const s=el('div','alertes');s.append(el('h3','','Alertes sur votre téléphone'));
if(!PROFIL){s.append(el('p','petit','Les alertes ne sont pas encore prêtes. Réessayez dans un instant.'));return s}
const ol=el('ol','etapes');
ol.append(el('li','','Installez l’app gratuite « ntfy » sur votre téléphone (Android ou iPhone).'));
const l2=el('li','','Dans l’app, touchez « S’abonner », puis entrez ce nom de sujet privé : ');
const code=el('code','sujet',PROFIL.ntfy_sujet);l2.append(code);
const cp=el('button','sec','Copier');cp.type='button';cp.onclick=async()=>{try{await navigator.clipboard.writeText(PROFIL.ntfy_sujet);cp.textContent='Copié !'}catch(e){cp.textContent='Copie impossible'}setTimeout(()=>cp.textContent='Copier',2000)};
const ln=el('a','','Ouvrir ntfy.sh/'+PROFIL.ntfy_sujet);ln.href='https://ntfy.sh/'+encodeURIComponent(PROFIL.ntfy_sujet);ln.target='_blank';ln.rel='noopener noreferrer';
const d=el('div','petit');d.append(cp,document.createTextNode(' '),ln);l2.append(d);ol.append(l2);
ol.append(el('li','','Gardez les alertes activées ci-dessous. Vous serez prévenu quand un nouveau bon plan correspond à un de vos souhaits.'));
s.append(ol);
const lab=el('label','bascule'),cb=el('input');cb.type='checkbox';cb.checked=!!PROFIL.alertes_actives;
cb.onchange=async()=>{const r=await SBC.from('profils').update({alertes_actives:cb.checked}).eq('user_id',SBU.id);if(r.error){cb.checked=!cb.checked;erreur()}else{PROFIL.alertes_actives=cb.checked;erreur(cb.checked?'Alertes activées.':'Alertes désactivées.')}};
lab.append(cb,document.createTextNode(' Alertes activées'));s.append(lab);
s.append(el('p','petit','Ce nom de sujet est privé : ne le partagez pas. Maximum 5 alertes par vérification.'));
return s}
(D.hist?Promise.resolve(D.hist):fetch('historique.json').then(r=>r.json()).catch(()=>[])).then(h=>{D.hist=h;rendre();initCompte()});
</script>`;
function pageSouhaits(donnees, local) {
  const sb = JSON.stringify(SB || {}).replace(/</g, '\x5Cu003c').replace(/>/g, '\x5Cu003e');
  return pageSite('Ma liste', 's', CORPS_SOUHAITS.replace('__DONNEES__', () => donnees).replace('__SB__', () => sb), local);
}
const CORPS_APROPOS = `<h1>À propos</h1>
<p><strong>Bons Plans Canada</strong> est un petit site gratuit qui rassemble les meilleures aubaines trouvées au Canada, pour aider les consommateurs à ne pas payer plus cher que nécessaire.</p>
<h2>Comment les offres sont choisies</h2>
<p>Nous lisons les offres publiées sur des forums publics de bons plans et dans les promotions de détaillants. Chaque offre est ensuite classée par catégorie (informatique, épicerie, voyage, etc.) à l’aide de mots-clés, puis triée selon le rabais et la fraîcheur. La liste est actualisée chaque heure. Le classement est automatique : aucune offre n’est payée pour apparaître plus haut.</p>
<h2>À qui s’adresse le site</h2>
<p>Aux acheteurs du Canada, y compris du Québec, qui cherchent de bonnes affaires en ligne et en magasin. Les prix sont indiqués en dollars canadiens lorsque la source le précise.</p>
<h2>Liens affiliés</h2>
<p>${DIVULGATION} Les prix et la disponibilité peuvent changer : vérifiez toujours les détails sur le site du marchand.</p>
<h2>Nous joindre</h2>
<p class="avis">Courriel : <a href="mailto:christiansoh771@gmail.com"><strong>christiansoh771@gmail.com</strong></a></p>`;
const CORPS_CONFID = `<h1>Politique de confidentialité</h1>
<p>Dernière mise à jour : <span id="d">novembre 2026</span>. Cette politique est rédigée dans l’esprit de la LPRPDE (Canada) et de la Loi 25 (Québec).</p>
<h2>Sans compte</h2>
<p>Vous pouvez utiliser le site sans compte. Dans ce cas, nous ne collectons aucun renseignement personnel. La recherche, les filtres et votre liste de souhaits restent dans votre navigateur (stockage local) : rien n’est envoyé à nos serveurs. Vous pouvez les effacer en vidant les données du site dans votre navigateur.</p>
<h2>Avec un compte (facultatif)</h2>
<p>La création d’un compte est facultative. Vous vous connectez par un lien envoyé à votre courriel (sans mot de passe). Nous conservons, pour chaque compte :</p>
<ul>
<li>votre adresse courriel ;</li>
<li>les articles de votre liste de souhaits (du texte) ;</li>
<li>un sujet de notification privé, choisi au hasard ;</li>
<li>votre choix d’activer ou non les alertes ;</li>
<li>les liens des offres déjà envoyées en alerte.</li>
</ul>
<h2>Pourquoi nous les utilisons</h2>
<p>Seulement pour : vous connecter, garder votre liste de souhaits d’un appareil à l’autre, et vous envoyer des alertes quand une offre correspond à votre liste. Nous ne vendons pas vos renseignements et ne les utilisons pas pour de la publicité. En créant un compte, vous consentez à cet usage. Vous pouvez retirer votre consentement en supprimant votre compte.</p>
<h2>Alertes et ntfy.sh</h2>
<p>Les alertes sont des notifications envoyées par le service public ntfy.sh, vers votre sujet privé au hasard. Sur ntfy.sh, le nom d’un sujet n’est pas secret : toute personne qui le connaît peut lire les alertes. Ne partagez donc pas votre sujet. Les alertes contiennent des offres publiques, pas vos renseignements personnels. ntfy.sh est un service tiers qui a sa propre politique.</p>
<h2>Où sont gardées les données</h2>
<p>Les données de compte sont hébergées par Supabase. La région du serveur est choisie à la création du projet, idéalement le Canada (centre) ou les États-Unis. Vos renseignements peuvent donc être traités hors du Québec et du Canada, et être soumis aux lois de ces pays. Il en va de même pour ntfy.sh. En créant un compte, vous en êtes informé.</p>
<h2>Témoins (cookies) et suivi</h2>
<p>Nous n’utilisons aucun témoin de suivi, aucune publicité et aucun outil d’analyse. Si vous vous connectez, Supabase garde dans votre navigateur un jeton de session, nécessaire pour rester connecté. Il est effacé quand vous vous déconnectez.</p>
<h2>Combien de temps nous les gardons</h2>
<p>Vos données de compte sont gardées tant que le compte existe, puis supprimées à sa suppression. Les liens des offres déjà envoyées en alerte sont gardés 90 jours, puis effacés.</p>
<h2>Liens affiliés et sites externes</h2>
<p>${DIVULGATION} Lorsque vous cliquez sur un lien vers un marchand ou un réseau d’affiliation, ce site externe peut déposer ses propres témoins et appliquer sa propre politique de confidentialité. Nous ne contrôlons pas ces sites.</p>
<h2>Vos droits</h2>
<p>Vous pouvez demander l’accès à vos renseignements, leur correction ou leur suppression. Écrivez-nous par courriel : nous répondons et supprimons votre compte dans un délai de 30 jours.</p>
<h2>Responsable des renseignements personnels</h2>
<p>Le responsable est le propriétaire du site. Pour toute question ou plainte : <a href="mailto:christiansoh771@gmail.com"><strong>christiansoh771@gmail.com</strong></a>.</p>`;
function ecrireSite(donnees, souhaits, histCompact) {
  const dossier = path.join(DIR, 'site');
  fs.mkdirSync(dossier, { recursive: true });
  const debut = HTML_DEBUT
    .replace('<title>Bons plans</title>', () => '<title>Bons Plans Canada – Les meilleures aubaines au Canada</title>\n<meta name="description" content="' + DESC_SITE + '">\n<meta name="color-scheme" content="light dark">')
    .replace('</style>', () => CSS_SITE + '</style>')
    .replace('<header><h1>Bons plans</h1>', () => menuSite('a') + '\n<header><h1>Bons Plans Canada</h1><p class="hero">Les meilleures aubaines au Canada, triées pour vous, mises à jour chaque heure</p>')
    .replace(/<\/div>\s*<script type="application\/json"/, (m) => piedSite + '\n' + m);
  fs.writeFileSync(path.join(dossier, 'index.html'), debut + donnees + HTML_FIN);
  fs.writeFileSync(path.join(dossier, 'souhaits.html'), pageSouhaits(souhaits, false));
  fs.writeFileSync(path.join(dossier, 'historique.json'), JSON.stringify(histCompact));
  fs.writeFileSync(path.join(dossier, 'a-propos.html'), pageSite('À propos', 'p', CORPS_APROPOS));
  fs.writeFileSync(path.join(dossier, 'confidentialite.html'), pageSite('Confidentialité', 'c', CORPS_CONFID));
  fs.writeFileSync(path.join(dossier, 'robots.txt'), 'User-agent: *\nAllow: /\n');
}

// ---------- 6. Programme principal ----------
async function main() {
  const sources = lireJson('sources.json');
  const cfg = lireJson('categories.json');
  const R = preparerRegles(cfg);
  const fCache = path.join(DIR, 'cache.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(fCache, 'utf8')); } catch { /* pas de cache */ }

  let reussies = 0;
  for (const s of sources) {
    try {
      const items = analyser(await telecharger(s.url), s.nom);
      cache[s.nom] = { items, date: Date.now() };
      reussies++;
      console.error('OK    ' + s.nom + ' : ' + items.length + ' offres');
    } catch (e) {
      console.error('ECHEC ' + s.nom + ' : ' + e.message + (cache[s.nom] ? ' (ancienne copie utilisée)' : ''));
    }
    await sleep(1000);
  }
  const noms = new Set(sources.map((s) => s.nom));
  for (const k of Object.keys(cache)) if (!noms.has(k)) delete cache[k];
  if (!reussies && !Object.keys(cache).length) throw new Error('aucune source disponible');
  fs.writeFileSync(fCache, JSON.stringify(cache));

  const maintenant = Date.now();
  const tous = Object.values(cache).flatMap((c) => c.items).sort((a, b) => (b.date || 0) - (a.date || 0));
  const deals = sansDoublons(tous).map((x) => {
    const { prix, pct } = extraire(x.titre);
    const d = { ...x, categorie: classer(x.titre, R), magasin: magasinDe(x.titre, R), prix, pct };
    d.score = score(d, maintenant);
    return d;
  });
  const ordre = R.ordre.concat('Autre').filter((v, i, a) => a.indexOf(v) === i);
  const donnees = JSON.stringify({ deals, ordre, genere: maintenant }).replace(/</g, '\\u003c');
  const histCompact = majHistorique(deals, maintenant);
  fs.writeFileSync(path.join(DIR, 'nouveaux.json'), JSON.stringify(NOUVEAUX)); // lu par alertes.js
  const cal = lireJson('calendrier.json');
  const base = { deals: deals.map((d) => ({ titre: d.titre, lien: d.lien, prix: d.prix, magasin: d.magasin })), cal, cfg: { categories: cfg.categories, ordre_priorite: cfg.ordre_priorite } };
  const sjson = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
  const debutLocal = HTML_DEBUT.replace('</style>', () => CSS_SITE + '</style>').replace('<header>', () => menuSite('a', true) + '\n<header>');
  fs.writeFileSync(path.join(DIR, 'bons-plans.html'), debutLocal + donnees + HTML_FIN);
  fs.writeFileSync(path.join(DIR, 'souhaits.html'), pageSouhaits(sjson({ ...base, hist: histCompact }), true));
  ecrireSite(donnees, sjson(base), histCompact);
  console.log(deals.length + ' offres -> bons-plans.html + souhaits.html + site/');
}
main().catch((e) => { console.error(e.message); process.exit(1); });
