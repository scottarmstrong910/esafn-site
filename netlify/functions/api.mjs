import { getStore } from "@netlify/blobs";

/* ============================================================
   ESAFN shared state API
   Single blob holds the authoritative fuel state for all sites.
   Writes use compare-and-swap on the blob ETag so two devices
   recording at the same moment cannot clobber each other.
   ============================================================ */

const KEY = "state-v1";
const LOW_FUEL_THRESHOLD = 1000;
const MAX_RETRIES = 8;

const store = () => getStore({ name: "esafn", consistency: "strong" });

/* ---- Sites -------------------------------------------------
   Override in Netlify env var ESAFN_SITES as JSON if you add bases.
   ----------------------------------------------------------- */
const DEFAULT_SITES = [
  { id: 1, name: "Portland Base",       icao: "EGDP", region: "Dorset",   quantity: 3000, maxCapacity: 3000,
    status: "serviceable", fuelGrade: "Jet A-1", tankSerial: "", phone: "07483 486357",
    email: "dorsetpilot@gamaaviation.com", alertPhone: "07483486357" },
  { id: 2, name: "Henstridge Airfield", icao: "EGHS", region: "Somerset", quantity: 3000, maxCapacity: 3000,
    status: "serviceable", fuelGrade: "Jet A-1", tankSerial: "", phone: "07483 486357",
    email: "dorsetpilot@gamaaviation.com", alertPhone: "07483486357" }
];

function siteDefs() {
  if (process.env.ESAFN_SITES) {
    try { return JSON.parse(process.env.ESAFN_SITES); } catch { /* fall through */ }
  }
  return DEFAULT_SITES;
}

/* ---- Access codes ------------------------------------------
   Netlify env var ESAFN_CODES, format: CODE:UNIT:BASEID,CODE:UNIT:
   Kept server-side so codes are not readable in page source.
   ----------------------------------------------------------- */
function unitCodes() {
  const raw = process.env.ESAFN_CODES ||
    "1234:DSAA:2,5678:HIOWAA:,9012:KSSAA:,3456:GWAAC:,7890:NPAS:";
  const map = {};
  raw.split(",").forEach(part => {
    const [code, unit, base] = part.split(":");
    if (code && unit) {
      map[code.trim()] = { unit: unit.trim(), base: base && base.trim() ? parseInt(base.trim(), 10) : null };
    }
  });
  return map;
}

function auth(code) {
  if (!code) return null;
  return unitCodes()[String(code).trim()] || null;
}

/* ---- Time --------------------------------------------------
   Server-generated so records are consistent regardless of
   device clock settings.
   ----------------------------------------------------------- */
const pad = n => String(n).padStart(2, "0");
function nowParts() {
  const n = new Date();
  const date = `${pad(n.getUTCDate())}/${pad(n.getUTCMonth() + 1)}/${n.getUTCFullYear()}`;
  const time = `${pad(n.getUTCHours())}:${pad(n.getUTCMinutes())}`;
  return { date, time, datetime: `${date} ${time}Z`, iso: n.toISOString() };
}

/* ---- State -------------------------------------------------- */
function seedState() {
  const st = { sites: {}, logs: {}, seq: 0 };
  siteDefs().forEach(d => {
    st.sites[d.id] = { ...d };
    st.logs[d.id] = { uplift: [], replen: [], fuelchk: [] };
  });
  return st;
}

async function readState() {
  const s = store();
  const res = await s.getWithMetadata(KEY, { type: "json", consistency: "strong" });
  if (res && res.data) return { data: res.data, etag: res.etag };

  await s.setJSON(KEY, seedState(), { onlyIfNew: true });
  const again = await s.getWithMetadata(KEY, { type: "json", consistency: "strong" });
  return { data: again.data, etag: again.etag };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * apply(state) -> { error } | { state }
 * Re-reads and re-applies on ETag conflict so concurrent writes serialise.
 */
async function mutate(apply) {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const { data, etag } = await readState();
    const out = apply(JSON.parse(JSON.stringify(data)));
    if (out.error) return { error: out.error, state: data };

    out.state.seq = (data.seq || 0) + 1;
    const { modified } = await store().setJSON(KEY, out.state, { onlyIfMatch: etag });
    if (modified) return { state: out.state };

    await sleep(50 + Math.random() * 150); // another device won the race
  }
  return { error: "Server busy — another device is recording. Please try again." };
}

