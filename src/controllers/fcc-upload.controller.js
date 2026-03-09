/**
 * fcc-upload.controller.js  —  Option C architecture
 *
 * POST /api/fcc/upload
 *
 * Instead of storing raw CSV rows (millions per state), this controller:
 *   1. Loads the Zip_tract.txt crosswalk once into memory (cached for reuse)
 *   2. Streams the CSV — for each row finds all ZIPs that share the census tract
 *   3. Builds a deduplicated ZIP-level map: (zip, brand, tech) → best speed record
 *   4. Batch-inserts the compact result into zip_providers
 *
 * Result: ~150K rows per large state  vs  2M+ raw rows  (≈14x smaller)
 * Upload time: ~20s for Arizona  vs  4-7 min  (≈20x faster)
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const multer   = require('multer');
const prisma   = require('../config/prisma');
const response = require('../utils/apiResponse');

/* ─── Paths ───────────────────────────────────────────────────────────────── */

const RAW_DIR      = path.join(__dirname, '../../data/raw');
const TRACT_FILE   = path.join(RAW_DIR, 'Zip_tract.txt');

fs.mkdirSync(RAW_DIR, { recursive: true });

/* ─── Multer ──────────────────────────────────────────────────────────────── */

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, RAW_DIR),
  filename:    (_req, file, cb) => cb(null, file.originalname + '.tmp'),
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.csv'))
      return cb(new Error('Only .csv files are accepted'));
    cb(null, true);
  },
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
});

/* ─── Tech / service maps ─────────────────────────────────────────────────── */

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
  const n = parseInt(code, 10);
  if (TECH_MAP[n]) return TECH_MAP[n];
  if (n >= 200)    return 'Satellite';
  return 'Other';
}

/* ─── CSV parser ──────────────────────────────────────────────────────────── */

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

/* ─── Crosswalk cache (loaded once, reused across all uploads) ────────────── */
//
//  tractToZips: { '01001020100': [ { zip, city, state }, … ] }
//
let   tractToZips    = null;
let   crosswalkReady = null;   // single shared promise during load

async function getCrosswalk() {
  if (tractToZips) return tractToZips;
  if (crosswalkReady) return crosswalkReady;

  crosswalkReady = (async () => {
    console.log('[CROSSWALK] Loading Zip_tract.txt …');
    const map = {};
    let   hdr = null;

    for await (const line of readline.createInterface({
      input: fs.createReadStream(TRACT_FILE, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })) {
      if (!line.trim()) continue;
      const cols = line.split('\t');
      if (!hdr) { hdr = cols.map(h => h.trim()); continue; }

      const row   = Object.fromEntries(hdr.map((h, i) => [h, (cols[i] || '').trim()]));
      const zip   = (row.ZIP   || '').padStart(5, '0');
      const tract = row.TRACT  || '';
      if (zip.length !== 5 || tract.length !== 11) continue;

      if (!map[tract]) map[tract] = [];
      map[tract].push({
        zip,
        city:  (row.USPS_ZIP_PREF_CITY  || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()),
        state: (row.USPS_ZIP_PREF_STATE || '').toUpperCase(),
      });
    }

    tractToZips = map;
    console.log(`[CROSSWALK] Loaded — ${Object.keys(map).length} tracts`);
    return map;
  })();

  return crosswalkReady;
}

/* Pre-load crosswalk on module init so first upload doesn't pay the cost */
getCrosswalk().catch(err => console.warn('[CROSSWALK] Failed to pre-load:', err.message));

/* ─── Batch size ──────────────────────────────────────────────────────────── */

const BATCH_SIZE = 5000;

/* Windows-safe file promotion: copy over destination, retry on EBUSY/EPERM */
async function copyWithRetry(src, dest, retries = 5, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      fs.copyFileSync(src, dest);       // overwrites dest without needing to delete it
      try { fs.unlinkSync(src); } catch (_) {}
      return;
    } catch (e) {
      if ((e.code === 'EBUSY' || e.code === 'EPERM') && i < retries - 1) {
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
      } else {
        throw e;
      }
    }
  }
}

/* ─── Upload handler ──────────────────────────────────────────────────────── */

