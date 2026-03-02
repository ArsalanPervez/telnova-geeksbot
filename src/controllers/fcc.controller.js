/**
 * fcc.controller.js
 *
 * On startup this module automatically builds a ZIP → providers index from
 * the FCC BDC CSV files in data/raw/ (if present). No separate script needed.
 *
 * Data resolution order for each request:
 *   1. In-memory local BDC index  (built from CSV files at startup)
 *   2. FCC Broadband Map API      (works on Koyeb Washington DC — US IP)
 *   3. FCC Open Data fallback     (OData / Socrata — public, no geo-block)
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

/* ─── PATHS ──────────────────────────────────────────────────────────────── */

const RAW_DIR     = path.join(__dirname, '../../data/raw');
const CACHE_PATH  = path.join(__dirname, '../data/providers.json');

const TRACT_FILE  = path.join(RAW_DIR, 'Zip_tract.txt');
const CSV_FILES   = [
  'Alabama-Cable_fixed_broadband_J25_17feb2026.csv',
  'Alabama-FibertothePremises_fixed_broadband_J25_17feb2026.csv',
  // Add more state CSV files here
];

/* ─── CONSTANTS ─────────────────────────────────────────────────────────── */

const TECH_MAP = {
  10:'DSL', 11:'DSL', 12:'VDSL',
  40:'Cable', 41:'Cable', 42:'Cable', 43:'Cable',
  50:'Fiber',
  60:'Satellite', 61:'Satellite', 62:'Satellite',
  70:'Fixed Wireless', 71:'Fixed Wireless', 72:'Fixed Wireless',
  300:'Licensed Fixed Wireless',
  400:'Fixed Wireless',
};

const SVC_MAP = { R:'Residential', B:'Business', X:'Both' };

/* ─── HELPERS ────────────────────────────────────────────────────────────── */

function techLabel(code) {
  const n = parseInt(code, 10);
  if (TECH_MAP[n]) return TECH_MAP[n];
  if (n >= 200)    return 'Satellite';
  return 'Other';
}

function normalise(records) {
  const seen = {};
  for (const r of records) {
    const tech  = techLabel(r.technology ?? r.tech_type ?? r.tech ?? '');
    const brand = (r.brand_name ?? r.provider_name ?? r.name ?? r.holding_company ?? '').trim();
    if (!brand) continue;

    const dl  = parseInt(r.max_advertised_download_speed ?? r.max_dl_speed ?? r.download_speed ?? 0) || 0;
    const ul  = parseInt(r.max_advertised_upload_speed   ?? r.max_ul_speed ?? r.upload_speed   ?? 0) || 0;
    const key = brand.toLowerCase() + '|' + tech;

    if (!seen[key] || dl > seen[key].dl) {
      seen[key] = {
        brand, tech, dl, ul,
        ll:  r.low_latency === 1 || r.low_latency === true || r.low_latency === '1',
        svc: SVC_MAP[r.business_residential_code] ?? r.service_type ?? '',
      };
    }
  }
  return Object.values(seen).sort((a, b) => b.dl - a.dl || a.brand.localeCompare(b.brand));
}

function parseCSVLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function streamLines(filePath, onLine) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', onLine);
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildSummary(providers) {
  const byTech = {};
  let maxDl = 0, maxUl = 0;
  for (const p of providers) {
    byTech[p.tech] = (byTech[p.tech] || 0) + 1;
    if (p.dl > maxDl) maxDl = p.dl;
    if (p.ul > maxUl) maxUl = p.ul;
  }
  return {
    total_providers:   providers.length,
    fiber_count:       byTech['Fiber'] || 0,
    max_download_mbps: maxDl,
    max_upload_mbps:   maxUl,
    by_technology:     byTech,
  };
}

/* ─── AUTO-BUILD FROM CSV FILES ─────────────────────────────────────────────
 *
 * Runs automatically on server startup.
 * 1. Try to load cached providers.json (fast — instant)
 * 2. If missing, build from raw CSV files and save cache (runs once)
 * 3. If no CSV files either, skip — fall back to FCC API per request
 *
 * ─────────────────────────────────────────────────────────────────────────── */

