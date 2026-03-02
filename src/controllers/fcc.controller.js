/**
 * fcc.controller.js
 *
 * Proxies requests to the FCC Broadband Map API.
 * Resolves a US ZIP code → lat/lon via Nominatim, then fetches provider data
 * from the FCC Broadband Data Collection API.
 */

/* ─── CONSTANTS ─────────────────────────────────────────────────────────── */

const TECH_MAP = {
  10: 'DSL',            11: 'DSL',            12: 'VDSL',
  40: 'Cable',          41: 'Cable',          42: 'Cable',          43: 'Cable',
  50: 'Fiber',
  60: 'Satellite',      61: 'Satellite',      62: 'Satellite',
  70: 'Fixed Wireless', 71: 'Fixed Wireless', 72: 'Fixed Wireless',
  300: 'Licensed Fixed Wireless',
  400: 'Fixed Wireless',
};

const SVC_MAP = { R: 'Residential', B: 'Business', X: 'Both' };

const FCC_ENDPOINTS = [
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

/* ─── HELPERS ────────────────────────────────────────────────────────────── */

function techLabel(code) {
  const n = parseInt(code, 10);
  if (TECH_MAP[n]) return TECH_MAP[n];
  if (n >= 200)    return 'Satellite';
  return 'Other';
}

/**
 * Deduplicate provider records.
 * Same provider + technology keeps only the highest download speed row.
 */
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
        brand,
        tech,
        dl,
        ul,
        ll:  r.low_latency === 1 || r.low_latency === true || r.low_latency === '1',
        svc: SVC_MAP[r.business_residential_code] ?? r.service_type ?? '',
      };
    }
  }

  return Object.values(seen).sort((a, b) => b.dl - a.dl || a.brand.localeCompare(b.brand));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/* ─── STEP 1 — ZIP → lat/lon + state code via Nominatim ─────────────────── */

async function zipToCoords(zip) {
  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?postalcode=${zip}&country=US&format=json&limit=1&addressdetails=1`;

  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent':      'bdc-proxy-api/1.0',
      'Accept-Language': 'en-US,en',
    },
  });

  if (!res.ok) throw new Error(`Nominatim error: HTTP ${res.status}`);

  const data = await res.json();
  if (!data.length) throw new Error(`ZIP code ${zip} not found in Nominatim.`);

  const item = data[0];
  const addr = item.address || {};

  const iso       = addr['ISO3166-2-lvl4'] || '';
  const stateCode = iso.includes('-') ? iso.split('-')[1] : '';

  return {
    lat:       parseFloat(item.lat),
    lon:       parseFloat(item.lon),
    city:      addr.city || addr.town || addr.village || addr.county || '',
    county:    addr.county || '',
    state:     stateCode,
    stateName: addr.state || '',
  };
}

/* ─── STEP 2 — lat/lon → FCC provider list ──────────────────────────────── */

async function fetchProviders(lat, lon, zip, state) {
  const errors = [];

  for (const ep of FCC_ENDPOINTS) {
    const url = ep.build(lat, lon, zip, state);
    console.log(`  [FCC] Trying ${ep.label} …`);

    try {
      const res = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; bdc-proxy/1.0)',
          'Referer':    'https://broadbandmap.fcc.gov/',
          'Accept':     'application/json',
        },
      });

      if (!res.ok) {
        const msg = `HTTP ${res.status}`;
        console.warn(`  [FCC] ${ep.label} → ${msg}`);
        errors.push(`${ep.label}: ${msg}`);
        continue;
      }

      const data = await res.json();

      if (data.status_code && data.status_code !== 200) {
        const msg = `FCC status ${data.status_code}: ${data.message || ''}`;
        console.warn(`  [FCC] ${ep.label} → ${msg}`);
        errors.push(`${ep.label}: ${msg}`);
        continue;
      }

      const avail =
        data?.output?.availability ??
        data?.availability         ??
        data?.output?.providers    ??
        data?.providers            ??
        data?.results              ??
        data?.data                 ??
        (Array.isArray(data) ? data : null);

      if (Array.isArray(avail)) {
        console.log(`  [FCC] ✓ ${ep.label} — ${avail.length} raw records`);
        return avail;
      }

      const msg = `200 OK but no provider array (keys: ${Object.keys(data).join(', ')})`;
      console.warn(`  [FCC] ${ep.label} → ${msg}`);
      errors.push(`${ep.label}: ${msg}`);

    } catch (err) {
      console.warn(`  [FCC] ${ep.label} threw: ${err.message}`);
      errors.push(`${ep.label}: ${err.message}`);
    }
  }

  throw new Error('All FCC endpoints failed:\n' + errors.map(e => '  • ' + e).join('\n'));
}

/* ─── ROUTE HANDLERS ─────────────────────────────────────────────────────── */

/**
 * GET /api/fcc/lookup?zip=35801
 * Returns ISP provider data for the given US ZIP code.
 */
const lookup = async (req, res) => {
  const zip = (req.query.zip || '').trim().padStart(5, '0');

  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'Invalid ZIP code. Must be 5 digits.' });
  }

  console.log(`\n[FCC LOOKUP] ZIP=${zip}`);

  try {
    console.log('[1/2] Resolving ZIP → coordinates …');
    const coords = await zipToCoords(zip);
    console.log(`  lat=${coords.lat}, lon=${coords.lon}, state=${coords.state}`);

    console.log('[2/2] Fetching FCC providers …');
    const raw       = await fetchProviders(coords.lat, coords.lon, zip, coords.state);
    const providers = normalise(raw);

    console.log(`[DONE] ${providers.length} unique providers for ZIP ${zip}`);

    return res.json({
      zip,
      city:      coords.city,
      county:    coords.county,
      state:     coords.state,
      stateName: coords.stateName,
      lat:       coords.lat,
      lon:       coords.lon,
      providers,
      meta: {
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
