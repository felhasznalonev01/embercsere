// Statisztika: osztályvezető a saját osztályát, a szolgálatvezetés mind a 4-et látja (és lebontja).
import { CLASSES, DEFAULT_TARGET, ROLES } from "./config.js";
import { $, esc, className, color, store, run, showError, start, today, addDays, range, monthsIn, monthKey, keretOf, lastOfMonth, fmtDate } from "./common.js";
import { DEFAULT_LIMITS, overtimeOf, countCodes, staffing, examIssues } from "./calc.js";

const MONTHS = ["jan", "feb", "márc", "ápr", "máj", "jún", "júl", "aug", "szept", "okt", "nov", "dec"];
const PTYPES = [["year", "Év"], ["keret", "4 havi keret"], ["month", "Hónap"]];

let be, user;
let watched = [];
let view = null;                 // "all" | osztály id
let ptype = store.get("st.ptype") || "year";
let ref = today();               // az időszak egy napja
let detail = null;               // kiválasztott ember (lebontás)

// adatok
let peopleAll = [], rosterBy = {}, offers = [], requests = [], settingsBy = {}, rotation = null, limits = { ...DEFAULT_LIMITS };
let subs = { months: {}, other: [], range: [], rangeKey: "" };

// ---------------------------------------------------------------- időszak
function period() {
  if (ptype === "month") { const m = monthKey(ref); return { from: m + "-01", to: lastOfMonth(m), label: `${m.slice(0, 4)}. ${["január", "február", "március", "április", "május", "június", "július", "augusztus", "szeptember", "október", "november", "december"][Number(m.slice(5)) - 1]}` }; }
  if (ptype === "keret") { const k = keretOf(ref); return { ...k, label: `${k.from.slice(0, 7).replace("-", ".")} – ${k.to.slice(0, 7).replace("-", ".")}` }; }
  const y = ref.slice(0, 4); return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}. év` };
}
// A túlóra-korlát időszaka (év vagy 4 havi keret), a kiválasztott időszak kezdőnapjához igazítva
function limitPeriod() {
  const p = period();
  if (limits.period === "keret") { const k = keretOf(p.from); return { ...k, label: "a 4 havi keretben" }; }
  const y = p.from.slice(0, 4); return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}-ben` };
}
function shift(dir) {
  if (ptype === "month") { const [y, m] = ref.split("-").map(Number); const d = new Date(y, m - 1 + dir, 1, 12); ref = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; }
  else if (ptype === "keret") { const k = keretOf(ref); ref = dir < 0 ? addDays(k.from, -1) : addDays(k.to, 1); }
  else ref = `${Number(ref.slice(0, 4)) + dir}-06-01`;
}

// ---------------------------------------------------------------- adatok
function resubscribe() {
  const p = period(), l = limitPeriod();
  const lo = addDays(p.from < l.from ? p.from : l.from, -2), hi = p.to > l.to ? p.to : l.to;
  const y = today().slice(0, 4);
  const months = new Set([...monthsIn(lo, hi), ...monthsIn(`${y}-01-01`, `${y}-12-31`)]);
  const need = new Set(watched.flatMap(cid => [...months].map(m => `${cid}_${m}`)));
  for (const key in subs.months) if (!need.has(key)) { subs.months[key](); delete subs.months[key]; const [cid, m] = key.split("_"); if (rosterBy[cid]) delete rosterBy[cid][m]; }
  for (const key of need) if (!subs.months[key]) {
    const [cid, m] = key.split("_");
    subs.months[key] = be.watchDoc("roster", key, d => { (rosterBy[cid] ||= {})[m] = d?.cells || {}; schedule(); }, showError);
  }
  const key = lo + "|" + hi;
  if (key !== subs.rangeKey) {
    subs.range.forEach(u => u()); subs.rangeKey = key;
    subs.range = [
      be.watch("offers", [["date", ">=", lo], ["date", "<=", hi]], d => { offers = d; schedule(); }, showError),
      be.watch("requests", [["date", ">=", lo], ["date", "<=", hi]], d => { requests = d; schedule(); }, showError)
    ];
  }
}
let pending = false;
const schedule = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; render(); }); };

