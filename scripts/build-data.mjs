#!/usr/bin/env node
/*
 * Rebuilds the data constants embedded in index.html (DATA) and directory.html (D)
 * from a published data release.
 *
 *   node scripts/build-data.mjs <releaseDir> [--apply] [--out <dir>]
 *
 * <releaseDir> must contain facilities.json, field_offices.json,
 * immigration_courts.json and sources.json.
 *
 * Without --apply the script only reports; with --apply it rewrites the single
 * `const DATA={...};` line in index.html and the single `const D={...};` line in
 * directory.html. Nothing else in either file is touched — the map geometry
 * constants (TOPO_US, TOPO_STATES, GEO_TX) and all markup, CSS and page code are
 * left exactly as they are.
 *
 * Static reference data lives in scripts/ref/ (see the note field in each file).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const REF = path.join(HERE, 'ref');

/* ---------- args ---------- */
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const outIdx = argv.indexOf('--out');
const outDir = outIdx >= 0 ? argv[outIdx + 1] : null;
const releaseDir = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
if (!releaseDir) {
  console.error('usage: node scripts/build-data.mjs <releaseDir> [--apply] [--out <dir>]');
  process.exit(1);
}

const warnings = [];
const warn = m => { warnings.push(m); };

/* ---------- helpers ---------- */
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const val = (rec, field) => rec.fields?.[field]?.value ?? null;
const firstSource = (rec, field) => rec.fields?.[field]?.sources?.[0] ?? null;
const srcCode = (rec, field) => firstSource(rec, field)?.source ?? null;

// Round half to even — matches the rounding of the published constants.
function round(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// Sort descending on a numeric key, keeping the input order for equal values.
function stableDesc(arr, keyOf) {
  return arr.map((v, i) => [v, i]).sort((a, b) => keyOf(b[0]) - keyOf(a[0]) || a[1] - b[1]).map(p => p[0]);
}
const countDesc = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]);

/* ---------- inputs ---------- */
const facilities = readJson(path.join(releaseDir, 'facilities.json')).records;
const offices = readJson(path.join(releaseDir, 'field_offices.json')).records;
const courts = readJson(path.join(releaseDir, 'immigration_courts.json')).records;
const sourcesMeta = readJson(path.join(releaseDir, 'sources.json'));
const release = sourcesMeta.release;

const COUNTIES = readJson(path.join(REF, 'counties.json'));
const PLACEMENT = readJson(path.join(REF, 'placement.json'));

/* Display labels for the sources that the pages cite. A source that appears in a
   release but not here is reported and left uncited. */
const SOURCE_LABELS = {
  'ice-biweekly': { label: 'ICE FYTD detention statistics', url: 'ice.gov/detain/detention-management' },
  'uwchr': { label: 'UWCHR ICE-detain (FOIA-derived)', url: 'github.com/UWCHR/ice-detain' },
  'ice': { label: 'ICE detention-facility roster', url: 'ice.gov/detention-facilities' },
  'eoir': { label: 'EOIR immigration-court list', url: 'justice.gov/eoir' },
};
const CITED = new Set(Object.keys(SOURCE_LABELS));

for (const code of sourcesMeta.activeSources || []) {
  if (!CITED.has(code)) warn(`source "${code}" is active in the release but has no display label; values from it are shown without a source line`);
}

/* ---------- shared derivations ---------- */
const adpOf = f => val(f, 'adpTotal');
const reporting = facilities.filter(f => adpOf(f) != null);
const county0 = r => (r.county?.fips || [])[0] || null;
const soleState = f => ((f.states || []).length === 1 ? f.states[0] : null);
const countyName = fips => COUNTIES[fips]?.nm ?? null;

// facility -> co-located court name (the release appends a note to the value)
const stripNote = s => String(s).replace(/\s*\(co-located[^)]*\)\s*$/, '');
const linkedCourtNames = new Set(facilities.map(f => val(f, 'immigrationCourt')).filter(Boolean).map(stripNote));