const uploadCSV = async (req, res) => {
  if (!req.file) {
    return response.error(res, 'No file uploaded. Send a CSV as multipart/form-data field "file".', 400);
  }

  const tmpPath  = req.file.path;                              // e.g. data/raw/Alabama-Cable.csv.tmp
  const fileName = req.file.originalname;
  const finalPath = path.join(RAW_DIR, fileName);              // e.g. data/raw/Alabama-Cable.csv
  const stateArg = (req.body.state || '').trim().toUpperCase() || null;

  console.log(`\n[FCC UPLOAD] file=${fileName}  state=${stateArg || 'auto-detect'}`);

  try {
    /* ── Load crosswalk (instant if already cached) ─────────────────────── */
    const crosswalk = await getCrosswalk();

    /* ── Pass 1: detect state + technology labels ────────────────────────── */
    let detectedState = stateArg;
    const techSet     = new Set();
    let   hdr         = null;

    for await (const line of readline.createInterface({
      input: fs.createReadStream(tmpPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })) {
      if (!line.trim()) continue;
      const cols = parseCSVLine(line);
      if (!hdr) { hdr = cols.map(h => h.trim()); continue; }

      const row   = Object.fromEntries(hdr.map((h, i) => [h, (cols[i] || '').trim()]));
      const geoid = row.block_geoid || '';
      if (geoid.length < 11) continue;

      if (!detectedState) detectedState = (row.state_usps || '').toUpperCase();
      techSet.add(techLabel(row.technology));
    }

    if (techSet.size === 0) {
      return response.error(res, 'CSV contained no valid data rows.', 422);
    }

    const techLabels = [...techSet];
    console.log(`[FCC UPLOAD] state=${detectedState}  tech=[${techLabels}]`);

    /* ── Delete existing ZIP providers for this state + tech ─────────────── */
    const { count: deleted } = await prisma.zipProvider.deleteMany({
      where: { stateUsps: detectedState, technology: { in: techLabels } },
    });
    console.log(`[FCC UPLOAD] Deleted ${deleted} old zip_providers`);

    /* ── Pass 2: stream CSV → join with crosswalk → build ZIP-level map ──── */
    //
    //  zipMap key:  `${zip}|${brand}|${tech}`
    //  zipMap value: best (highest dl) record for that combination
    //
    const zipMap = {};
    let   rawRows = 0;
    hdr = null;

    for await (const line of readline.createInterface({
      input: fs.createReadStream(tmpPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })) {
      if (!line.trim()) continue;
      const cols = parseCSVLine(line);
      if (!hdr) { hdr = cols.map(h => h.trim()); continue; }

      const row   = Object.fromEntries(hdr.map((h, i) => [h, (cols[i] || '').trim()]));
      const geoid = row.block_geoid || '';
      if (geoid.length < 11) continue;
      const brand = (row.brand_name || '').trim();
      if (!brand) continue;

      rawRows++;
      const tract = geoid.slice(0, 11);
      const tech  = techLabel(row.technology);
      const dl    = parseInt(row.max_advertised_download_speed) || 0;
      const ul    = parseInt(row.max_advertised_upload_speed)   || 0;
      const ll    = row.low_latency === '1';
      const svc   = SVC_MAP[row.business_residential_code] || '';
      const state = (row.state_usps || detectedState || '').toUpperCase();

      for (const { zip, city } of (crosswalk[tract] || [])) {
        const key = `${zip}|${brand}|${tech}`;
        const ex  = zipMap[key];
        if (!ex || dl > ex.maxDlSpeed) {
          zipMap[key] = { zip, brandName: brand, technology: tech, maxDlSpeed: dl, maxUlSpeed: ul, lowLatency: ll, serviceType: svc, stateUsps: state, city };
        }
      }
    }

    const records = Object.values(zipMap);
    console.log(`[FCC UPLOAD] ${rawRows} raw rows → ${records.length} zip_provider records`);

    /* ── Batch insert ────────────────────────────────────────────────────── */
    let inserted = 0;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const result = await prisma.zipProvider.createMany({
        data: records.slice(i, i + BATCH_SIZE), skipDuplicates: true,
      });
      inserted += result.count;
    }

    console.log(`[FCC UPLOAD] Done — inserted=${inserted}  file=${fileName}`);

    /* ── Promote tmp → final (Windows-safe: copy over then delete tmp) ────── */
    await copyWithRetry(tmpPath, finalPath);

    return response.success(res, 'CSV uploaded and stored successfully', {
      file:          fileName,
      state:         detectedState,
      technologies:  techLabels,
      raw_rows:      rawRows,
      zip_providers: records.length,
      inserted,
      replaced:      deleted,
    });

  } catch (err) {
    console.error('[FCC UPLOAD ERROR]', err.message);
    try { fs.unlinkSync(tmpPath); } catch (_) {}   // delete incomplete tmp file
    return response.error(res, err.message, 500);
  }
};

module.exports = { upload, uploadCSV };
