# TAI → Monday.com Real-Time Loss Tracker

Automatically detects freight brokerage losses in real time by listening to TAI's
`ShipmentStatusUpdateURL` webhook and creating items on the Monday.com **BDR Loss Log** board.

---

## How It Works

1. A carrier is committed to a load in TAI (status changes to Dispatched, Covered, etc.)
2. TAI fires a `ShipmentStatusUpdate` webhook to this server
3. The server compares **Carrier Buy Rate vs. Customer Sell Rate**
4. If Buy Rate > Sell Rate, a new item is created on the Monday.com BDR Loss Log board
5. The responsible BDR gets notified and logs the loss reason in Monday.com

---

## Prerequisites

- Node.js v16 or higher
- A publicly accessible URL (for TAI to send webhooks to)
- Monday.com API token
- TAI webhook integration enabled (contact your TAI admin)

---

## Installation

```bash
# 1. Install dependencies
npm install express axios dotenv

# 2. Set up environment variables
cp .env.example .env
# Edit .env and add your MONDAY_API_TOKEN

# 3. Start the server
node tai_loss_tracker.js
```

---

## Exposing the Server Publicly

TAI needs to reach your server over the internet. Options:

**For testing (quick):**
```bash
npm install -g ngrok
ngrok http 3000
# Use the https://xxxx.ngrok.io URL as your TAI webhook URL
```

**For production:**
Deploy to any cloud server (AWS EC2, Azure VM, DigitalOcean Droplet, etc.)
and point your domain to it. Use HTTPS.

---

## Registering in TAI

1. Log into your TAI TMS
2. Navigate to: **Admin → Integrations → Webhook Setup**
   *(See: http://[your-tai-url]/PublicApi/swagger/index#/WebHooks)*
3. Set the **ShipmentStatusUpdateURL** to:
   ```
   https://your-domain.com/webhook/shipment-status
   ```
4. Save and test with a live shipment status change

---

## Configuration Checklist

Before going live, review these items in `tai_loss_tracker.js`:

### 1. Confirm Trigger Statuses
Update `triggerStatuses` in CONFIG to match exact TAI status names:
```javascript
triggerStatuses: [
  'Dispatched',     // ← confirm these match your TAI instance
  'Covered',
  'Booked',
  'Carrier Assigned',
  'In Transit',
],
```

### 3. Complete the BDR Mapping
Update `bdrMap` with the exact rep name strings as they appear in TAI:
```javascript
bdrMap: {
  'Brandon Hogan': '31498272',   // ← replace left side with exact TAI rep name
  'Matt Newcomb':  '31498319',
  // ... add all BDRs
},
```

---

## Verifying It Works

```bash
# 1. Check the server is running
curl http://localhost:3000/health

# 2. Send a test webhook payload
curl -X POST http://localhost:3000/webhook/shipment-status \
  -H "Content-Type: application/json" \
  -d '{
    "shipmentId": 10001,
    "status": "Dispatched",
    "totalSell": 2000,
    "totalBuy": 2400,
    "customer": {
      "name": "Test Customer",
      "salesRepNames": "Brandon Hogan"
    },
    "stops": [
      { "stopType": "First Pickup",   "city": "Chicago", "state": "IL" },
      { "stopType": "Final Delivery", "city": "Dallas",  "state": "TX" }
    ],
    "carrierList": [
      { "name": "Test Carrier LLC", "status": "Dispatched", "buy": 2400, "sell": 2000 }
    ]
  }'

# Expected: A new item appears in Monday.com BDR Loss Log board
# Expected console output:
#   🚨 LOSS DETECTED — Load TEST-001
#   ✅ Monday.com item created: "Load #TEST-001 | Chicago, IL → Dallas, TX | -$400.00"
```

---

## Files

| File | Purpose |
|---|---|
| `tai_loss_tracker.js` | Main server — webhook receiver and Monday.com integration |
| `.env` | Your private config (API token, port) — never commit this |
| `.env.example` | Template for .env |
| `processed_loads.json` | Auto-created deduplication log |

---

## Monday.com Board

**Board:** BDR Loss Log (ID: 18403656203)
**Workspace:** Company Store
**Direct link:** https://app.monday.com/boards/18403656203

Loss items are created in the **🔴 Pending — Needs BDR Log** group.
BDRs move items through the workflow by updating the Status column.