// ---------------------------------------------------------------- számítás
function classStats(cid) {
  const p = period(), l = limitPeriod(), y = today().slice(0, 4);
  const R = rosterBy[cid] || {};
  const people = peopleAll.filter(x => x.classId === cid && x.active !== false);
  const target = Number(settingsBy[cid]?.target ?? DEFAULT_TARGET);
  const rows = people.map(x => {
    const ot = overtimeOf(x.id, cid, R, offers, p.from, p.to);
    const otL = overtimeOf(x.id, cid, R, offers, l.from, l.to);
    return {
      p: x, ot, limitTotal: otL.total,
      leaveUsed: countCodes(x.id, R, `${y}-01-01`, `${y}-12-31`, "SZ"), leaveTotal: Number(x.leaveDays ?? 0),
      sick: countCodes(x.id, R, p.from, p.to, "B"), exams: examIssues(x)
    };
  });
  const sum = k => rows.reduce((a, r) => a + r.ot[k], 0);
  const staff = staffing(cid, p.from, p.to, R, peopleAll, offers, rotation, target);
  const reqs = requests.filter(r => r.classId === cid && r.date >= p.from && r.date <= p.to);
  const inP = o => o.date >= p.from && o.date <= p.to;
  // havi bontás
  const months = monthsIn(p.from, p.to).map(m => {
    const f = m + "-01", t = lastOfMonth(m);
    let h100 = 0, h200 = 0;
    for (const r of rows) for (const it of r.ot.items) if (it.date >= f && it.date <= t) { if (it.pctFinal === 200) h200 += it.hours; else h100 += it.hours; }
    return { m, h100, h200 };
  });
  return {
    cid, rows, people, target, staff, months,
    h100: sum("h100"), h200: sum("h200"), total: sum("total"), lent: sum("lent"),
    over: rows.filter(r => r.limitTotal > limits.maxOvertime), near: rows.filter(r => r.limitTotal <= limits.maxOvertime && r.limitTotal >= limits.maxOvertime * 0.9),
    leaveUsed: rows.reduce((a, r) => a + r.leaveUsed, 0), leaveTotal: rows.reduce((a, r) => a + r.leaveTotal, 0),
    sick: rows.reduce((a, r) => a + r.sick, 0),
    asked: reqs.reduce((a, r) => a + (r.qty || []).reduce((x, y) => x + y, 0), 0),
    got: offers.filter(o => o.toClassId === cid && inP(o)).length,
    gave: offers.filter(o => o.classId === cid && inP(o)).length,
    examBad: rows.reduce((a, r) => a + r.exams.filter(e => e.st === "bad").length, 0),
    examWarn: rows.reduce((a, r) => a + r.exams.filter(e => e.st === "warn").length, 0)
  };
}

// ---------------------------------------------------------------- építőkockák
const fmt = n => (Math.round(n * 10) / 10).toLocaleString("hu-HU");
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
function status(kind, text) { return `<span class="st ${kind}">${kind === "good" ? "✓" : kind === "bad" ? "⚠" : "●"} ${text}</span>`; }
function tile(lbl, val, sub = "", st = "") { return `<div class="tile"><div class="lbl">${lbl}</div><div class="val">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ""}${st}</div>`; }
function ratioStatus(h100, h200) {
  const tot = h100 + h200; if (!tot) return status("good", "nincs túlóra");
  const s200 = h200 / tot * 100, tgt = limits.share200;
  return s200 <= tgt + 3 ? status("good", `cél: ${100 - tgt}/${tgt}`) : status(s200 <= tgt + 10 ? "warn" : "bad", `sok a 200% (cél ${tgt}%)`);
}