let LOCAL_PROVIDERS = null;

async function buildIndex() {
  /* ── Try cache first ── */
  if (fs.existsSync(CACHE_PATH)) {
    try {
      LOCAL_PROVIDERS = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      console.log(`[FCC] Loaded cached index — ${Object.keys(LOCAL_PROVIDERS).length} ZIPs`);
      return;
    } catch {
      console.warn('[FCC] Cache corrupt, rebuilding …');
    }
  }

  /* ── Check raw files exist ── */
  if (!fs.existsSync(TRACT_FILE)) {
    console.log('[FCC] No local BDC data (data/raw/Zip_tract.txt not found) — using API');
    return;
  }

  const availableCSVs = CSV_FILES.filter(f => fs.existsSync(path.join(RAW_DIR, f)));
  if (availableCSVs.length === 0) {
    console.log('[FCC] No CSV files found in data/raw/ — using API');
    return;
  }

  /* ── Build from raw files ── */
  console.log(`[FCC] Building index from ${availableCSVs.length} CSV file(s) …`);
  const t0 = Date.now();

  /* Step 1: ZIP → tract crosswalk */
  const zipTracts = {}, zipMeta = {};
  let hdr = null;

  await streamLines(TRACT_FILE, (line) => {
    if (!line.trim()) return;
    const cols = line.split('\t');
    if (!hdr) { hdr = cols.map(h => h.trim()); return; }

    const row = Object.fromEntries(hdr.map((h, i) => [h, (cols[i] || '').trim()]));
    const z   = (row.ZIP || '').padStart(5, '0');
    const t   = row.TRACT || '';
    if (z.length !== 5 || t.length !== 11) return;

    if (!zipTracts[z]) {
      zipTracts[z] = new Set();
      zipMeta[z] = {
        city:  (row.USPS_ZIP_PREF_CITY  || '').trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase()),
        state: (row.USPS_ZIP_PREF_STATE || '').trim().toUpperCase(),
      };
    }
    zipTracts[z].add(t);
  });

  /* Step 2: CSV files → tract index */
  const tractIndex = {};

  for (const fname of availableCSVs) {
    const fpath = path.join(RAW_DIR, fname);
    let csvHdr = null;

    await streamLines(fpath, (line) => {
      if (!line.trim()) return;
      const cols = parseCSVLine(line);
      if (!csvHdr) { csvHdr = cols.map(h => h.trim()); return; }

      const row   = Object.fromEntries(csvHdr.map((h, i) => [h, (cols[i] || '').trim()]));
      const geoid = row.block_geoid || '';
      if (geoid.length < 11) return;

      const tract = geoid.slice(0, 11);
      const brand = (row.brand_name || '').trim();
      if (!brand) return;

      const tech = techLabel(row.technology);
      const dl   = parseInt(row.max_advertised_download_speed) || 0;
      const ul   = parseInt(row.max_advertised_upload_speed)   || 0;
      const ll   = row.low_latency === '1';
      const svc  = SVC_MAP[row.business_residential_code] || '';
      const key  = brand.toLowerCase() + '|' + tech;

      if (!tractIndex[tract]) tractIndex[tract] = {};
      const ex = tractIndex[tract][key];
      if (!ex || dl > ex.dl) tractIndex[tract][key] = { brand, tech, dl, ul, ll, svc };
    });
  }

  /* Step 3: ZIP → providers */
  const result = {};
  for (const [zip, tracts] of Object.entries(zipTracts)) {
    const merged = {};
    for (const tract of tracts) {
      for (const [key, rec] of Object.entries(tractIndex[tract] || {})) {
        if (!merged[key] || rec.dl > merged[key].dl) merged[key] = rec;
      }
    }
    if (Object.keys(merged).length === 0) continue;

    result[zip] = {
      city:  zipMeta[zip].city,
      state: zipMeta[zip].state,
      providers: Object.values(merged).sort((a, b) => b.dl - a.dl || a.brand.localeCompare(b.brand)),
    };
  }

  LOCAL_PROVIDERS = result;
  console.log(`[FCC] Index built — ${Object.keys(result).length} ZIPs  [${((Date.now()-t0)/1000).toFixed(1)}s]`);

  /* Save cache so next startup is instant */
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(result));
    console.log('[FCC] Cache saved → src/data/providers.json');
  } catch (err) {
    console.warn('[FCC] Could not save cache:', err.message);
  }
}