// latest date each source reported, across every field of every record
const sourceAsOf = {};
for (const set of [facilities, offices, courts]) {
  for (const rec of set) {
    for (const k of Object.keys(rec.fields || {})) {
      for (const s of rec.fields[k].sources || []) {
        if (!sourceAsOf[s.source] || s.sourceAsOf > sourceAsOf[s.source]) sourceAsOf[s.source] = s.sourceAsOf;
      }
    }
  }
}

/* ---------- index.html: DATA ---------- */
function buildDATA(carriedIso) {
  const byState = {}, adpByStateRaw = {}, countyFac = {}, countyAdpRaw = {};
  for (const f of facilities) {
    const st = soleState(f);
    if (st) {
      byState[st] = (byState[st] || 0) + 1;
      if (adpOf(f) != null) adpByStateRaw[st] = (adpByStateRaw[st] || 0) + adpOf(f);
    }
    const fips = county0(f);
    if (fips) {
      countyFac[fips] = (countyFac[fips] || 0) + 1;
      if (adpOf(f) != null) countyAdpRaw[fips] = (countyAdpRaw[fips] || 0) + adpOf(f);
    }
  }
  const adpByState = Object.fromEntries(Object.entries(adpByStateRaw).map(([k, v]) => [k, round(v)]));
  const countyADP = Object.fromEntries(Object.entries(countyAdpRaw).map(([k, v]) => [k, round(v)]));

  const courtsByState = {};
  for (const c of courts) for (const st of c.states || []) courtsByState[st] = (courtsByState[st] || 0) + 1;

  // field offices, largest territory first
  const officeRows = stableDesc(offices, o => (o.county?.fips || []).length).map(o => {
    const code = val(o, 'fieldOfficeCode');
    const place = PLACEMENT.fieldOffice[code];
    if (!place) warn(`field office "${code}" has no entry in scripts/ref/placement.json — no map marker or display name`);
    const label = place?.place ?? o.primaryName.replace(/ Field Office$/, '');
    return {
      code,
      name: label + ' Field Office',
      nCounties: (o.county?.fips || []).length,
      hq: place?.hq ?? null,
      place: label,
    };
  });

  const aorOfCounty = {};
  for (const o of offices) {
    const code = val(o, 'fieldOfficeCode');
    for (const fips of o.county?.fips || []) aorOfCounty[fips] = code;
  }
  const facByAor = {};
  for (const f of facilities) {
    const a = val(f, 'fieldOffice');
    if (a) facByAor[a] = (facByAor[a] || 0) + 1;
  }
  const aorFacCount = countDesc(facByAor);

  // court dots: only courts whose county has a centroid on file
  const courtRows = [];
  for (const c of courts) {
    const fips = county0(c);
    const ll = PLACEMENT.countyCentroid[fips];
    if (!ll) { warn(`court "${c.primaryName}" (county ${fips || 'none'}) has no centroid in scripts/ref/placement.json — left off the court map`); continue; }
    courtRows.push({
      name: c.primaryName,
      st: (c.states || [])[0] ?? '',
      ll,
      status: val(c, 'operationalStatus') ?? '',
      detained: linkedCourtNames.has(c.primaryName),
    });
  }

  const adpSorted = reporting.map(adpOf).sort((a, b) => b - a);
  const adpTotalRaw = adpSorted.reduce((a, b) => a + b, 0);
  let running = 0;
  const adpCum = adpSorted.map(v => { running += v; return +(running / adpTotalRaw * 100).toFixed(2); });

  const rankedRecs = stableDesc(reporting, f => round(adpOf(f)));
  const ranked = rankedRecs.map(f => ({
    nm: f.primaryName,
    st: (f.states || [])[0] ?? '',
    adp: round(adpOf(f)),
    co: countyName(county0(f)) ?? '',
    cap: val(f, 'capacity'),
    h72: val(f, 'holdsOver72h') ?? '',
    fn: val(f, 'facilityFunction') ?? '',
  }));
  const topADP = rankedRecs.slice(0, 14).map(f => ({
    nm: f.primaryName,
    st: (f.states || [])[0] ?? '',
    adp: round(adpOf(f)),
    cap: val(f, 'capacity'),
    aor: val(f, 'fieldOffice'),
  }));
  const util = facilities
    .filter(f => adpOf(f) != null && val(f, 'capacity') != null)
    .map(f => ({ nm: f.primaryName, st: (f.states || [])[0] ?? '', adp: round(adpOf(f)), cap: val(f, 'capacity') }));

  const contractCounts = {}, ratingCounts = {}, agreementCounts = {};
  for (const f of facilities) {
    const c = val(f, 'agreement');
    if (c) contractCounts[c] = (contractCounts[c] || 0) + 1;
    const r = val(f, 'lastFinalRating');
    if (r) ratingCounts[r] = (ratingCounts[r] || 0) + 1;
    agreementCounts[f.nameAgreement] = (agreementCounts[f.nameAgreement] || 0) + 1;
  }

  const threat = {};
  for (const k of ['iceThreatLevel1', 'iceThreatLevel2', 'iceThreatLevel3', 'noIceThreatLevel']) {
    threat[k] = round(facilities.reduce((a, f) => a + (val(f, k) || 0), 0));
  }

  const sources = {};
  for (const code of ['ice-biweekly', 'uwchr', 'ice', 'eoir']) {
    const meta = sourcesMeta.sources?.[code];
    if (!meta) { warn(`source "${code}" is cited by the pages but missing from the release`); continue; }
    sources[code] = {
      label: SOURCE_LABELS[code].label,
      asOf: sourceAsOf[code] ?? null,
      license: meta.license === 'green' ? 'public domain' : 'attribution',
      url: SOURCE_LABELS[code].url,
    };
  }

  const countyNames = {};
  for (const fips of new Set([...Object.keys(countyFac), ...Object.keys(countyADP)])) {
    const nm = countyName(fips);
    if (nm) countyNames[fips] = nm;
  }

  const scaleRows = [];
  const noPop = [];
  for (const [fips, adp] of Object.entries(countyADP)) {
    const ref = COUNTIES[fips];
    if (!ref?.pop) { noPop.push(fips); continue; }
    scaleRows.push({ fips, nm: ref.nm, pop: ref.pop, adp, share: +(adp / ref.pop * 100).toFixed(2) });
  }
  if (noPop.length) warn(`${noPop.length} counties hold people but have no resident count on file (${noPop.join(', ')}) — left off the scale scatter`);
  const countyScale = scaleRows.sort((a, b) => b.share - a.share || (a.fips < b.fips ? -1 : 1));

  const NON_DETENTION = new Set(['HOLD', 'HOSPITAL', 'TRANSPORT', 'STAGING', 'HEALTH', 'POE']);
  const share = recs => Math.round(recs.reduce((a, f) => a + adpOf(f), 0) / adpTotalRaw * 100);
  const h72Recs = rankedRecs.filter(f => String(val(f, 'holdsOver72h') || '').toLowerCase() === 'yes');
  const dedRecs = rankedRecs.filter(f => !NON_DETENTION.has(String(val(f, 'facilityFunction') || '').toUpperCase()));

  return {
    release,
    totals: { facilities: facilities.length, courts: courts.length, offices: offices.length },
    byState,
    adpByState,
    courtsByState,
    countyFac,
    countyADP,
    offices: officeRows,
    aorOfCounty,
    aorFacCount,
    courts: courtRows,
    adpSorted,
    adpCum,
    adpTotal: round(adpTotalRaw),
    rosterOnly: facilities.length - reporting.length,
    contract: countDesc(contractCounts),
    topADP,
    aor: aorFacCount,
    util,
    threat,
    convergence: { name: ['single', 'converged', 'conflict'].filter(k => agreementCounts[k]).map(k => [k, agreementCounts[k]]) },
    rating: countDesc(ratingCounts),
    sources,
    countyNames,
    countyScale,
    ranked,
    coloc: {
      facLinked: facilities.filter(f => val(f, 'immigrationCourt')).length,
      courtsDetained: courtRows.filter(c => c.detained).length,
      courtsTotal: courtRows.length,
    },
    defs: {
      h72: { n: h72Recs.length, pct: share(h72Recs) },
      ded: { n: dedRecs.length, pct: share(dedRecs) },
    },
    iso: carriedIso,
  };
}