function tiles(s, isAll) {
  const tot = s.h100 + s.h200, ppl = isAll ? s.peopleN : s.people.length;
  const staffOk = s.staff.filter(x => x.ok).length;
  return `<div class="tiles">
    ${tile("Túlóra összesen", `${fmt(tot)} <small>óra</small>`, `${ppl ? fmt(tot / ppl) : 0} óra / fő · ebből kölcsönadva ${fmt(s.lent)} ó`)}
    ${tile("100% / 200% arány", tot ? `${pct(s.h100, tot)}<small>%</small> / ${pct(s.h200, tot)}<small>%</small>` : "–", `${fmt(s.h100)} ó / ${fmt(s.h200)} ó`, ratioStatus(s.h100, s.h200))}
    ${tile("Korlát felett", `${s.over.length} <small>fő</small>`, `${limits.maxOvertime} óra ${limitPeriod().label} · 90% felett: ${s.near.length} fő`,
      s.over.length ? status("bad", "túllépés") : s.near.length ? status("warn", "közel a korláthoz") : status("good", "rendben"))}
    ${tile("Létszám teljesülés", s.staff.length ? `${pct(staffOk, s.staff.length)}<small>%</small>` : "–", `${staffOk} / ${s.staff.length} szolgálati napon megvolt a cél`,
      !s.staff.length ? "" : staffOk === s.staff.length ? status("good", "minden nap megvolt") : status(pct(staffOk, s.staff.length) >= 80 ? "warn" : "bad", `${s.staff.length - staffOk} napon kevés`))}
    ${tile("Szabadság (idén)", `${s.leaveUsed}<small> / ${s.leaveTotal} nap</small>`, `${pct(s.leaveUsed, s.leaveTotal)}% felhasználva · betegnap az időszakban: ${s.sick}`)}
    ${tile("Embercsere", `${s.asked} / ${s.got} / ${s.gave}`, "kért / kapott / adott fő", s.asked > s.got ? status("warn", `${s.asked - s.got} hely nem telt be`) : "")}
    ${tile("Érvényességek", `${s.examBad} <small>lejárt</small>`, `${s.examWarn} lejár 30 napon belül`, s.examBad ? status("bad", "pótolni kell") : s.examWarn ? status("warn", "hamarosan") : status("good", "rendben"))}
  </div>`;
}

// Túlóra emberenként: halmozott sáv (100% + 200%), korlát-vonal
function otBars(rows, { classLabel = false, max = null } = {}) {
  const samePeriod = limits.period === ptype || (limits.period === "year" && ptype === "year");
  const top = Math.max(max ?? 0, ...rows.map(r => r.ot.total), samePeriod ? limits.maxOvertime * 1.08 : 0, 1);
  const lim = samePeriod ? `<div class="limit" style="left:${limits.maxOvertime / top * 100}%"></div>` : "";
  if (!rows.length) return `<div class="empty-list">Nincs adat.</div>`;
  return `<div class="hbars">${rows.map(r => {
    const over = r.limitTotal > limits.maxOvertime, near = !over && r.limitTotal >= limits.maxOvertime * 0.9;
    const tip = `${r.p.name}${classLabel ? " (" + className(r.p.classId) + ")" : ""}\n100%: ${fmt(r.ot.h100)} ó · 200%: ${fmt(r.ot.h200)} ó\nÖsszesen: ${fmt(r.ot.total)} ó${r.ot.lent ? `\nebből kölcsönadva: ${fmt(r.ot.lent)} ó` : ""}\nKorlát ${limitPeriod().label}: ${fmt(r.limitTotal)} / ${limits.maxOvertime} ó`;
    return `<div class="hrow click" data-person="${r.p.id}" data-tip="${esc(tip)}">
      <span class="nm">${classLabel ? `<span class="dot" style="--clr:${color(r.p.classId)}"></span>` : ""}${esc(r.p.name)}${classLabel ? `<small>${esc(className(r.p.classId))}</small>` : ""}</span>
      <div class="track">${r.ot.h100 ? `<div class="seg s100" style="width:${r.ot.h100 / top * 100}%"></div>` : ""}${r.ot.h200 ? `<div class="seg s200" style="width:${r.ot.h200 / top * 100}%"></div>` : ""}${lim}</div>
      <span class="v">${fmt(r.ot.total)} ó ${over ? `<span class="over">⚠ ${fmt(r.limitTotal)}/${limits.maxOvertime}</span>` : near ? `<span class="near">● ${fmt(r.limitTotal)}/${limits.maxOvertime}</span>` : ""}</span>
    </div>`;
  }).join("")}</div>`;
}

function ratioBar(h100, h200) {
  const tot = h100 + h200;
  if (!tot) return `<div class="empty-list">Nincs túlóra az időszakban.</div>`;
  const a = h100 / tot * 100, b = 100 - a, t = 100 - limits.share200;
  return `<div class="ratio" data-tip="100%: ${fmt(h100)} ó (${Math.round(a)}%)\n200%: ${fmt(h200)} ó (${Math.round(b)}%)\nCél: ${t}% / ${limits.share200}%">
    ${a ? `<div class="seg s100" style="width:${a}%">${Math.round(a)}%</div>` : ""}${b ? `<div class="seg s200" style="width:${b}%">${Math.round(b)}%</div>` : ""}
    <div class="target" style="left:${t}%"><span>cél ${t} / ${limits.share200}</span></div></div>`;
}