/* Start building in background immediately — server stays responsive */
buildIndex().catch(err => console.error('[FCC] Index build failed:', err.message));

/* ─── ZIP → lat/lon + state via Nominatim ───────────────────────────────── */

async function zipToCoords(zip) {
  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?postalcode=${zip}&country=US&format=json&limit=1&addressdetails=1`;

  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'telnova-api/1.0', 'Accept-Language': 'en-US,en' },
  });

  if (!res.ok) throw new Error(`Nominatim error: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.length) throw new Error(`ZIP code ${zip} not found.`);

  const item  = data[0];
  const addr  = item.address || {};
  const iso   = addr['ISO3166-2-lvl4'] || '';
  const state = iso.includes('-') ? iso.split('-')[1] : '';

  return {
    lat:       parseFloat(item.lat),
    lon:       parseFloat(item.lon),
    city:      addr.city || addr.town || addr.village || addr.county || '',
    county:    addr.county || '',
    state,
    stateName: addr.state || '',
  };
}

/* ─── FCC API Endpoints ─────────────────────────────────────────────────── */

const FCC_BDC_ENDPOINTS = [
  {
    label: 'listAvailability',
    build: (lat, lon, zip, state) =>
      `https://broadbandmap.fcc.gov/api/public/map/listAvailability?` +
      `latitude=${lat}&longitude=${lon}&unit=&addr=&city=&state=${state}` +
      `&zip=${zip}&category=Residential&speed_tier=&tech_type=&provider_id=`,
  },
  {
    label: 'map/availability',
    build: (lat, lon, zip) =>
      `https://broadbandmap.fcc.gov/api/public/map/availability?` +
      `latitude=${lat}&longitude=${lon}&zip=${zip}`,
  },
  {
    label: 'public/availability',
    build: (lat, lon, zip, state) =>
      `https://broadbandmap.fcc.gov/api/public/availability?` +
      `latitude=${lat}&longitude=${lon}&zip=${zip}&state=${state}`,
  },
];

const FCC_ODATA_ENDPOINTS = [
  {
    label: 'OData BDC 2023',
    build: (lat, lon, zip) =>
      `https://opendata.fcc.gov/api/odata/v4/mf2023_providers_by_postal_code` +
      `?$filter=postal_code eq '${zip}'&$select=brand_name,technology,max_advertised_download_speed,max_advertised_upload_speed&$top=200`,
    extract: (d) => d?.value ?? null,
  },
  {
    label: 'OData BDC 2022',
    build: (lat, lon, zip) =>
      `https://opendata.fcc.gov/api/odata/v4/mf2022_providers_by_postal_code` +
      `?$filter=postal_code eq '${zip}'&$select=brand_name,technology,max_advertised_download_speed,max_advertised_upload_speed&$top=200`,
    extract: (d) => d?.value ?? null,
  },
  {
    label: 'Socrata FCC',
    build: (lat, lon, zip) =>
      `https://opendata.fcc.gov/resource/hicn-aujz.json?zip_code=${zip}&$limit=200`,
    extract: (d) => (Array.isArray(d) ? d : null),
  },
];