/* ---------- directory.html: D ---------- */
const TYPE_LABELS = {
  'IGSA': 'County/city jail (IGSA)',
  'DIGSA': 'Dedicated ICE facility (DIGSA)',
  'CDF': 'Contract detention facility',
  'SPC': 'ICE service processing center',
  'USMS IGA': 'U.S. Marshals (IGA)',
  'USMS CDF': 'Marshals contract facility',
  'BOP': 'Federal prison (BOP)',
  'STATE': 'State facility',
  'STAGING': 'Staging site',
  'MIRP': 'Migrant processing',
  'FAMILY': 'Family residential',
  'DOD': 'Dept. of Defense',
  'Other': 'Other',
};

// the release carries the full operational-status note; the card shows the leading word
const shortStatus = s => String(s ?? '').trim().split(/\s+/)[0].toUpperCase();

function buildD() {
  // sources cited by a record's displayed values, in display order
  const citedSources = (rec, fields, dropUrls) => {
    const out = [], seen = new Set();
    for (const f of fields) {
      const s = firstSource(rec, f);
      if (!s || !CITED.has(s.source) || seen.has(s.source)) continue;
      seen.add(s.source);
      out.push({ s: s.source, u: dropUrls ? null : (s.url ?? null) });
    }
    return out;
  };
  const known = code => (code && CITED.has(code) ? code : null);

  const ents = [];
  for (const c of courts) {
    ents.push({
      k: 'c',
      nm: c.primaryName,
      st: c.states || [],
      co: c.county?.names || [],
      status: shortStatus(val(c, 'operationalStatus')),
      statusSrc: known(srcCode(c, 'operationalStatus')),
      addr: val(c, 'address') ?? null,
      addrSrc: known(srcCode(c, 'address')),
      det: linkedCourtNames.has(c.primaryName),
      src: citedSources(c, ['operationalStatus', 'address'], true),
    });
  }
  for (const o of offices) {
    ents.push({
      k: 'o',
      nm: o.primaryName,
      st: o.states || [],
      code: val(o, 'fieldOfficeCode') ?? '',
      codeSrc: known(srcCode(o, 'fieldOfficeCode')),
      ncounty: (o.county?.fips || []).length,
      addr: val(o, 'address') ?? null,
      addrSrc: known(srcCode(o, 'address')),
      phone: val(o, 'phone') ?? null,
      phoneSrc: known(srcCode(o, 'phone')),
      src: citedSources(o, ['fieldOfficeCode', 'address', 'phone'], false),
    });
  }
  for (const f of facilities) {
    const ag = val(f, 'agreement') ?? '';
    if (ag && !TYPE_LABELS[ag]) warn(`facility agreement type "${ag}" has no label; shown as-is`);
    let iceUrl = null;
    for (const k of Object.keys(f.fields || {})) {
      const hit = (f.fields[k].sources || []).find(s => s.source === 'ice' && s.url);
      if (hit) { iceUrl = hit.url; break; }
    }
    const court = val(f, 'immigrationCourt');
    const ent = {
      k: 'f',
      nm: f.primaryName,
      st: f.states || [],
      co: f.county?.names || [],
      ag,
      type: ag ? (TYPE_LABELS[ag] || ag) : '',
      typeSrc: known(srcCode(f, 'agreement')),
      addr: val(f, 'address') ?? null,
      addrSrc: known(srcCode(f, 'address')),
      aor: val(f, 'fieldOffice') ?? '',
      adp: adpOf(f) == null ? null : round(adpOf(f)),
      adpSrc: known(srcCode(f, 'adpTotal')),
      cap: val(f, 'capacity'),
      capSrc: known(srcCode(f, 'capacity')),
      h72: val(f, 'holdsOver72h') ?? '',
      fn: val(f, 'facilityFunction') ?? '',
      court: court ? stripNote(court) : '',
      courtSrc: known(srcCode(f, 'immigrationCourt')),
      src: citedSources(f, ['agreement', 'address', 'adpTotal', 'capacity', 'immigrationCourt'], false),
    };
    if (iceUrl) ent.iceUrl = iceUrl;
    ents.push(ent);
  }

  const srcinfo = {};
  for (const code of ['eoir', 'uwchr', 'ice', 'ice-biweekly']) {
    const meta = sourcesMeta.sources?.[code];
    if (!meta) continue;
    srcinfo[code] = {
      name: SOURCE_LABELS[code].label,
      asOf: sourceAsOf[code] ?? null,
      lic: meta.license,
      home: meta.source_url,
    };
  }

  const offmap = {};
  for (const o of offices) {
    const code = val(o, 'fieldOfficeCode');
    offmap[code] = PLACEMENT.fieldOffice[code]?.short ?? o.primaryName.replace(/ Field Office$/, '');
  }

  const typeCounts = {};
  for (const f of facilities) {
    const ag = val(f, 'agreement');
    if (ag) typeCounts[ag] = (typeCounts[ag] || 0) + 1;
  }
  const typeopts = countDesc(typeCounts).map(([ag]) => [ag, TYPE_LABELS[ag] || ag]);

  return { release, srcinfo, offmap, typeopts, ents };
}

