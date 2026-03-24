/**
 * TAI → Monday.com Real-Time Loss Tracker
 * =========================================
 * Receives ShipmentStatusUpdate webhooks from TAI TMS.
 * When a carrier is committed at a rate higher than the customer quote,
 * a loss item is automatically created on the Monday.com BDR Loss Log board.
 *
 * SETUP:
 *   1. npm install express axios dotenv
 *   2. cp .env.example .env  →  fill in your values
 *   3. node tai_loss_tracker.js
 *   4. Expose publicly (ngrok for testing, or deploy to a server)
 *   5. Register your public URL in TAI under: ShipmentStatusUpdateURL
 *
 * REGISTER IN TAI:
 *   URL to register: https://your-domain.com/webhook/shipment-status
 */

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');

const app = express();
app.use(express.json());

// ─── CONFIGURATION ────────────────────────────────────────────────────────────

const CONFIG = {
  port: process.env.PORT || 3000,

  monday: {
    apiToken:  process.env.MONDAY_API_TOKEN,   // Monday.com Admin → API → copy token
    apiUrl:    'https://api.monday.com/v2',
    boardId:   '18403656203',                  // BDR Loss Log board

    // Group to place new loss items in
    pendingGroupId: 'group_mm1c80tw',          // "🔴 Pending — Needs BDR Log"

    // Column IDs (set during board creation)
    col: {
      loadId:       'text_mm1cawhs',
      bdrOwner:     'multiple_person_mm1cnaz',
      lossDate:     'date_mm1csqag',
      customer:     'text_mm1cvx5g',
      origin:       'text_mm1c36gd',
      destination:  'text_mm1c9ntm',
      quotedRate:   'numeric_mm1c43t3',
      carrierCost:  'numeric_mm1c1yxq',
      lossAmount:   'numeric_mm1cbayn',
      lossMargin:   'numeric_mm1c7cxn',
      status:       'color_mm1cs6ya',
    }
  },

  // ── BDR MAPPING ──────────────────────────────────────────────────────────────
  // Map TAI rep names (exactly as they appear in TAI) → Monday.com user IDs.
  // Monday.com user IDs are listed below from your account for easy reference.
  //
  //  Brandon Hogan      → 31498272
  //  Matt Newcomb       → 31498319
  //  Derek Reft         → 31498273
  //  Jordan Reber       → 31282448
  //  Tricia Hopkins     → 46260568
  //  Kurt Branagan      → 31498322
  //  Jaime Mike         → 49767240
  //  Caitlin Wass       → 33210620
  //  Jarret Czartoryski → 46303750
  //  Erica Gomez        → 54691429
  //
  // ACTION REQUIRED: Replace the keys with the exact rep name strings from TAI.
  bdrMap: {
    'Brandon Hogan':      '31498272',
    'Matt Newcomb':       '31498319',
    'Derek Reft':         '31498273',
    'Jordan Reber':       '31282448',
    'Tricia Hopkins':     '46260568',
    'Kurt Branagan':      '31498322',
    'Jaime Mike':         '49767240',
    'Caitlin Wass':       '33210620',
    'Jarret Czartoryski': '46303750',
    'Erica Gomez':        '54691429',
    // Additional BDRs
    'Billy Depaul':       '57883376',  // William Henry DePaul
    'Josh Gatchell':      '35341325',  // Lead Account Manager
    'Cole Bogozi':        '57882425',
    'Javier Morejon':     '70578421',
  },

  // ── LOSS TRIGGER STATUSES ────────────────────────────────────────────────────
  // Confirmed TAI status that indicates a carrier has been committed to the load.
  triggerStatuses: [
    'Dispatched',
  ],

  // Minimum loss in dollars before creating a Monday.com item.
  // Prevents noise from tiny rounding differences. Set to 0 to log everything.
  minLossThreshold: 1.00,

  // ── OFFICE WHITELIST ─────────────────────────────────────────────────────────
  // Managed via the "TAI Office Whitelist" board in Monday.com (ID below).
  // Add/remove offices directly in Monday.com — no code changes needed.
  // The script loads the whitelist at startup and refreshes every 5 minutes.
  officeWhitelistBoardId: '18403670401',
  officeWhitelistRefreshMinutes: 5,
};