async function fetchProvidersFromAPI(lat, lon, zip, state) {
  const errors = [];

  for (const ep of FCC_BDC_ENDPOINTS) {
    console.log(`  [BDC] Trying ${ep.label} …`);
    try {
      const res = await fetchWithTimeout(ep.build(lat, lon, zip, state), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; telnova-api/1.0)',
          'Referer':    'https://broadbandmap.fcc.gov/',
          'Accept':     'application/json',
        },
      });
      if (!res.ok) { errors.push(`${ep.label}: HTTP ${res.status}`); continue; }

      const data  = await res.json();
      if (data.status_code && data.status_code !== 200) {
        errors.push(`${ep.label}: FCC status ${data.status_code}`); continue;
      }

      const avail =
        data?.output?.availability ?? data?.availability ??
        data?.output?.providers    ?? data?.providers    ??
        data?.results ?? data?.data ?? (Array.isArray(data) ? data : null);

      if (Array.isArray(avail)) { console.log(`  [BDC] ✓ ${ep.label}`); return avail; }
      errors.push(`${ep.label}: no array in response`);
    } catch (err) { errors.push(`${ep.label}: ${err.message}`); }
  }

  for (const ep of FCC_ODATA_ENDPOINTS) {
    console.log(`  [OData] Trying ${ep.label} …`);
    try {
      const res = await fetchWithTimeout(ep.build(lat, lon, zip, state), {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) { errors.push(`${ep.label}: HTTP ${res.status}`); continue; }

      const records = ep.extract(await res.json());
      if (Array.isArray(records) && records.length > 0) {
        console.log(`  [OData] ✓ ${ep.label}`); return records;
      }
      errors.push(`${ep.label}: no records`);
    } catch (err) { errors.push(`${ep.label}: ${err.message}`); }
  }

  throw new Error('All FCC endpoints failed:\n' + errors.map(e => '  • ' + e).join('\n'));
}

/* ═══════════════════════════════════════════════════════════════════════════
   ROUTE HANDLER — GET /api/fcc/lookup?zip=35801
═══════════════════════════════════════════════════════════════════════════ */

const lookup = async (req, res) => {
  const zip = (req.query.zip || '').trim().padStart(5, '0');

  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'Invalid ZIP code. Must be 5 digits.' });
  }

  console.log(`\n[FCC LOOKUP] ZIP=${zip}`);

  /* ── Strategy 1: Local BDC index ── */
  if (LOCAL_PROVIDERS && LOCAL_PROVIDERS[zip]) {
    console.log(`[LOCAL] Serving ZIP ${zip} from local BDC index`);
    const entry     = LOCAL_PROVIDERS[zip];
    const providers = entry.providers || [];
    return res.json({
      zip,
      city:      entry.city  || '',
      county:    '',
      state:     entry.state || '',
      stateName: '',
      providers,
      summary: buildSummary(providers),
      meta: {
        source:      'local_bdc',
        raw_records: providers.length,
        deduped:     providers.length,
        fetched_at:  new Date().toISOString(),
      },
    });
  }

  /* ── Strategy 2: FCC API (works from Koyeb Washington DC) ── */
  try {
    console.log('[1/2] Resolving ZIP → coordinates …');
    const coords = await zipToCoords(zip);
    console.log(`  lat=${coords.lat}, lon=${coords.lon}, state=${coords.state}`);

    console.log('[2/2] Fetching from FCC API …');
    const raw       = await fetchProvidersFromAPI(coords.lat, coords.lon, zip, coords.state);
    const providers = normalise(raw);

    console.log(`[DONE] ${providers.length} providers for ZIP ${zip}`);

    return res.json({
      zip,
      city:      coords.city,
      county:    coords.county,
      state:     coords.state,
      stateName: coords.stateName,
      lat:       coords.lat,
      lon:       coords.lon,
      providers,
      summary: buildSummary(providers),
      meta: {
        source:      'fcc_api',
        raw_records: raw.length,
        deduped:     providers.length,
        fetched_at:  new Date().toISOString(),
      },
    });

  } catch (err) {
    console.error('[FCC ERROR]', err.message);
    const status = err.message.includes('not found') ? 404 : 502;
    return res.status(status).json({ error: err.message });
  }
};

module.exports = { lookup };
