// // /api/aggregate-vault.js
// // Vercel Serverless function - GET ?contactId=...
// const HUBSPOT_BASE = 'https://api.hubapi.com';
// const VAULT_OBJECT_TYPE = '2-48397499';        // Vault (keep your IDs)
// const VAULT_HOLDING_OBJECT_TYPE = '2-50210039'; // Vault Holding

// function jsonError(res, status, msg) {
//   res.setHeader('Content-Type', 'application/json');
//   return res.status(status).send(JSON.stringify({ error: msg }));
// }

// async function hubspotFetch(path, opts = {}) {
//   const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
//   if (!token) throw new Error('HUBSPOT_PRIVATE_APP_TOKEN not set in env');

//   const url = path.startsWith('http') ? path : `${HUBSPOT_BASE}${path}`;
//   const resp = await fetch(url, {
//     ...opts,
//     headers: {
//       Authorization: `Bearer ${token}`,
//       'Content-Type': 'application/json',
//       ...(opts.headers || {})
//     }
//   });
//   if (!resp.ok) {
//     const text = await resp.text();
//     throw new Error(`HubSpot API error ${resp.status}: ${text}`);
//   }
//   return resp.json();
// }

// // helper: get all pages for an endpoint that returns paging.next.after
// async function fetchAllPages(initialPath) {
//   let items = [];
//   let path = initialPath;
//   while (path) {
//     const data = await hubspotFetch(path);
//     items.push(...(data.results || []));
//     const next = data.paging && data.paging.next && data.paging.next.after;
//     if (next) {
//       // rebuild path with after param (keep existing limit if present)
//       const base = initialPath.split('?')[0];
//       path = `${base}?limit=100&after=${next}`;
//     } else {
//       path = null;
//     }
//   }
//   return items;
// }

// export default async function handler(req, res) {
//   // CORS preflight handling (HubSpot UI will preflight)
//   res.setHeader('Access-Control-Allow-Origin', '*'); // tighten to specific domain in prod
//   res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
//   res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
//   res.setHeader('Access-Control-Allow-Credentials', 'true');

//   if (req.method === 'OPTIONS') return res.status(204).end();

//   try {
//     const contactId = req.query.contactId || req.query.contact_id;
//     if (!contactId) return jsonError(res, 400, 'contactId query required');

//     // 1) Get vault IDs associated with contact (may page)
//     const assocPath = `/crm/v3/objects/contacts/${contactId}/associations/${VAULT_OBJECT_TYPE}?limit=100`;
//     const vaultAssoc = await fetchAllPages(assocPath);
//     const vaultIds = vaultAssoc.map(r => r.id);
//     if (!vaultIds.length) {
//       return res.status(200).json({ header: { goldOunces: 0, silverOunces: 0 }, items: [] });
//     }

//     // 2) For each vault, get associated holdings (may page)
//     let holdingIds = new Set();
//     for (const vId of vaultIds) {
//       const path = `/crm/v3/objects/${VAULT_OBJECT_TYPE}/${vId}/associations/${VAULT_HOLDING_OBJECT_TYPE}?limit=100`;
//       const assoc = await fetchAllPages(path);
//       assoc.forEach(r => holdingIds.add(r.id));
//     }
//     holdingIds = Array.from(holdingIds);
//     if (!holdingIds.length) {
//       return res.status(200).json({ header: { goldOunces: 0, silverOunces: 0 }, items: [] });
//     }

//     // 3) Batch read holdings properties in chunks of 100 (HubSpot batch/read max 100)
//     const PROPS = ['product_type','remaining_quantity','ounces_per_unit','metal_type'];
//     const chunk = (arr, n) => {
//       const out = [];
//       for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n));
//       return out;
//     };
//     let holdings = [];
//     const chunks = chunk(holdingIds, 100);
//     for (const c of chunks) {
//       const body = { inputs: c.map(id => ({ id })), properties: PROPS };
//       const r = await hubspotFetch(`/crm/v3/objects/${VAULT_HOLDING_OBJECT_TYPE}/batch/read`, {
//         method: 'POST',
//         body: JSON.stringify(body)
//       });
//       holdings.push(...(r.results || []));
//     }

//     // 4) Get allowed product_type options (so we can include missing ones as 0)
//     let productOptions = [];
//     try {
//       const propRes = await hubspotFetch(`/crm/v3/properties/${VAULT_HOLDING_OBJECT_TYPE}/product_type`);
//       productOptions = (propRes && propRes.options) ? propRes.options.map(o => o.label || o.value) : [];
//     } catch (err) {
//       // fallback: we'll infer types from holdings
//       productOptions = [];
//     }

//     // 5) Aggregate
//     const productMap = {};
//     for (const h of holdings) {
//       const p = h.properties || {};
//       const productType = (p.product_type || 'Unknown').trim();
//       const qty = parseFloat(p.remaining_quantity || 0) || 0;
//       const ouncesPerUnit = parseFloat(p.ounces_per_unit || 1) || 1;
//       const metalType = p.metal_type || '';

//       if (!productMap[productType]) productMap[productType] = { totalQty: 0, totalOunces: 0, metalType };
//       productMap[productType].totalQty += qty;
//       productMap[productType].totalOunces += qty * ouncesPerUnit;
//     }

//     // Ensure productOptions appear even if qty=0
//     for (const opt of productOptions) {
//       if (!productMap[opt]) productMap[opt] = { totalQty: 0, totalOunces: 0, metalType: '' };
//     }