// ─── DEDUPLICATION ────────────────────────────────────────────────────────────
// Prevents duplicate Monday.com items if TAI fires the same webhook multiple times.
// Uses a local JSON file. For production with high volume, swap for a database.

const DEDUP_FILE = './processed_loads.json';

function getProcessed() {
  try { return JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8')); }
  catch { return {}; }
}

function markProcessed(loadId) {
  const data = getProcessed();
  data[loadId] = new Date().toISOString();
  fs.writeFileSync(DEDUP_FILE, JSON.stringify(data, null, 2));
}

function alreadyProcessed(loadId) {
  return !!getProcessed()[loadId];
}

// --- OFFICE WHITELIST --------------------------------------------------------
// The whitelist of allowed internal office IDs is loaded from the
// "TAI Office Whitelist" Monday.com board and refreshed every N minutes.
// To add/remove an office, just edit that board — no code changes needed.

let officeWhitelist    = new Set();  // populated by loadOfficeWhitelist()
let whitelistLoadedAt  = null;

async function loadOfficeWhitelist() {
  const query = `
    query {
      boards(ids: [${CONFIG.officeWhitelistBoardId}]) {
        items_page(limit: 200) {
          items {
            name
            column_values(ids: ["numeric_mm1cnx6f", "color_mm1cjcjq"]) {
              id
              text
            }
          }
        }
      }
    }
  `;

  const res = await axios.post(
    CONFIG.monday.apiUrl,
    { query },
    { headers: { Authorization: CONFIG.monday.apiToken, 'Content-Type': 'application/json', 'API-Version': '2024-01' } }
  );

  const items = res.data?.data?.boards?.[0]?.items_page?.items || [];
  const newWhitelist = new Set();

  for (const item of items) {
    const idCol     = item.column_values.find(c => c.id === 'numeric_mm1cnx6f');
    const statusCol = item.column_values.find(c => c.id === 'color_mm1cjcjq');
    const officeId  = parseFloat(idCol?.text);
    const isActive  = statusCol?.text?.toLowerCase() === 'active';

    if (officeId && isActive) {
      newWhitelist.add(officeId);
    }
  }

  officeWhitelist   = newWhitelist;
  whitelistLoadedAt = Date.now();
  console.log(`📋 Office whitelist refreshed — ${officeWhitelist.size} active office(s): [${[...officeWhitelist].join(', ')}]`);
}

async function ensureWhitelistFresh() {
  const maxAgeMs = CONFIG.officeWhitelistRefreshMinutes * 60 * 1000;
  if (!whitelistLoadedAt || (Date.now() - whitelistLoadedAt) > maxAgeMs) {
    await loadOfficeWhitelist();
  }
}

function isInternalOffice(customer) {
  // If whitelist is empty (not yet configured), allow all offices through
  // so the integration doesn't silently block everything on first deploy
  if (officeWhitelist.size === 0) {
    console.warn('⚠️  Office whitelist is empty — add offices to the TAI Office Whitelist board in Monday.com');
    return true;
  }
  return officeWhitelist.has(customer?.officeOrganizationId);
}

// --- BDR EXTRACTION ----------------------------------------------------------
// salesRepNames is a comma-separated string that may contain multiple people,
// e.g. "Jane Smith - Account Manager, Brandon Hogan - BDR, Tom Lee - Ops"
// We extract the single entry that ends with "- BDR".

function extractBDR(salesRepNames) {
  if (!salesRepNames) return '';
  const names = salesRepNames.split(',').map(n => n.trim());
  const bdr = names.find(n => n.toLowerCase().endsWith('- bdr'));
  if (!bdr) return '';
  // Strip the " - BDR" suffix to get just the person's name for mapping
  return bdr.replace(/\s*-\s*bdr\s*$/i, '').trim();
}

function getBDRUserId(repName) {
  if (!repName) return null;
  // Case-insensitive lookup so TAI name casing never causes a miss
  const lower = repName.toLowerCase();
  const match = Object.keys(CONFIG.bdrMap).find(k => k.toLowerCase() === lower);
  return match ? CONFIG.bdrMap[match] : null;
}

// --- PARSE TAI PAYLOAD -------------------------------------------------------
// Field names confirmed from TAI Public API swagger documentation.
//
// TAI ShipmentStatusUpdate payload structure (confirmed):
//   shipmentId                  -> unique load identifier
//   totalSell                   -> customer quoted rate (sell rate)
//   totalBuy                    -> total carrier cost (buy rate)
//   status                      -> current shipment status string
//   customer.salesRepNames      -> assigned BDR/rep name(s)
//   customer.name               -> customer name
//   stops[]                     -> array of stops; stopType "First Pickup" = origin,
//                                  "Final Delivery" = destination
//   carrierList[0].name         -> name of the committed carrier

function parsePayload(body) {
  const stops      = body.stops || [];
  const originStop = stops.find(s => s.stopType === 'First Pickup')   || stops[0]               || {};
  const destStop   = stops.find(s => s.stopType === 'Final Delivery') || stops[stops.length - 1] || {};
  const carrier    = (body.carrierList || [])[0] || {};

  return {
    loadId:      body.shipmentId               || null,
    status:      body.status                   || '',
    repName:     extractBDR(body.customer?.salesRepNames),
    customer:    body.customer?.name           || '',
    sellRate:    parseFloat(body.totalSell     || 0),
    buyRate:     parseFloat(body.totalBuy      || 0),
    originCity:  originStop.city               || '',
    originState: originStop.state              || '',
    destCity:    destStop.city                 || '',
    destState:   destStop.state                || '',
    carrierName: carrier.name                  || '',
  };
}

// ─── CREATE MONDAY.COM ITEM ───────────────────────────────────────────────────

async function createLossItem(fields, lossAmount, lossMargin) {
  const mondayUserId = getBDRUserId(fields.repName);
  const today        = new Date().toISOString().split('T')[0];
  const origin       = [fields.originCity, fields.originState].filter(Boolean).join(', ');
  const destination  = [fields.destCity,   fields.destState  ].filter(Boolean).join(', ');
  const itemName     = `Load #${fields.loadId}  |  ${origin} → ${destination}  |  -$${lossAmount.toFixed(2)}`;

  const colValues = {
    [CONFIG.monday.col.loadId]:      String(fields.loadId),
    [CONFIG.monday.col.lossDate]:    { date: today },
    [CONFIG.monday.col.customer]:    fields.customer,
    [CONFIG.monday.col.origin]:      origin,
    [CONFIG.monday.col.destination]: destination,
    [CONFIG.monday.col.quotedRate]:  String(fields.sellRate),
    [CONFIG.monday.col.carrierCost]: String(fields.buyRate),
    [CONFIG.monday.col.lossAmount]:  String(lossAmount.toFixed(2)),
    [CONFIG.monday.col.lossMargin]:  String(lossMargin.toFixed(1)),
    [CONFIG.monday.col.status]:      { label: 'Pending BDR Log' },
  };

  if (mondayUserId) {
    colValues[CONFIG.monday.col.bdrOwner] = {
      personsAndTeams: [{ id: parseInt(mondayUserId), kind: 'person' }]
    };
  } else if (fields.repName) {
    console.warn(`⚠️  No Monday.com mapping found for TAI rep: "${fields.repName}" — item will be unassigned`);
  }

  const mutation = `
    mutation {
      create_item(
        board_id: ${CONFIG.monday.boardId},
        group_id: "${CONFIG.monday.pendingGroupId}",
        item_name: ${JSON.stringify(itemName)},
        column_values: ${JSON.stringify(JSON.stringify(colValues))}
      ) { id name }
    }
  `;

  const res = await axios.post(
    CONFIG.monday.apiUrl,
    { query: mutation },
    {
      headers: {
        Authorization: CONFIG.monday.apiToken,
        'Content-Type': 'application/json',
        'API-Version':  '2024-01',
      }
    }
  );

  if (res.data.errors) {
    throw new Error(JSON.stringify(res.data.errors));
  }

  return res.data.data.create_item;
}

// ─── WEBHOOK ENDPOINT ─────────────────────────────────────────────────────────

app.post('/webhook/shipment-status', async (req, res) => {
  // Always respond 200 immediately so TAI doesn't retry
  res.status(200).json({ received: true });

  const raw = req.body;
  console.log('\n📨 ShipmentStatusUpdate received:', new Date().toLocaleTimeString());

  try {
    const fields = parsePayload(raw);

    // ── Guard: must have a load ID
    if (!fields.loadId) {
      console.log('⏭  Skipped: no load ID in payload');
      return;
    }

    // ── Refresh whitelist if stale
    await ensureWhitelistFresh();

    // ── Guard: must be an internal office (not an agency/outside office)
    if (!isInternalOffice(raw.customer)) {
      const office = raw.customer?.officeName || raw.customer?.officeOrganizationId || 'unknown';
      console.log(`⏭  Load ${fields.loadId}: office "${office}" is not an internal office — skipping`);
      return;
    }

    // ── Guard: status must be a carrier-commitment status
    const statusMatch = CONFIG.triggerStatuses.some(t =>
      fields.status.toLowerCase().includes(t.toLowerCase())
    );
    if (!statusMatch) {
      console.log(`⏭  Load ${fields.loadId}: status "${fields.status}" is not a loss trigger — skipping`);
      return;
    }

    // ── Guard: must have both rates
    if (!fields.sellRate || !fields.buyRate) {
      console.log(`⏭  Load ${fields.loadId}: missing rate data (sell: ${fields.sellRate}, buy: ${fields.buyRate})`);
      return;
    }

    // ── Guard: must be a loss above threshold
    const lossAmount = fields.buyRate - fields.sellRate;
    const lossMargin = (lossAmount / fields.sellRate) * 100;

    if (lossAmount < CONFIG.minLossThreshold) {
      console.log(`✅  Load ${fields.loadId}: profitable or below threshold ($${lossAmount.toFixed(2)}) — no action`);
      return;
    }

    // ── Guard: deduplication
    if (alreadyProcessed(fields.loadId)) {
      console.log(`⏭  Load ${fields.loadId}: already logged to Monday.com — skipping duplicate`);
      return;
    }

    // ── LOSS DETECTED → create Monday.com item
    console.log(`🚨 LOSS DETECTED — Load ${fields.loadId}`);
    console.log(`   Customer : ${fields.customer}`);
    console.log(`   Lane     : ${fields.originCity} → ${fields.destCity}`);
    console.log(`   BDR      : ${fields.repName || 'Unknown (no "- BDR" match in salesRepNames)'}`)
    console.log(`   Quoted   : $${fields.sellRate.toFixed(2)}`);
    console.log(`   Carrier  : $${fields.buyRate.toFixed(2)}`);
    console.log(`   Loss     : $${lossAmount.toFixed(2)} (${lossMargin.toFixed(1)}%)`);

    const item = await createLossItem(fields, lossAmount, lossMargin);
    markProcessed(fields.loadId);

    console.log(`✅ Monday.com item created: "${item.name}" (ID: ${item.id})`);

  } catch (err) {
    console.error('❌ Error processing webhook:', err.message);
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    service:   'TAI → Monday.com Loss Tracker',
    boardId:   CONFIG.monday.boardId,
    timestamp: new Date().toISOString(),
    tokenSet:  !!CONFIG.monday.apiToken,
  });
});

// ─── START ────────────────────────────────────────────────────────────────────

// Load the office whitelist from Monday.com before starting the server
loadOfficeWhitelist()
  .catch(err => console.warn('⚠️  Could not load office whitelist on startup:', err.message));

app.listen(CONFIG.port, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║       TAI → Monday.com Real-Time Loss Tracker         ║
╠═══════════════════════════════════════════════════════╣
║  Health:   GET  /health                               ║
║  Webhook:  POST /webhook/shipment-status              ║
╚═══════════════════════════════════════════════════════╝`);
  console.log(`\n🚀 Running on port ${CONFIG.port}`);
  if (!CONFIG.monday.apiToken) {
    console.warn('⚠️  MONDAY_API_TOKEN not set — set this in .env before going live');
  }
});
