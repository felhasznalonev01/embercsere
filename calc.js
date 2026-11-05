// Közös számítások: túlóra (100% / 200%), létszám, szabadság – a statisztika oldal használja.
import { CODES, SHIFT_CODE, OVERTIME_200_WINDOW_HOURS, EXAMS, EXAM_WARN_DAYS, DAY_FROM, NIGHT_FROM, COUNT_MIN_HOURS } from "./config.js";
import { parse, monthKey, range, today, daysBetween, dutyClassOf } from "./common.js";

const H = 3600000;
const at = (d, hhmm) => { const [h, m] = (hhmm || "07:00").split(":").map(Number); const x = parse(d); x.setHours(h, m, 0, 0); return x.getTime(); };

// Egy cella szolgálatának kezdete, vége és hossza (egyedi időponttal: v.s / v.e, pl. "08:00"–"20:00")
export function cellSpan(d, v) {
  const code = CODES[v?.c]; if (!code?.work) return null;
  const start = at(d, v.s || code.start);
  let end;
  if (v.s && v.e) { end = at(d, v.e); if (end <= start) end += 24 * H; }
  else end = start + code.hours * H;
  return { start, end, hours: Math.round((end - start) / H * 100) / 100 };
}
export function offerSpan(o) {
  const c = SHIFT_CODE[o.shift], code = CODES[c]; if (!code) return null;
  const start = at(o.date, code.start); return { start, end: start + code.hours * H, hours: code.hours, code: c };
}
// Melyik napszakba számít (nappal 7–19, éjszaka 19–7), ha legalább X órát lefed belőle
export function dayNightOf(d, span) {
  if (!span) return { day: false, night: false };
  const ds = at(d, DAY_FROM), ns = at(d, NIGHT_FROM), ne = ns + 12 * H;
  const ov = (a, b) => Math.max(0, Math.min(span.end, b) - Math.max(span.start, a)) / H;
  return { day: ov(ds, ns) >= COUNT_MIN_HOURS, night: ov(ns, ne) >= COUNT_MIN_HOURS };
}
// 12 órás embernek csak N / É, 24 órásnak csak 24 adható (a többi kód mindenkinek)
export function codeAllowed(code, pattern) {
  if (code === "N" || code === "É") return pattern !== "24";
  if (code === "24") return pattern !== "12";
  return true;
}

// Alapértelmezett korlátok (a szolgálatvezetés átírhatja: settings/limits)
export const DEFAULT_LIMITS = { maxOvertime: 136, share200: 33, period: "month" };   // 136 óra / fő / hónap

// rosterMonths: { "YYYY-MM": { pid: { "DD": {c, t, p} } } }
export function eventsOf(pid, cid, rosterMonths, offers) {
  const ev = [];
  for (const m in rosterMonths) {
    const cells = rosterMonths[m]?.[pid]; if (!cells) continue;
    for (const dd in cells) {
      const v = cells[dd], d = `${m}-${dd}`, sp = cellSpan(d, v);
      if (!sp) continue;
      ev.push({ date: d, ...sp, ot: !!v.t, pct: v.p || null, code: v.c });
    }
  }
  for (const o of offers) {
    if (o.classId !== cid || o.personId !== pid) continue;
    const sp = offerSpan(o); if (!sp) continue;
    ev.push({ date: o.date, ...sp, ot: true, lent: true, to: o.toClassId });
  }
  return ev.sort((a, b) => a.start - b.start);
}

// 200%, ha a saját (nem túlóra) szolgálat vége után X órán belül kezdődik, különben 100%
export function pctOf(e, events) {
  if (e.pct) return e.pct;
  let prevEnd = null;
  for (const x of events) if (!x.ot && x.end <= e.start && (prevEnd == null || x.end > prevEnd)) prevEnd = x.end;
  return prevEnd != null && (e.start - prevEnd) / H < OVERTIME_200_WINDOW_HOURS ? 200 : 100;
}

// Egy ember túlórái egy időszakban
export function overtimeOf(pid, cid, rosterMonths, offers, from, to) {
  const evs = eventsOf(pid, cid, rosterMonths, offers);
  const r = { h100: 0, h200: 0, lent: 0, regular: 0, items: [] };
  for (const e of evs) {
    if (e.date < from || e.date > to) continue;
    if (!e.ot) { r.regular += e.hours; continue; }
    const pc = pctOf(e, evs);
    if (pc === 200) r.h200 += e.hours; else r.h100 += e.hours;
    if (e.lent) r.lent += e.hours;
    r.items.push({ ...e, pctFinal: pc });
  }
  r.total = r.h100 + r.h200;
  return r;
}

// Kódok száma egy időszakban (pl. SZ, B)
export function countCodes(pid, rosterMonths, from, to, code) {
  let n = 0;
  for (const m in rosterMonths) {
    const cells = rosterMonths[m]?.[pid]; if (!cells) continue;
    for (const dd in cells) { const d = `${m}-${dd}`; if (d >= from && d <= to && cells[dd].c === code) n++; }
  }
  return n;
}

// Napi létszám nappal / éjszaka (saját szolgálatban + kölcsönkapott)
export function headcount(cid, d, rosterMonths, people, offers) {
  const cells = rosterMonths[monthKey(d)] || {}, dd = d.slice(8);
  let day = 0, night = 0, total = 0;
  for (const p of people) {
    if (p.classId !== cid || p.active === false) continue;
    const v = cells[p.id]?.[dd]; if (!v || !CODES[v.c]?.duty) continue;
    const dn = dayNightOf(d, cellSpan(d, v)); total++; if (dn.day) day++; if (dn.night) night++;
  }
  for (const o of offers) if (o.toClassId === cid && o.date === d) { const dn = dayNightOf(d, offerSpan(o)); total++; if (dn.day) day++; if (dn.night) night++; }
  return { total, day, night };
}

// Szolgálati napok és a cél-létszám teljesülése (nappal és éjszaka külön)
export function staffing(cid, from, to, rosterMonths, people, offers, rotation, tDay, tNight) {
  const days = range(from, to).filter(d => !rotation || dutyClassOf(rotation, d) === cid);
  return days.map(d => {
    const h = headcount(cid, d, rosterMonths, people, offers);
    const ok = h.day >= tDay && h.night >= tNight;
    return { date: d, n: h.total, day: h.day, night: h.night, ok, short: Math.max(0, tDay - h.day) + Math.max(0, tNight - h.night) };
  });
}
// Cél-létszám egy osztálynál (régi egyetlen "target" mezőből is)
export function targetsOf(settings, defDay, defNight) {
  return { day: Number(settings?.targetDay ?? settings?.target ?? defDay), night: Number(settings?.targetNight ?? settings?.target ?? defNight) };
}

// Érvényességek állapota
export function examState(d) {
  if (!d) return "none";
  const left = daysBetween(today(), d);
  return left < 0 ? "bad" : left <= EXAM_WARN_DAYS ? "warn" : "ok";
}
export function examIssues(p) {
  return EXAMS.map(x => ({ x, d: p.exams?.[x.id] || "", st: examState(p.exams?.[x.id]) })).filter(e => e.st === "bad" || e.st === "warn");
}