function monthCols(months) {
  const top = Math.max(1, ...months.map(m => m.h100 + m.h200));
  return `<div class="cols">${months.map(m => {
    const t = m.h100 + m.h200;
    return `<div class="col" data-tip="${MONTHS[Number(m.m.slice(5)) - 1]} ${m.m.slice(0, 4)}\n100%: ${fmt(m.h100)} ó\n200%: ${fmt(m.h200)} ó\nÖsszesen: ${fmt(t)} ó">
      ${m.h100 ? `<div class="seg s100" style="height:${m.h100 / top * 100}%"></div>` : ""}${m.h200 ? `<div class="seg s200" style="height:${m.h200 / top * 100}%"></div>` : ""}
      ${t ? `<span class="top" style="bottom:calc(${t / top * 100}% + 2px)">${fmt(t)}</span>` : ""}</div>`;
  }).join("")}</div><div class="xlabels">${months.map(m => `<span>${MONTHS[Number(m.m.slice(5)) - 1]}</span>`).join("")}</div>`;
}

function staffCols(staff, target) {
  if (!staff.length) return `<div class="empty-list">Nincs szolgálati nap az időszakban${rotation ? "" : " (nincs beállítva szolgálati sorrend)"}.</div>`;
  const top = Math.max(target * 1.25, ...staff.map(s => s.n), 1);
  return `<div class="cols" style="gap:${staff.length > 60 ? 1 : 3}px">
    <div class="tline" style="bottom:${target / top * 100}%"><span>cél ${target}</span></div>
    ${staff.map(s => `<div class="col ${s.ok ? "okc" : "lowc"}" data-tip="${s.date.replaceAll("-", ".")}.\n${s.n} fő (cél ${target})${s.ok ? "" : `\nhiányzik ${s.short} fő`}"><div class="seg" style="height:${s.n / top * 100}%"></div></div>`).join("")}
  </div><div class="xlabels"><span style="text-align:left">${staff[0].date.slice(5).replace("-", ".")}.</span><span style="text-align:right">${staff[staff.length - 1].date.slice(5).replace("-", ".")}.</span></div>`;
}

function leaveBars(rows) {
  if (!rows.length) return `<div class="empty-list">Nincs adat.</div>`;
  const top = Math.max(1, ...rows.map(r => Math.max(r.leaveTotal, r.leaveUsed)));
  return `<div class="hbars">${rows.map(r => {
    const left = r.leaveTotal - r.leaveUsed;
    return `<div class="hrow" data-tip="${esc(r.p.name)}\nFelhasznált: ${r.leaveUsed} nap\nÉves keret: ${r.leaveTotal} nap\nMarad: ${left} nap">
      <span class="nm">${esc(r.p.name)}</span>
      <div class="track bg" style="width:${r.leaveTotal / top * 100}%"><div class="seg s100" style="width:${r.leaveTotal ? Math.min(100, r.leaveUsed / r.leaveTotal * 100) : 0}%;border-radius:0 4px 4px 0"></div></div>
      <span class="v">${r.leaveUsed}/${r.leaveTotal} ${left < 0 ? `<span class="over">⚠ ${left}</span>` : `· marad ${left}`}</span></div>`;
  }).join("")}</div>`;
}

function examList(rows, classLabel) {
  const list = rows.flatMap(r => r.exams.map(e => ({ r, ...e }))).sort((a, b) => (a.d || "").localeCompare(b.d || ""));
  if (!list.length) return `<div class="empty-list">✓ Minden érvényesség rendben.</div>`;
  return `<table class="plain"><thead><tr><th>Név</th>${classLabel ? "<th>Osztály</th>" : ""}<th>Mi</th><th>Érvényes eddig</th><th>Állapot</th></tr></thead><tbody>
    ${list.map(e => `<tr><td>${esc(e.r.p.name)}</td>${classLabel ? `<td>${esc(className(e.r.p.classId))}</td>` : ""}<td>${esc(e.x.label)}</td><td>${e.d.replaceAll("-", ".")}.</td>
      <td>${e.st === "bad" ? status("bad", "lejárt") : status("warn", "hamarosan lejár")}</td></tr>`).join("")}</tbody></table>`;
}

const LEG_OT = `<div class="legend2"><span><i style="background:var(--s100)"></i>100%-os túlóra</span><span><i style="background:var(--s200)"></i>200%-os túlóra</span>`;

