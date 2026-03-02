#!/usr/bin/env node
/**
 * scripts/preprocess-fcc.js
 *
 * Node.js port of preprocess.py
 *
 * Reads:
 *   data/raw/Zip_tract.txt                              (ZIP → census tract crosswalk)
 *   data/raw/<state>-<tech>_fixed_broadband_*.csv       (FCC BDC data files)
 *
 * Outputs:
 *   src/data/providers.json                             (loaded by fcc.controller.js)
 *
 * Usage:
 *   node scripts/preprocess-fcc.js
 *   npm run fcc:preprocess
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const RAW_DIR     = path.join(__dirname, '../data/raw');
const OUTPUT_PATH = path.join(__dirname, '../src/data/providers.json');

/* ── Add more CSV files here as you download more state data ── */
const CSV_FILES = [
  'Alabama-Cable_fixed_broadband_J25_17feb2026.csv',
  'Alabama-FibertothePremises_fixed_broadband_J25_17feb2026.csv',
];

/* ─── TECH / SERVICE MAPS (mirrors fcc.controller.js) ──────────────────── */

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

function techLabel(code) {
  const c = parseInt(code, 10);
  if (isNaN(c)) return 'Other';
  if (TECH_MAP[c]) return TECH_MAP[c];
  if (c >= 200) return 'Satellite';
  return 'Other';
}

function fmt(n) { return Number(n).toLocaleString(); }

/* ─── HELPERS ────────────────────────────────────────────────────────────── */

/** Parse one CSV line, respecting double-quoted fields */
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

/** Stream a file line-by-line */
function streamLines(filePath, onLine) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line',  onLine);
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

/* ─── MAIN ───────────────────────────────────────────────────────────────── */

async function main() {
  console.log('='.repeat(60));
  console.log('  FCC BDC Preprocessor');
  console.log('='.repeat(60));
  console.log();

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

  const t0 = Date.now();

  /* ── STEP 1: ZIP → census tract crosswalk ───────────────────────────── */
  console.log('[1/3] Loading ZIP-tract crosswalk …');

  const TRACT_FILE = path.join(RAW_DIR, 'Zip_tract.txt');
  if (!fs.existsSync(TRACT_FILE)) {
    console.error(`  ERROR: ${TRACT_FILE} not found.`);
    console.error('  Copy Zip_tract.txt into data/raw/');
    process.exit(1);
  }

  const zipTracts = {};  // zip → Set<tract11>
  const zipMeta   = {};  // zip → { city, state }
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
        city:  (row.USPS_ZIP_PREF_CITY  || '').trim()
                .toLowerCase().replace(/\b\w/g, c => c.toUpperCase()),
        state: (row.USPS_ZIP_PREF_STATE || '').trim().toUpperCase(),
      };
    }
    zipTracts[z].add(t);
  });

  const totalTracts = Object.values(zipTracts).reduce((s, v) => s + v.size, 0);
  console.log(`  ✓ ${fmt(Object.keys(zipTracts).length)} ZIP codes, ${fmt(totalTracts)} tract mappings  [${((Date.now()-t0)/1000).toFixed(1)}s]`);

  /* ── STEP 2: BDC CSV files → tract index ───────────────────────────── */
  console.log();
  console.log('[2/3] Loading BDC CSV files …');

  const tractIndex = {};  // tract11 → { key → best record }
  let totalRows = 0, loadedFiles = 0;

  for (const fname of CSV_FILES) {
    const fpath = path.join(RAW_DIR, fname);
    if (!fs.existsSync(fpath)) {
      console.log(`  ⚠  Skipping (not found): ${fname}`);
      continue;
    }

    const sizeMB = (fs.statSync(fpath).size / 1_048_576).toFixed(0);
    process.stdout.write(`  → ${fname}  (${sizeMB} MB) … `);
    const t1 = Date.now();
    let count = 0, csvHdr = null;

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
      count++;
    });

    totalRows += count;
    loadedFiles++;
    console.log(`${fmt(count)} rows  [${((Date.now()-t1)/1000).toFixed(1)}s]`);
  }

  console.log(`  ✓ ${fmt(totalRows)} total rows from ${loadedFiles} file(s)`);
  console.log(`    ${fmt(Object.keys(tractIndex).length)} unique census tracts indexed`);

  /* ── STEP 3: Build ZIP → providers index ────────────────────────────── */
  console.log();
  console.log('[3/3] Building ZIP → providers index …');
  const t2 = Date.now();

  const zipProviders = {};
  let zipsWithData = 0;

  for (const [zip, tracts] of Object.entries(zipTracts)) {
    const merged = {};
    for (const tract of tracts) {
      for (const [key, rec] of Object.entries(tractIndex[tract] || {})) {
        if (!merged[key] || rec.dl > merged[key].dl) merged[key] = rec;
      }
    }
    if (Object.keys(merged).length === 0) continue;

    zipProviders[zip] = {
      city:  zipMeta[zip].city,
      state: zipMeta[zip].state,
      providers: Object.values(merged).sort((a, b) => b.dl - a.dl || a.brand.localeCompare(b.brand)),
    };
    zipsWithData++;
  }

  console.log(`  ✓ ${fmt(zipsWithData)} ZIPs with provider data  [${((Date.now()-t2)/1000).toFixed(1)}s]`);

  /* ── Write JSON ─────────────────────────────────────────────────────── */
  console.log();
  console.log(`Writing ${OUTPUT_PATH} …`);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(zipProviders));
  console.log(`  ✓ Done!  (${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(0)} KB)`);
  console.log();
  console.log(`Total time: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log();
  console.log('Commit src/data/providers.json and redeploy.');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
