/**
 * fcc.controller.js
 * Uses FCC National Broadband Map Area API - server friendly
 */

const TECH_MAP = {
  10: 'DSL', 11: 'DSL', 12: 'VDSL',
  40: 'Cable', 41: 'Cable', 42: 'Cable', 43: 'Cable',
  50: 'Fiber',
  60: 'Satellite', 61: 'Satellite', 62: 'Satellite',
  70: 'Fixed Wireless', 71: 'Fixed Wireless', 72: 'Fixed Wireless',
  300: 'Licensed Fixed Wireless',
  400: 'Fixed Wireless',
};

function techLabel(code) {
  const n = parseInt(code, 10);
  if (TECH_MAP[n]) return TECH_MAP[n];
  if (n >= 200) return 'Satellite';
  return 'Other';
}

function normalise(records) {
  const seen = {};
  for (const r of records) {
    const tech  = techLabel(r.technology ?? r.tech_type ?? '');
    const brand = (r.brand_name ?? r.provider_name ?? r.holding_company ?? '').trim();
    if (!brand) continue;

    const dl  = parseInt(r.max_advertised_download_speed ?? r.max_dl_speed ?? 0) || 0;
    const ul  = parseInt(r.max_advertised_upload_speed   ?? r.max_ul_speed ?? 0) || 0;
    const key = brand.toLowerCase() + '|' + tech;

    if (!seen[key] || dl > seen[key].dl) {
      seen[key] = { brand, tech, dl, ul };
    }
  }
  return Object.values(seen).sort((a, b) => b.dl - a.dl || a.brand.localeCompare(b.brand));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function zipToCoords(zip) {
  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?postalcode=${zip}&country=US&format=json&limit=1&addressdetails=1`;

  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'telnova-api/1.0',
      'Accept-Language': 'en-US,en',
    },
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

/**
 * Try multiple FCC-adjacent APIs that don't require browser context
 */
async function fetchProviders(lat, lon, zip, state) {
  const attempts = [

    // ── Attempt 1: FCC Open Data API (developer.fcc.gov) ──────────────────
    async () => {
      const url = `https://developer.fcc.gov/api/block/find?latitude=${lat}&longitude=${lon}&format=json&showall=true`;
      console.log('  [1] Trying FCC developer block API...');
      const res = await fetchWithTimeout(url, {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Returns block FIPS — use to query broadband
      const block = data?.Block?.FIPS;
      if (!block) throw new Error('No block FIPS returned');

      // Now query broadband by block
      const bbUrl = `https://broadbandmap.fcc.gov/api/public/map/listAvailability?block_fips=${block}&category=Residential`;
      const bbRes = await fetchWithTimeout(bbUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://broadbandmap.fcc.gov/',
        }
      });
      if (!bbRes.ok) throw new Error(`Broadband HTTP ${bbRes.status}`);
      const bbData = await bbRes.json();
      const avail = bbData?.output?.availability ?? bbData?.availability ?? (Array.isArray(bbData) ? bbData : null);
      if (!Array.isArray(avail)) throw new Error('No availability array');
      return avail;
    },

    // ── Attempt 2: OpenFCC API ─────────────────────────────────────────────
    async () => {
      console.log('  [2] Trying OpenFCC API...');
      const url = `https://opendata.fcc.gov/api/odata/v4/mf2022_providers_by_postal_code?$filter=postal_code eq '${zip}'&$select=provider_id,brand_name,technology,max_advertised_download_speed,max_advertised_upload_speed&$top=100`;
      const res = await fetchWithTimeout(url, {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const records = data?.value ?? data?.results ?? (Array.isArray(data) ? data : null);
      if (!Array.isArray(records) || records.length === 0) throw new Error('No records');
      return records;
    },

    // ── Attempt 3: FCC OData - 2023 dataset ───────────────────────────────
    async () => {
      console.log('  [3] Trying FCC OData 2023 dataset...');
      const url = `https://opendata.fcc.gov/api/odata/v4/mf2023_providers_by_postal_code?$filter=postal_code eq '${zip}'&$select=brand_name,technology,max_advertised_download_speed,max_advertised_upload_speed&$top=100`;
      const res = await fetchWithTimeout(url, {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const records = data?.value ?? (Array.isArray(data) ? data : null);
      if (!Array.isArray(records) || records.length === 0) throw new Error('No records');
      return records;
    },

    // ── Attempt 4: Socrata FCC Open Data ──────────────────────────────────
    async () => {
      console.log('  [4] Trying Socrata FCC dataset...');
      const url = `https://opendata.fcc.gov/resource/hicn-aujz.json?zip_code=${zip}&$limit=100`;
      const res = await fetchWithTimeout(url, {
        headers: { 'Accept': 'application/json' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) throw new Error('No records');
      return data;
    },
  ];

  const errors = [];
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      console.log(`  ✓ Got ${result.length} records`);
      return result;
    } catch (err) {
      console.warn(`  ✗ Failed: ${err.message}`);
      errors.push(err.message);
    }
  }

  throw new Error('All provider sources failed:\n' + errors.map(e => '  • ' + e).join('\n'));
}

const lookup = async (req, res) => {
  const zip = (req.query.zip || '').trim().padStart(5, '0');

  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'Invalid ZIP code. Must be 5 digits.' });
  }

  console.log(`\n[FCC LOOKUP] ZIP=${zip}`);

  try {
    const coords    = await zipToCoords(zip);
    const raw       = await fetchProviders(coords.lat, coords.lon, zip, coords.state);
    const providers = normalise(raw);

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