// ---------------------------------------------------------------- nézetek
function renderClass(cid) {
  const s = classStats(cid);
  const rows = s.rows.slice().sort((a, b) => b.ot.total - a.ot.total || a.p.name.localeCompare(b.p.name, "hu"));
  const samePeriod = limits.period === ptype;
  const det = detail && s.rows.find(r => r.p.id === detail);
  $("#content").innerHTML = `${tiles(s, false)}
  <div class="charts">
    <div class="chart wide"><h3>Túlóra emberenként</h3>
      <p class="desc">Az időszak túlórái, sorba rendezve. ${samePeriod ? `A szaggatott vonal a ${limits.maxOvertime} órás korlát.` : `A korlát (${limits.maxOvertime} óra ${limitPeriod().label}) a jobb oldali számokban látszik, ha valaki közelíti.`} Kattints egy névre a részletekhez.</p>
      ${LEG_OT}${samePeriod ? `<span><i class="line"></i>${limits.maxOvertime} órás korlát</span>` : ""}</div>
      ${otBars(rows)}</div>
    ${det ? personDetail(det) : ""}
    <div class="chart"><h3>100% / 200% arány</h3><p class="desc">A túlórák megoszlása a célhoz (${100 - limits.share200}% / ${limits.share200}%) képest. A fekete vonal a cél.</p>${LEG_OT}</div>${ratioBar(s.h100, s.h200)}</div>
    <div class="chart"><h3>Túlóra havonta</h3><p class="desc">Óra / hónap, 100% és 200% szerint.</p>${LEG_OT}</div>${monthCols(s.months)}</div>
    <div class="chart wide"><h3>Létszám a szolgálati napokon</h3><p class="desc">Minden oszlop egy szolgálati nap (7–7). Zöld: megvolt a cél-létszám, piros: kevesebben voltak.</p>
      <div class="legend2"><span><i style="background:var(--good)"></i>✓ megvolt</span><span><i style="background:var(--bad)"></i>⚠ kevés</span><span><i class="line"></i>cél ${s.target} fő</span></div>${staffCols(s.staff, s.target)}</div>
    <div class="chart"><h3>Szabadság (${today().slice(0, 4)})</h3><p class="desc">Felhasznált napok az éves kerethez képest.</p>${leaveBars(s.rows.slice().sort((a, b) => b.leaveUsed / (b.leaveTotal || 1) - a.leaveUsed / (a.leaveTotal || 1)))}</div>
    <div class="chart"><h3>Lejárt / lejáró érvényességek</h3><p class="desc">Pszichológiai, egészségügyi, fizikai, lőkiképzés.</p>${examList(s.rows, false)}</div>
  </div>`;
  lastExport = () => exportRows(s.rows, false);
}

function personDetail(r) {
  const items = r.ot.items.slice().sort((a, b) => a.start - b.start);
  return `<div class="chart wide"><h3>${esc(r.p.name)} – túlórák részletesen <button class="small" data-close-detail style="float:right">✕</button></h3>
    <p class="desc">${r.p.pattern} órás${r.p.role ? " · " + esc(r.p.role) : ""} · időszakban ${fmt(r.ot.total)} ó (100%: ${fmt(r.ot.h100)}, 200%: ${fmt(r.ot.h200)}) · korlát ${limitPeriod().label}: ${fmt(r.limitTotal)} / ${limits.maxOvertime} ó</p>
    ${items.length ? `<table class="plain"><thead><tr><th>Nap</th><th>Szolgálat</th><th class="num">Óra</th><th>Pótlék</th><th>Megjegyzés</th></tr></thead><tbody>
    ${items.map(it => `<tr><td>${fmtDate(it.date)}</td><td>${it.code}</td><td class="num">${it.hours}</td><td>${it.pctFinal}%</td><td>${it.lent ? "kölcsönadva: " + esc(className(it.to)) : "saját osztály"}</td></tr>`).join("")}</tbody></table>` : `<div class="empty-list">Nincs túlóra az időszakban.</div>`}</div>`;
}

