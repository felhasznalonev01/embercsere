// Közös számítások: túlóra (100% / 200%), létszám, szabadság – a statisztika oldal használja.
import { CODES, SHIFT_CODE, OVERTIME_200_WINDOW_HOURS, EXAMS, EXAM_WARN_DAYS } from "./config.js";
import { parse, monthKey, range, today, daysBetween, dutyClassOf } from "./common.js";

const H = 3600000;
const at = (d, hhmm) => { const [h, m] = (hhmm || "07:00").split(":").map(Number); const x = parse(d); x.setHours(h, m, 0, 0); return x.getTime(); };

// Alapértelmezett korlátok (a szolgálatvezetés átírhatja: settings/limits)
export const DEFAULT_LIMITS = { maxOvertime: 136, share200: 33, period: "month" };   // 136 óra / fő / hónap

// rosterMonths: { "YYYY-MM": { pid: { "DD": {c, t, p} } } }
export function eventsOf(pid, cid, rosterMonths, offers) {
  const ev = [];
  for (const m in rosterMonths) {
    const cells = rosterMonths[m]?.[pid]; if (!cells) continue;
    for (const dd in cells) {
      const v = cells[dd], code = CODES[v.c], d = `${m}-${dd}`;
      if (!code?.work) continue;
      const s = at(d, code.start);
      ev.push({ date: d, start: s, end: s + code.hours * H, hours: code.hours, ot: !!v.t, pct: v.p || null, code: v.c });
    }
  }
  for (const o of offers) {
    if (o.classId !== cid || o.personId !== pid) continue;
    const c = SHIFT_CODE[o.shift], code = CODES[c]; if (!code) continue;
    const s = at(o.date, code.start);
    ev.push({ date: o.date, start: s, end: s + code.hours * H, hours: code.hours, ot: true, lent: true, to: o.toClassId, code: c });
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

// Napi létszám (saját szolgálatban + kölcsönkapott)
export function headcount(cid, d, rosterMonths, people, offers) {
  const cells = rosterMonths[monthKey(d)] || {}, dd = d.slice(8);
  let total = 0;
  for (const p of people) {
    if (p.classId !== cid || p.active === false) continue;
    const v = cells[p.id]?.[dd]; if (v && CODES[v.c]?.duty) total++;
  }
  for (const o of offers) if (o.toClassId === cid && o.date === d) total++;
  return total;
}

// Szolgálati napok és a cél-létszám teljesülése
export function staffing(cid, from, to, rosterMonths, people, offers, rotation, target) {
  const days = range(from, to).filter(d => !rotation || dutyClassOf(rotation, d) === cid);
  return days.map(d => { const n = headcount(cid, d, rosterMonths, people, offers); return { date: d, n, ok: n >= target, short: Math.max(0, target - n) }; });
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