/* ---- Status derivation -------------------------------------- */
function deriveStatus(qty, failed) {
  if (failed) return "unserviceable";
  if (qty <= 0) return "unserviceable";
  if (qty < 500) return "limited";
  return "serviceable";
}

const num = v => {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};
const str = (v, max = 300) => String(v == null ? "" : v).slice(0, max).trim();

/* ---- Record handlers ---------------------------------------
   The bowser level is ALWAYS taken from server state, never from
   the client, so a stale tab cannot roll the level backwards.
   ----------------------------------------------------------- */
function applyUplift(state, sid, r, unit) {
  const site = state.sites[sid];
  const cs = num(r.cstart), ce = num(r.cend);
  if (!str(r.reg) || !str(r.pilot)) return { error: "Aircraft registration and pilot name are required." };
  if (cs === null || ce === null) return { error: "Counter readings are required." };
  if (ce <= cs) return { error: "Counter end must be greater than counter start." };
  if (site.status === "unserviceable") return { error: "Installation is unserviceable — refuelling is not permitted." };

  const qty = ce - cs;
  if (qty > site.quantity) {
    return { error: `Quantity ${qty.toLocaleString()}L exceeds the ${site.quantity.toLocaleString()}L currently in the bowser.` };
  }
  const after = site.quantity - qty;
  const t = nowParts();

  site.quantity = after;
  site.status = deriveStatus(after, false);
  state.logs[sid].uplift.push({
    datetime: t.datetime, date: t.date, iso: t.iso,
    reg: str(r.reg, 12).toUpperCase(), atype: str(r.atype, 40), pilot: str(r.pilot, 80),
    unit: str(r.unit, 40) || unit, cstart: cs, cend: ce, qty,
    bowserAfter: after, notes: str(r.notes, 500), recordedBy: unit
  });
  return { state };
}

function applyReplen(state, sid, r, unit) {
  const site = state.sites[sid];
  const added = num(r.added);
  if (!str(r.name)) return { error: "Name is required." };
  if (added === null || added <= 0) return { error: "Quantity added must be greater than zero." };

  const before = site.quantity;
  if (before + added > site.maxCapacity) {
    return { error: `Exceeds capacity — only ${(site.maxCapacity - before).toLocaleString()}L of space available.` };
  }
  const after = before + added;
  const t = nowParts();

  site.quantity = after;
  site.status = deriveStatus(after, false);
  state.logs[sid].replen.push({
    datetime: t.datetime, date: t.date, iso: t.iso,
    name: str(r.name, 80), unit: str(r.unit, 40) || unit, tanker: str(r.tanker, 40),
    before, added, bowserAfter: after, batch: str(r.batch, 40), notes: str(r.notes, 500),
    recordedBy: unit
  });
  return { state };
}

const RESULTS = ["CB+CWD PASS", "Fail CB", "FAIL CWD", "Fail CB + FAIL CWD", "N/A"];