function renderAll() {
  const all = CLASSES.map(c => classStats(c.id));
  const agg = {
    h100: all.reduce((a, s) => a + s.h100, 0), h200: all.reduce((a, s) => a + s.h200, 0), lent: all.reduce((a, s) => a + s.lent, 0),
    over: all.flatMap(s => s.over), near: all.flatMap(s => s.near), staff: all.flatMap(s => s.staff), peopleN: all.reduce((a, s) => a + s.people.length, 0),
    leaveUsed: all.reduce((a, s) => a + s.leaveUsed, 0), leaveTotal: all.reduce((a, s) => a + s.leaveTotal, 0), sick: all.reduce((a, s) => a + s.sick, 0),
    asked: all.reduce((a, s) => a + s.asked, 0), got: all.reduce((a, s) => a + s.got, 0), gave: all.reduce((a, s) => a + s.gave, 0),
    examBad: all.reduce((a, s) => a + s.examBad, 0), examWarn: all.reduce((a, s) => a + s.examWarn, 0)
  };
  const allRows = all.flatMap(s => s.rows);
  const top = allRows.slice().sort((a, b) => b.limitTotal - a.limitTotal).slice(0, 12);
  const maxClass = Math.max(1, ...all.map(s => s.h100 + s.h200));
  // összes osztály havi bontása
  const months = monthsIn(period().from, period().to).map(m => ({ m, h100: all.reduce((a, s) => a + (s.months.find(x => x.m === m)?.h100 || 0), 0), h200: all.reduce((a, s) => a + (s.months.find(x => x.m === m)?.h200 || 0), 0) }));

  $("#content").innerHTML = `${tiles(agg, true)}
  <div class="classcards">${all.map(s => {
    const tot = s.h100 + s.h200, ok = s.staff.filter(x => x.ok).length;
    return `<div class="ccard" style="--clr:${color(s.cid)}" data-goclass="${s.cid}">
      <h3>${esc(className(s.cid))}</h3>
      <div class="kv"><span>Túlóra</span><b>${fmt(tot)} ó</b></div>
      <div class="kv"><span>100% / 200%</span><b>${tot ? `${pct(s.h100, tot)}% / ${pct(s.h200, tot)}%` : "–"}</b></div>
      <div class="kv"><span>Korlát felett</span><b style="color:${s.over.length ? "var(--bad)" : "inherit"}">${s.over.length ? "⚠ " : ""}${s.over.length} fő</b></div>
      <div class="kv"><span>Létszám teljesülés</span><b>${s.staff.length ? pct(ok, s.staff.length) + "%" : "–"}</b></div>
      <div class="kv"><span>Szabadság</span><b>${s.leaveUsed} / ${s.leaveTotal} nap</b></div>
      <div class="kv"><span>Kért / kapott / adott</span><b>${s.asked} / ${s.got} / ${s.gave}</b></div>
      <div class="kv"><span>Lejárt érvényesség</span><b style="color:${s.examBad ? "var(--bad)" : "inherit"}">${s.examBad}</b></div>
      <div class="go">Részletek →</div></div>`;
  }).join("")}</div>
  <div class="charts">
    <div class="chart"><h3>Túlóra osztályonként</h3><p class="desc">Összes túlóra óra, 100% és 200% szerint.</p>${LEG_OT}</div>
      <div class="hbars">${all.map(s => `<div class="hrow click" data-goclass="${s.cid}" data-tip="${esc(className(s.cid))}\n100%: ${fmt(s.h100)} ó\n200%: ${fmt(s.h200)} ó\nÖsszesen: ${fmt(s.h100 + s.h200)} ó">
        <span class="nm"><span class="dot" style="--clr:${color(s.cid)}"></span>${esc(className(s.cid))}</span>
        <div class="track">${s.h100 ? `<div class="seg s100" style="width:${s.h100 / maxClass * 100}%"></div>` : ""}${s.h200 ? `<div class="seg s200" style="width:${s.h200 / maxClass * 100}%"></div>` : ""}</div>
        <span class="v">${fmt(s.h100 + s.h200)} ó</span></div>`).join("")}</div></div>
    <div class="chart"><h3>200%-os arány osztályonként</h3><p class="desc">A 200%-os túlóra aránya. A fekete vonal a cél (${limits.share200}%).</p>
      <div class="hbars">${all.map(s => { const tot = s.h100 + s.h200, sh = tot ? s.h200 / tot * 100 : 0; return `<div class="hrow" data-tip="${esc(className(s.cid))}: ${Math.round(sh)}% (cél ${limits.share200}%)">
        <span class="nm"><span class="dot" style="--clr:${color(s.cid)}"></span>${esc(className(s.cid))}</span>
        <div class="track bg"><div class="seg s200" style="width:${sh}%"></div><div class="target" style="left:${limits.share200}%"></div></div>
        <span class="v">${tot ? Math.round(sh) + "%" : "–"} ${tot && sh > limits.share200 + 3 ? '<span class="over">⚠</span>' : ""}</span></div>`; }).join("")}</div></div>
    <div class="chart wide"><h3>Legtöbb túlóra – mind a 4 osztály</h3><p class="desc">A 12 legtöbb túlórával rendelkező ember a korlát-időszakban (${limitPeriod().label}). Kattints egy névre a részletekhez.</p>
      ${LEG_OT}<span><i class="line"></i>${limits.maxOvertime} órás korlát</span></div>
      ${otBars(top.map(r => ({ ...r, ot: overtimeOf(r.p.id, r.p.classId, rosterBy[r.p.classId] || {}, offers, limitPeriod().from, limitPeriod().to) })), { classLabel: true })}</div>
    <div class="chart"><h3>Túlóra havonta – összesen</h3><p class="desc">Mind a 4 osztály együtt.</p>${LEG_OT}</div>${monthCols(months)}</div>
    <div class="chart"><h3>Létszám teljesülés osztályonként</h3><p class="desc">A szolgálati napok hány százalékán volt meg a cél-létszám.</p>
      <div class="hbars">${all.map(s => { const ok = s.staff.filter(x => x.ok).length, p = s.staff.length ? ok / s.staff.length * 100 : 0; return `<div class="hrow click" data-goclass="${s.cid}" data-tip="${esc(className(s.cid))}: ${ok} / ${s.staff.length} nap">
        <span class="nm"><span class="dot" style="--clr:${color(s.cid)}"></span>${esc(className(s.cid))}</span>
        <div class="track bg"><div class="seg" style="width:${p}%;background:${p >= 95 ? "var(--good)" : p >= 80 ? "var(--warnc)" : "var(--bad)"}"></div></div>
        <span class="v">${s.staff.length ? Math.round(p) + "%" : "–"}</span></div>`; }).join("")}</div></div>
    <div class="chart wide"><h3>Lejárt / lejáró érvényességek – mind a 4 osztály</h3>${examList(allRows, true)}</div>
  </div>`;
  lastExport = () => exportRows(allRows, true);
}