/* ---------- embed ---------- */
function readConstant(file, name) {
  const text = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`^const ${name}=\\{.*\\};$`, 'm');
  const m = text.match(re);
  if (!m) throw new Error(`could not find "const ${name}={...};" on its own line in ${file}`);
  return { text, line: m[0], value: new Function(`${m[0]}; return ${name};`)() };
}

function serialize(name, value) {
  const json = JSON.stringify(value);
  if (/[\u2028\u2029]/.test(json)) throw new Error('data contains a line separator character');
  // keep the string from ever closing the surrounding <script> element
  return `const ${name}=${json.replace(/<\//g, '<\\/')};`;
}

/* ---------- run ---------- */
const indexFile = path.join(ROOT, 'index.html');
const directoryFile = path.join(ROOT, 'directory.html');

const prevIndex = readConstant(indexFile, 'DATA');
const prevDirectory = readConstant(directoryFile, 'D');

// The isolation panel is not derived from the release: its per-facility distances
// come from coordinates the release does not carry. It is passed through unchanged.
const carriedIso = prevIndex.value.iso;
if (carriedIso) warn(`DATA.iso carried through from the embedded copy (release ${prevIndex.value.release}) — it is not derived from ${release}`);

const DATA = buildDATA(carriedIso);
const D = buildD();

