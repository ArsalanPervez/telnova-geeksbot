/**
 * fcc.controller.js
 * Uses FCC BDC public dataset API (no browser required)
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

async function fetchProviders(zip) {
  // Option 1: Census Bureau + FCC BDC summary API
  const url = `https://broadbandmap.fcc.gov/api/public/map/listAvailabilityCount?zip=${zip}`;

  // Option 2: Use the FCC dataset download API (returns CSV-style JSON)
  const bdcUrl = `https://broadbandmap.fcc.gov/api/public/map/availability/summary?zip=${zip}&category=Residential`;

  const headers = {
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin':          'https://broadbandmap.fcc.gov',
    'Referer':         'https://broadbandmap.fcc.gov/home',
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'sec-ch-ua':       '"Not_A Brand";v="8", "Chromium";v="120"',
    'sec-fetch-dest':  'empty',
    'sec-fetch-mode':  'cors',
    'sec-fetch-site':  'same-origin',
  };

  const res = await fetchWithTimeout(bdcUrl, { headers });

  if (!res.ok) throw new Error(`FCC BDC summary HTTP ${res.status}`);

  const data = await res.json();

  const avail =
    data?.output?.availability ??
    data?.availability ??
    data?.results ??
    data?.data ??
    (Array.isArray(data) ? data : null);

  if (!Array.isArray(avail)) {
    throw new Error(`Unexpected FCC response: ${JSON.stringify(data).slice(0, 200)}`);
  }

  return avail;
}

const lookup = async (req, res) => {
  const zip = (req.query.zip || '').trim().padStart(5, '0');

  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'Invalid ZIP code. Must be 5 digits.' });
  }

  console.log(`\n[FCC LOOKUP] ZIP=${zip}`);

  try {
    const coords    = await zipToCoords(zip);
    const raw       = await fetchProviders(zip);
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