// ---------------------------------------------------------------- vezérlés
function render() {
  if (!user) return;
  const p = period();
  $("#ptype").innerHTML = PTYPES.map(([k, t]) => `<button type="button" data-ptype="${k}" class="${k === ptype ? "on" : ""}">${t}</button>`).join("");
  $("#pLabel").textContent = p.label;
  if (user.role === "admin") {
    $("#viewWrap").hidden = false;
    $("#view").innerHTML = `<option value="all">Mind a 4 osztály</option>` + CLASSES.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    $("#view").value = view;
    $("#crumbs").innerHTML = view === "all" ? "Mind a 4 osztály – kattints egy osztályra a lebontáshoz." : `<a data-goclass="all">Mind a 4 osztály</a> › ${esc(className(view))}`;
    renderLimits();
  } else $("#crumbs").textContent = className(view);
  view === "all" ? renderAll() : renderClass(view);
}

function renderLimits() {
  $("#limitsCard").hidden = false;
  if ($("#limitsCard").contains(document.activeElement)) return;   // gépelés közben ne írjuk felül
  $("#limitsCard").innerHTML = `<h2>Beállítások <span class="muted" style="font-weight:400;font-size:13px">– csak a szolgálatvezetés módosíthatja</span></h2>
    <form class="limits" id="limitsForm">
      <label>Túlóra-korlát / fő <span class="row" style="gap:6px;align-items:center"><input type="number" name="max" min="1" max="2000" value="${limits.maxOvertime}"> óra</span></label>
      <label>Időszak <select name="period"><option value="year" ${limits.period === "year" ? "selected" : ""}>naptári évre</option><option value="keret" ${limits.period === "keret" ? "selected" : ""}>4 havi keretre</option></select></label>
      <label>200%-os túlóra célaránya <span class="row" style="gap:6px;align-items:center"><input type="number" name="share" min="0" max="100" value="${limits.share200}"> % <span class="muted">(100%-os: ${100 - limits.share200}%)</span></span></label>
      <button class="primary">Mentés</button>
    </form>`;
}

