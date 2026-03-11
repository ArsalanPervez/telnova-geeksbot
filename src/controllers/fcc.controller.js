const response = require('../utils/apiResponse');
const prisma   = require('../config/prisma');

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

/* ═══════════════════════════════════════════════════════════════════════════
   ROUTE HANDLER — GET /api/fcc/lookup?zip=35801
═══════════════════════════════════════════════════════════════════════════ */

const lookup = async (req, res) => {
  const zip = (req.query.zip || '').trim().padStart(5, '0');

  if (!/^\d{5}$/.test(zip)) {
    return response.error(res, 'Invalid ZIP code. Must be 5 digits.', 400);
  }

  console.log(`\n[FCC LOOKUP] ZIP=${zip}`);

  const rows = await prisma.zipProvider.findMany({ where: { zip } });

  if (rows.length === 0) {
    return response.error(res, `No providers found for ZIP ${zip}.`, 404);
  }

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
};

module.exports = { lookup };