//     // 6) Totals
//     let goldTotal = 0, silverTotal = 0;
//     Object.values(productMap).forEach(r => {
//       if ((r.metalType || '').toLowerCase() === 'gold') goldTotal += r.totalOunces;
//       if ((r.metalType || '').toLowerCase() === 'silver') silverTotal += r.totalOunces;
//     });

//     // cache headers (CDN-friendly). Adjust s-maxage as you like.
//     res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');

//     const items = Object.keys(productMap).map(k => ({
//       productType: k,
//       units: productMap[k].totalQty,
//       ounces: productMap[k].totalOunces,
//       metalType: productMap[k].metalType
//     }));

//     return res.status(200).json({ header: { goldOunces: goldTotal, silverOunces: silverTotal }, items });
//   } catch (err) {
//     console.error(err);
//     return jsonError(res, 500, err.message || 'server error');
//   }
// }




// /api/aggregate-vault.js
import fetch from 'node-fetch'; // if needed in Vercel Node.js

const HUBSPOT_BASE = 'https://api.hubapi.com';
const VAULT_OBJECT_TYPE = '2-48397499';
const VAULT_HOLDING_OBJECT_TYPE = '2-50210039';

function jsonError(res, status, msg) {
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json({ error: msg });
}

async function hubspotFetch(path, opts = {}) {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) throw new Error('HUBSPOT_PRIVATE_APP_TOKEN not set in env');

  const url = path.startsWith('http') ? path : `${HUBSPOT_BASE}${path}`;
  const resp = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HubSpot API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function fetchAllPages(initialPath) {
  let items = [];
  let path = initialPath;
  while (path) {
    const data = await hubspotFetch(path);
    items.push(...(data.results || []));
    const next = data.paging?.next?.after;
    path = next ? `${initialPath.split('?')[0]}?limit=100&after=${next}` : null;
  }
  return items;
}

export default async function handler(req, res) {
  // --- 1️⃣ CORS Headers ---
  const allowedOrigin = 'https://portal.eqrp.com'; // HubSpot domain
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  // Handle preflight OPTIONS
  if (req.method === 'OPTIONS') return res.status(204).end();

  // --- 2️⃣ Main logic ---
  try {
    const contactId = req.query.contactId || req.query.contact_id;
    if (!contactId) return jsonError(res, 400, 'contactId query required');

    // 2a) Get vault IDs associated with contact
    const assocPath = `/crm/v3/objects/contacts/${contactId}/associations/${VAULT_OBJECT_TYPE}?limit=100`;
    const vaultAssoc = await fetchAllPages(assocPath);
    const vaultIds = vaultAssoc.map(r => r.id);
    if (!vaultIds.length)
      return res.status(200).json({ header: { goldOunces: 0, silverOunces: 0 }, items: [] });

    // 2b) Get holdings
    let holdingIds = new Set();
    for (const vId of vaultIds) {
      const path = `/crm/v3/objects/${VAULT_OBJECT_TYPE}/${vId}/associations/${VAULT_HOLDING_OBJECT_TYPE}?limit=100`;
      const assoc = await fetchAllPages(path);
      assoc.forEach(r => holdingIds.add(r.id));
    }
    holdingIds = Array.from(holdingIds);
    if (!holdingIds.length)
      return res.status(200).json({ header: { goldOunces: 0, silverOunces: 0 }, items: [] });

    // 2c) Batch read holdings
    const PROPS = ['product_type','remaining_quantity','ounces_per_unit','metal_type'];
    const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i*n, i*n+n));
    let holdings = [];
    for (const c of chunk(holdingIds, 100)) {
      const body = { inputs: c.map(id => ({ id })), properties: PROPS };
      const r = await hubspotFetch(`/crm/v3/objects/${VAULT_HOLDING_OBJECT_TYPE}/batch/read`, { method: 'POST', body: JSON.stringify(body) });
      holdings.push(...(r.results || []));
    }

    // 2d) Aggregate
    const productMap = {};
    for (const h of holdings) {
      const p = h.properties || {};
      const productType = (p.product_type || 'Unknown').trim();
      const qty = parseFloat(p.remaining_quantity || 0);
      const ouncesPerUnit = parseFloat(p.ounces_per_unit || 1);
      const metalType = p.metal_type || '';
      if (!productMap[productType]) productMap[productType] = { totalQty: 0, totalOunces: 0, metalType };
      productMap[productType].totalQty += qty;
      productMap[productType].totalOunces += qty * ouncesPerUnit;
    }

    // 2e) Totals
    let goldTotal = 0, silverTotal = 0;
    Object.values(productMap).forEach(r => {
      if ((r.metalType || '').toLowerCase() === 'gold') goldTotal += r.totalOunces;
      if ((r.metalType || '').toLowerCase() === 'silver') silverTotal += r.totalOunces;
    });

    // 2f) Final items
    const items = Object.keys(productMap).map(k => ({
      productType: k,
      units: productMap[k].totalQty,
      ounces: productMap[k].totalOunces,
      metalType: productMap[k].metalType
    }));

    return res.status(200).json({ header: { goldOunces: goldTotal, silverOunces: silverTotal }, items });
  } catch (err) {
    console.error('[Vault API] Error:', err);
    return jsonError(res, 500, err.message || 'server error');
  }
}