const lineDATA = serialize('DATA', DATA);
const lineD = serialize('D', D);

// syntax check, the same way the review pages are checked
for (const [name, line] of [['DATA', lineDATA], ['D', lineD]]) {
  try { new Function(line); } catch (e) { throw new Error(`${name} does not parse as JavaScript: ${e.message}`); }
}

const summary = {
  release,
  totals: DATA.totals,
  texasFacilities: DATA.byState.TX,
  texasAdp: DATA.adpByState.TX,
  adpTotal: DATA.adpTotal,
  reportingFacilities: DATA.ranked.length,
  rosterOnly: DATA.rosterOnly,
  courtsPlotted: DATA.courts.length,
  courtsDetained: DATA.coloc.courtsDetained,
  countiesWithFacility: Object.keys(DATA.countyFac).length,
  countiesHoldingPeople: Object.keys(DATA.countyADP).length,
  countiesOnScaleChart: DATA.countyScale.length,
  directoryEntities: D.ents.length,
};
console.log(JSON.stringify(summary, null, 2));

if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'DATA.json'), JSON.stringify(DATA, null, 1) + '\n');
  fs.writeFileSync(path.join(outDir, 'D.json'), JSON.stringify(D, null, 1) + '\n');
  console.log(`wrote DATA.json and D.json to ${outDir}`);
}

if (apply) {
  fs.writeFileSync(indexFile, prevIndex.text.replace(prevIndex.line, () => lineDATA));
  fs.writeFileSync(directoryFile, prevDirectory.text.replace(prevDirectory.line, () => lineD));
  console.log(`updated index.html (${prevIndex.line.length} -> ${lineDATA.length} bytes) and directory.html (${prevDirectory.line.length} -> ${lineD.length} bytes)`);
} else {
  console.log('dry run — pass --apply to rewrite index.html and directory.html');
}

if (warnings.length) {
  console.log('\nwarnings:');
  for (const w of warnings) console.log('  - ' + w);
}