let lastExport = () => {};
function exportRows(rows, withClass) {
  const q = v => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const n = v => String(Math.round(v * 10) / 10).replace(".", ",");
  const head = ["Név", ...(withClass ? ["Osztály"] : []), "Munkarend", "Túlóra 100% (ó)", "Túlóra 200% (ó)", "Túlóra összesen (ó)", "ebből kölcsönadva (ó)", `Túlóra a korlát-időszakban (ó)`, "Korlát (ó)", "Szabadság felhasznált", "Szabadság keret", "Betegnap"];
  const lines = [head.map(q).join(";"), ...rows.map(r => [r.p.name, ...(withClass ? [className(r.p.classId)] : []), r.p.pattern + "h", n(r.ot.h100), n(r.ot.h200), n(r.ot.total), n(r.ot.lent), n(r.limitTotal), limits.maxOvertime, r.leaveUsed, r.leaveTotal, r.sick].map(q).join(";"))];
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `statisztika_${view === "all" ? "osszes" : className(view).replace(/\W+/g, "_")}_${period().from}_${period().to}.csv` });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

document.addEventListener("click", e => {
  const t = e.target.closest("button, [data-goclass], [data-person], a") || e.target;
  const d = t.dataset || {};
  if (d.ptype) { ptype = d.ptype; store.set("st.ptype", ptype); detail = null; resubscribe(); render(); }
  else if (t.id === "pPrev" || t.id === "pNext") { shift(t.id === "pPrev" ? -1 : 1); detail = null; resubscribe(); render(); }
  else if (t.id === "exportBtn") lastExport();
  else if (d.goclass && user?.role === "admin") { view = d.goclass; detail = null; store.set("st.view", view); render(); scrollTo({ top: 0, behavior: "smooth" }); }
  else if (d.person) {
    const p = peopleAll.find(x => x.id === d.person);
    if (p && view === "all") { view = p.classId; }
    detail = d.person; render();
    document.querySelector("[data-close-detail]")?.closest(".chart")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  else if ("closeDetail" in d) { detail = null; render(); }
});
document.addEventListener("change", e => { if (e.target.id === "view") { view = e.target.value; detail = null; store.set("st.view", view); render(); } });
document.addEventListener("submit", e => {
  if (e.target.id !== "limitsForm") return;
  e.preventDefault();
  const f = e.target, max = Math.max(1, Math.min(2000, Number(f.max.value) || DEFAULT_LIMITS.maxOvertime)), share = Math.max(0, Math.min(100, Number(f.share.value) || 0));
  run(() => be.set("settings", "limits", { maxOvertime: max, share200: share, period: f.period.value }));
});
// Tooltip
document.addEventListener("mousemove", e => {
  const el = e.target.closest?.("[data-tip]"), tip = $("#tip");
  if (!el) { tip.hidden = true; return; }
  tip.textContent = el.dataset.tip; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(e.clientX + 14, innerWidth - w - 8) + "px";
  tip.style.top = (e.clientY + 16 + h > innerHeight ? e.clientY - h - 10 : e.clientY + 16) + "px";
});

start({
  page: "statisztika.html",
  onUser(backend, u) {
    be = backend; user = u;
    watched = u.role === "admin" ? CLASSES.map(c => c.id) : [u.classId];
    view = u.role === "admin" ? (store.get("st.view") || "all") : u.classId;
    peopleAll = []; rosterBy = {}; offers = []; requests = []; settingsBy = {};
    subs.other.push(
      be.watch("people", u.role === "admin" ? [] : [["classId", "==", u.classId]], d => { peopleAll = d; schedule(); }, showError),
      ...watched.map(cid => be.watchDoc("classSettings", cid, d => { settingsBy[cid] = d || { target: DEFAULT_TARGET }; schedule(); }, showError)),
      be.watchDoc("settings", "rotation", d => { rotation = d && d.order ? d : null; schedule(); }, showError),
      be.watchDoc("settings", "limits", d => { limits = { ...DEFAULT_LIMITS, ...(d || {}) }; resubscribe(); schedule(); }, showError)
    );
    resubscribe(); render();
  },
  onLogout() {
    subs.other.forEach(u => u()); subs.other = []; subs.range.forEach(u => u()); subs.range = []; subs.rangeKey = "";
    Object.values(subs.months).forEach(u => u()); subs.months = {}; user = null;
  }
});