function applyFuelChk(state, sid, r, unit) {
  const site = state.sites[sid];
  if (!str(r.visualSign)) return { error: "Daily visual inspection signature is required." };
  if (!str(r.name)) return { error: "Name of person conducting the sample check is required." };
  if (!str(r.timeComplete)) return { error: "Time sample checks complete is required." };

  const sump = RESULTS.includes(r.sump) ? r.sump : "N/A";
  const filter = RESULTS.includes(r.filter) ? r.filter : "N/A";
  const hose = RESULTS.includes(r.hose) ? r.hose : "N/A";

  const cs = num(r.cstart), ce = num(r.cend);
  if (cs !== null && ce !== null && ce < cs) return { error: "Counter end is below counter start." };

  const drained = Math.max(0, num(r.drained) || 0);
  const recycled = Math.max(0, num(r.recycled) || 0);
  if (recycled > drained) return { error: "Recycled volume cannot exceed the volume drained." };

  const netLoss = drained - recycled;
  const before = site.quantity;
  if (netLoss > before) return { error: "Disposal exceeds the fuel currently in the bowser." };

  const after = before - netLoss;
  const anyFail = [sump, filter, hose].some(v => v !== "CB+CWD PASS" && v !== "N/A");
  const meterTotal = (cs !== null && ce !== null && ce > cs) ? ce - cs : 0;
  const t = nowParts();

  site.quantity = after;
  site.status = deriveStatus(after, anyFail);
  if (str(r.grade)) site.fuelGrade = str(r.grade, 40);
  if (str(r.tank)) site.tankSerial = str(r.tank, 40);
  if (str(r.capsuleExpRaw)) site.capsuleExpiry = str(r.capsuleExpRaw, 20);

  state.logs[sid].fuelchk.push({
    datetime: t.datetime, date: t.date, iso: t.iso,
    inspType: r.inspType === "Rebulk" ? "Rebulk" : "Daily",
    location: str(r.location, 120), grade: str(r.grade, 40), tank: str(r.tank, 40),
    visualSign: str(r.visualSign, 40), name: str(r.name, 80), unit: str(r.unit, 40) || unit,
    capsuleExp: str(r.capsuleExp, 20),
    sump, filter, hose, timeComplete: str(r.timeComplete, 10),
    cstart: cs === null ? "" : cs, cend: ce === null ? "" : ce, meterTotal,
    before, drained, recycled, netLoss, bowserAfter: after,
    result: str(r.result, 500), notes: str(r.notes, 500), anyFail, recordedBy: unit
  });
  return { state };
}

/* ---- Handler ------------------------------------------------ */
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }

  const who = auth(body.code);
  if (!who) return json({ error: "Invalid unit PIN" }, 401);

  try {
    if (body.action === "login" || body.action === "state") {
      const { data } = await readState();
      return json({ unit: who.unit, base: who.base, state: data, threshold: LOW_FUEL_THRESHOLD });
    }

    if (body.action === "record") {
      const sid = parseInt(body.sid, 10);
      const type = body.type;
      const rec = body.record || {};

      const { data } = await readState();
      if (!data.sites[sid]) return json({ error: "Unknown site" }, 400);
      if (!["uplift", "replen", "fuelchk"].includes(type)) return json({ error: "Unknown record type" }, 400);

      const handler = type === "uplift" ? applyUplift : type === "replen" ? applyReplen : applyFuelChk;
      const out = await mutate(st => handler(st, sid, rec, who.unit));

      if (out.error) return json({ error: out.error, state: out.state }, 409);
      return json({ unit: who.unit, base: who.base, state: out.state, threshold: LOW_FUEL_THRESHOLD });
    }

    // Beta testing: wipe all logs and set both bowsers to a chosen level.
    // Gated behind a separate admin code so a unit PIN alone cannot destroy records.
    if (body.action === "reset") {
      const admin = process.env.ESAFN_ADMIN_CODE || "RESET-ESAFN-2026";
      if (String(body.adminCode || "").trim() !== admin) {
        return json({ error: "Invalid reset code" }, 403);
      }
      const current = await readState();
      const level = num(body.level);
      const st = seedState();
      Object.values(st.sites).forEach(s => {
        const q = level === null ? s.maxCapacity : Math.max(0, Math.min(level, s.maxCapacity));
        s.quantity = q;
        s.status = deriveStatus(q, false);
      });
      st.seq = (current.data.seq || 0) + 1;
      st.lastReset = { by: who.unit, at: nowParts().datetime, level: level === null ? "full" : level };
      await store().setJSON(KEY, st);
      return json({ unit: who.unit, base: who.base, state: st, threshold: LOW_FUEL_THRESHOLD });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: "Server error: " + (err && err.message ? err.message : String(err)) }, 500);
  }
};

export const config = { path: "/api" };
