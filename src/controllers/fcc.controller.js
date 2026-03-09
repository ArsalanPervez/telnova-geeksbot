/**
 * fcc.controller.js
 *
 * Data resolution order for each lookup request:
 *   1. zip_providers table (DB) — populated via POST /api/fcc/upload
 *   2. FCC Broadband Map API    (fallback for ZIPs not yet in DB)
 *   3. FCC Open Data / Socrata  (final fallback)
 */

const response = require('../utils/apiResponse');
const prisma   = require('../config/prisma');

/* ─── HELPERS ────────────────────────────────────────────────────────────── */

const SVC_MAP = { R:'Residential', B:'Business', X:'Both' };

function normalise(records) {
  const seen = {};
  for (const r of records) {
    const techCode = r.technology ?? r.tech_type ?? r.tech ?? '';
    const n = parseInt(techCode, 10);
    const techMap = { 10:'DSL',11:'DSL',12:'VDSL',40:'Cable',41:'Cable',42:'Cable',43:'Cable',50:'Fiber',60:'Satellite',61:'Satellite',62:'Satellite',70:'Fixed Wireless',71:'Fixed Wireless',72:'Fixed Wireless',300:'Licensed Fixed Wireless',400:'Fixed Wireless' };
    const tech  = techMap[n] || (n >= 200 ? 'Satellite' : 'Other');
    const brand = (r.brand_name ?? r.provider_name ?? r.name ?? r.holding_company ?? '').trim();
    if (!brand) continue;

    const dl  = parseInt(r.max_advertised_download_speed ?? r.max_dl_speed ?? r.download_speed ?? 0) || 0;
    const ul  = parseInt(r.max_advertised_upload_speed   ?? r.max_ul_speed ?? r.upload_speed   ?? 0) || 0;
    const key = brand.toLowerCase() + '|' + tech;

    if (!seen[key] || dl > seen[key].dl) {
      seen[key] = { brand, tech, dl, ul, ll: r.low_latency === 1 || r.low_latency === true || r.low_latency === '1', svc: SVC_MAP[r.business_residential_code] ?? r.service_type ?? '' };
    }
  }
  return Object.values(seen).sort((a, b) => b.dl - a.dl || a.brand.localeCompare(b.brand));
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
    return response.error(res, 'Invalid ZIP code. Must be 5 digits.', 400);
  }

  console.log(`\n[FCC LOOKUP] ZIP=${zip}`);

  /* ── Strategy 1: zip_providers table (DB) ── */
  const rows = await prisma.zipProvider.findMany({ where: { zip } });

  if (rows.length > 0) {
    console.log(`[DB] ${rows.length} providers for ZIP ${zip}`);
    const providers = rows
      .map(r => ({ brand: r.brandName, tech: r.technology, dl: r.maxDlSpeed, ul: r.maxUlSpeed, ll: r.lowLatency, svc: r.serviceType }))
      .sort((a, b) => b.dl - a.dl || a.brand.localeCompare(b.brand));

    return response.success(res, 'Providers retrieved successfully', {
      zip,
      city:      rows[0].city,
      state:     rows[0].stateUsps,
      providers,
      summary:   buildSummary(providers),
      meta: { source: 'db', fetched_at: new Date().toISOString() },
    });
  }

  /* ── Strategy 2: FCC API fallback ── */
  try {
    console.log('[1/2] Resolving ZIP → coordinates …');
    const coords = await zipToCoords(zip);
    console.log(`  lat=${coords.lat}, lon=${coords.lon}, state=${coords.state}`);

    console.log('[2/2] Fetching from FCC API …');
    const raw       = await fetchProvidersFromAPI(coords.lat, coords.lon, zip, coords.state);
    const providers = normalise(raw);

    console.log(`[DONE] ${providers.length} providers for ZIP ${zip}`);

    return response.success(res, 'Providers retrieved successfully', {
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
    return response.error(res, err.message, status);
  }
};

module.exports = { lookup };
