// Récupère les flux RSS côté serveur (GitHub Actions), choisit quelques articles
// récents par rubrique et écrit site/news.json, lu ensuite par index.html.
import { XMLParser } from "fast-xml-parser";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fichierConfig = process.env.FEEDS || path.join(racine, "feeds.json");
const dossierSortie = process.env.OUT || path.join(racine, "site");
const config = JSON.parse(await readFile(fichierConfig, "utf8"));

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text",
  parseTagValue: false, trimValues: true, processEntities: true, htmlEntities: true
});

const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
function txt(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === "object") return txt(v["#text"]);
  return String(v).trim();
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»",
  rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", ndash: "–", mdash: "—",
  eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", acirc: "â", ccedil: "ç", ocirc: "ô",
  icirc: "î", iuml: "ï", ugrave: "ù", ucirc: "û", euro: "€", oelig: "œ", Eacute: "É" };
function decoder(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, c) => {
    if (c[0] === "#") {
      const n = c[1].toLowerCase() === "x" ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return ENT[c] ?? ENT[c.toLowerCase()] ?? m;
  });
}
function nettoyer(html, max) {
  let t = decoder(String(html || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  if (max && t.length > max) t = t.slice(0, max - 1).replace(/\s\S*$/, "") + "…";
  return t;
}

function trouverLien(it) {
  const liens = arr(it.link);
  for (const l of liens) {
    if (typeof l === "string" && l.trim()) return l.trim();
    if (l && typeof l === "object") {
      if (l["@_href"] && (!l["@_rel"] || l["@_rel"] === "alternate")) return l["@_href"];
      if (l["#text"]) return String(l["#text"]).trim();
    }
  }
  const avecHref = liens.find(l => l && l["@_href"]);
  if (avecHref) return avecHref["@_href"];
  const guid = txt(it.guid);
  return /^https?:\/\//.test(guid) ? guid : "";
}

function listeArticles(doc) {
  if (doc.rss) return arr(arr(doc.rss.channel)[0]?.item);
  if (doc.feed) return arr(doc.feed.entry);
  if (doc["rdf:RDF"]) return arr(doc["rdf:RDF"].item);
  return [];
}

async function telecharger(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8" },
    signal: AbortSignal.timeout(20000), redirect: "follow"
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const debut = buf.subarray(0, 300).toString("latin1");
  const enc = (debut.match(/encoding=["']([\w-]+)["']/i)?.[1]
    || (r.headers.get("content-type") || "").match(/charset=([\w-]+)/i)?.[1] || "utf-8").toLowerCase();
  try { return new TextDecoder(enc).decode(buf); } catch { return buf.toString("utf8"); }
}

async function lireFlux(f) {
  let xml;
  try { xml = await telecharger(f.url); }
  catch (e) { await new Promise(r => setTimeout(r, 2000)); xml = await telecharger(f.url); }
  const brut = listeArticles(parser.parse(xml));
  if (!brut.length) throw new Error("aucun article trouvé dans le flux");
  return brut.map(it => {
    const d = new Date(txt(it.pubDate || it.published || it.updated || it["dc:date"]));
    return {
      titre: nettoyer(txt(it.title)),
      lien: trouverLien(it),
      date: isNaN(d) ? null : d,
      resume: nettoyer(txt(it.description || it.summary || it["media:description"]), 220),
      source: f.nom
    };
  }).filter(a => a.titre && a.lien);
}

const cleTitre = t => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function selectionner(parSource, heures, n, dejaVus) {
  const limite = Date.now() - heures * 36e5;
  const futur = Date.now() + 2 * 36e5;
  const files = parSource
    .map(l => l.filter(a => a.date && a.date.getTime() >= limite && a.date.getTime() <= futur).sort((a, b) => b.date - a.date))
    .filter(l => l.length)
    .sort((a, b) => b[0].date - a[0].date);
  const vus = new Set(dejaVus), choisis = [];
  for (let tour = 0; choisis.length < n && files.some(l => l.length > tour); tour++) {
    for (const l of files) {
      const a = l[tour];
      if (!a || vus.has(a.lien) || vus.has(cleTitre(a.titre))) continue;
      vus.add(a.lien); vus.add(cleTitre(a.titre));
      choisis.push(a);
      if (choisis.length >= n) break;
    }
  }
  return { choisis: choisis.sort((a, b) => b.date - a.date), vus };
}

const n = config.articlesParRubrique || 4;
let vusGlobal = new Set();
const sortie = { genere: new Date().toISOString(), rubriques: [] };
let totalArticles = 0;

const resultats = await Promise.all(config.rubriques.map(r => Promise.allSettled(r.flux.map(lireFlux))));

config.rubriques.forEach((r, i) => {
  const ok = [], ko = [], okNoms = new Set();
  resultats[i].forEach((res, j) => {
    const f = r.flux[j];
    if (res.status === "fulfilled") { ok.push(res.value); okNoms.add(f.nom); console.log(`ok   ${r.id.padEnd(13)} ${f.nom.padEnd(16)} ${res.value.length} articles`); }
    else { ko.push(f.nom); console.log(`ECHEC ${r.id.padEnd(12)} ${f.nom.padEnd(16)} ${f.url} : ${res.reason?.message || res.reason}`); }
  });
  let sel = selectionner(ok, config.fraicheurHeures || 30, n, vusGlobal);
  if (sel.choisis.length < n) sel = selectionner(ok, 72, n, vusGlobal);
  vusGlobal = sel.vus;
  totalArticles += sel.choisis.length;
  sortie.rubriques.push({
    id: r.id, nom: r.nom, sous: r.sous, teinte: r.teinte,
    sansReponse: [...new Set(ko)].filter(nom => !okNoms.has(nom)),
    articles: sel.choisis.map(a => ({ ...a, date: a.date.toISOString() }))
  });
});

if (!totalArticles) { console.error("Aucun article récupéré : rien n'est publié, la version précédente reste en ligne."); process.exit(1); }

await mkdir(dossierSortie, { recursive: true });
await writeFile(path.join(dossierSortie, "news.json"), JSON.stringify(sortie));
await copyFile(path.join(racine, "index.html"), path.join(dossierSortie, "index.html"));
console.log(`\n${totalArticles} articles écrits dans ${path.join(dossierSortie, "news.json")}`);
