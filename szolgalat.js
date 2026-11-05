// Szolgálatbeosztás – az osztályvezető a saját osztályát szerkeszti; a szolgálatvezetés mindet látja (csak olvasás).
import { CLASSES, ROLES, CODES, PATTERNS, SHIFT_CODE, OVERTIME_200_WINDOW_HOURS, DEFAULT_TARGET, KERET } from "./config.js";
import { DELETE, NOW } from "./backend.js";
import {
  $, esc, className, color, store, run, showError, start, today, addDays, range, monthsIn, monthKey, weekday, isHoliday,
  isWorkday, keretOf, parse, fmtDate, DAYS_SHORT, lastOfMonth, dutyClassOf
} from "./common.js";

const MONTH_NAMES = ["január", "február", "március", "április", "május", "június", "július", "augusztus", "szeptember", "október", "november", "december"];
const LENGTHS = [["7", "1 hét"], ["14", "2 hét"], ["month", "Hónap"], ["keret", "4 havi keret"]];
// Kódok a megszokott sorrendben (a "24" különben előre kerülne)
const CODE_KEYS = [...["N", "É", "24", "K", "SZ", "B", "P"].filter(k => CODES[k]), ...Object.keys(CODES).filter(k => !["N", "É", "24", "K", "SZ", "B", "P"].includes(k))];
const KEYS = { n: "N", e: "É", "é": "É", "2": "24", k: "K", s: "SZ", b: "B", p: "P" };

let be, user, canEdit = false;
let me = null;                   // az éppen nézett osztály ("all" = összesítő)
let watched = [];                // mely osztályok adatait figyeljük
// Osztályonkénti tárolók
let rosterBy = {}, peopleAll = [], leavesAll = [], settingsBy = {};
// Az éppen nézett osztály nézete (syncView tölti)
let people = [];                 // "YYYY-MM" -> ...
let roster = {};                 // "YYYY-MM" -> cells { pid: { "DD": {c, t, p} } }
let offers = [];                 // embercsere felajánlások az időszakban (minden osztály)
let leaves = [];
let settings = { target: DEFAULT_TARGET };
let rotation = null;             // szolgálati sorrend { start, order }
let subs = { months: {}, other: [], offers: null, offersKey: "" };

function syncView() {
  roster = rosterBy[me] || {};
  people = peopleAll.filter(p => p.classId === me);
  leaves = leavesAll.filter(l => l.classId === me);
  settings = settingsBy[me] || { target: DEFAULT_TARGET };
}

// Nézet állapota
let tab = store.get("sz.tab") || "grid";
let gFrom = null, gLen = store.get("sz.len") || "month";
let keretDate = today();
let sel = null;                  // { pid, date }
let leaveFilter = "pending";

// ---------------------------------------------------------------- segédek
const cellOf = (pid, d) => roster[monthKey(d)]?.[pid]?.[d.slice(8)] || null;
const active = () => people.filter(p => p.active !== false).sort((a, b) => a.name.localeCompare(b.name, "hu"));
const personOf = id => people.find(p => p.id === id);
const at = (d, hhmm) => { const [h, m] = (hhmm || "07:00").split(":").map(Number); const x = parse(d); x.setHours(h, m, 0, 0); return x.getTime(); };
const H = 3600000;
const fmtH = h => (Math.round(h * 10) / 10).toString().replace(".", ",");
const classNo = id => CLASSES.findIndex(c => c.id === id) + 1;
const isDuty = (cid, d) => dutyClassOf(rotation, d) === cid;

function viewRange() {
  if (gLen === "month") { const m = monthKey(gFrom); return { from: m + "-01", to: lastOfMonth(m) }; }
  if (gLen === "keret") return keretOf(gFrom);
  return { from: gFrom, to: addDays(gFrom, Number(gLen) - 1) };
}

// Egy ember összes munkaesemény-e (saját + kölcsönadott), időrendben
function eventsOf(pid) {
  const ev = [];
  for (const m in roster) {
    const cells = roster[m]?.[pid]; if (!cells) continue;
    for (const dd in cells) {
      const v = cells[dd], code = CODES[v.c], d = `${m}-${dd}`;
      if (!code?.work) continue;
      const s = at(d, code.start);
      ev.push({ date: d, start: s, end: s + code.hours * H, hours: code.hours, ot: !!v.t, pct: v.p || null, code: v.c });
    }
  }
  for (const o of offers) {
    if (o.classId !== me || o.personId !== pid) continue;
    const c = SHIFT_CODE[o.shift], code = CODES[c]; if (!code) continue;
    const s = at(o.date, code.start);
    ev.push({ date: o.date, start: s, end: s + code.hours * H, hours: code.hours, ot: true, lent: true, to: o.toClassId, code: c });
  }
  return ev.sort((a, b) => a.start - b.start);
}
// Túlóra %: ha a saját (nem túlóra) szolgálat vége után X órán belül kezdődik → 200, különben 100
function pctOf(e, events) {
  if (e.pct) return e.pct;
  let prevEnd = null;
  for (const x of events) if (!x.ot && x.end <= e.start && (prevEnd == null || x.end > prevEnd)) prevEnd = x.end;
  return prevEnd != null && (e.start - prevEnd) / H < OVERTIME_200_WINDOW_HOURS ? 200 : 100;
}

// ---------------------------------------------------------------- adatok figyelése
function resubscribe() {
  const v = viewRange(), k = keretOf(keretDate);
  const lo = addDays(v.from < k.from ? v.from : k.from, -2);
  const hi = v.to > k.to ? v.to : k.to;
  const need = new Set(watched.flatMap(cid => monthsIn(lo, hi).map(m => `${cid}_${m}`)));
  for (const key in subs.months) if (!need.has(key)) {
    subs.months[key](); delete subs.months[key];
    const [cid, m] = key.split("_"); if (rosterBy[cid]) delete rosterBy[cid][m];
  }
  for (const key of need) if (!subs.months[key]) {
    const [cid, m] = key.split("_");
    subs.months[key] = be.watchDoc("roster", key, d => { (rosterBy[cid] ||= {})[m] = d?.cells || {}; render(); }, showError);
  }
  const key = lo + "|" + hi;
  if (key !== subs.offersKey) {
    subs.offers && subs.offers();
    subs.offersKey = key;
    subs.offers = be.watch("offers", [["date", ">=", lo], ["date", "<=", hi]], d => { offers = d; render(); }, showError);
  }
}

// ---------------------------------------------------------------- írás
function cellWrite(pid, d, val) {
  const m = monthKey(d);
  return { col: "roster", id: `${me}_${m}`, op: "set", merge: true,
    data: { classId: me, month: m, cells: { [pid]: { [d.slice(8)]: val || DELETE } } } };
}
const setCell = (pid, d, val) => run(() => be.batch([cellWrite(pid, d, val)]));

// Több cella egyszerre (havonta egy írás)
function cellsWrites(list) {      // list: [{pid, date, val}]
  const byMonth = {};
  for (const { pid, date, val } of list) {
    const m = monthKey(date);
    byMonth[m] ||= { classId: me, month: m, cells: {} };
    (byMonth[m].cells[pid] ||= {})[date.slice(8)] = val || DELETE;
  }
  return Object.entries(byMonth).map(([m, data]) => ({ col: "roster", id: `${me}_${m}`, op: "set", merge: true, data }));
}

// ---------------------------------------------------------------- megjelenítés
function render() {
  if (!me) return;
  syncView();
  if (user.role === "admin") {
    $("#adminBar").hidden = false;
    $("#viewClass").innerHTML = `<option value="all">Összesítő – minden osztály</option>` + CLASSES.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    $("#viewClass").value = me;
    $("#rotInfo").textContent = rotation ? `Sorrend: ${rotation.order.map(c => className(c)).join(" → ")} (${rotation.start.replaceAll("-", ".")}.-tól)` : "Még nincs szolgálati sorrend beállítva.";
  }
  if (me === "all") tab = "grid";
  document.querySelectorAll("#tabs button").forEach(b => b.hidden = me === "all" && b.dataset.tab !== "grid");
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  ["grid", "keret", "leave", "people"].forEach(t => $("#tab-" + t).hidden = t !== tab);
  const pending = leaves.filter(l => l.status === "függő").length;
  $("#leaveCount").hidden = !pending; $("#leaveCount").textContent = pending;
  if (tab === "grid") me === "all" ? renderOverview() : renderGrid();
  if (tab === "keret") renderKeret();
  if (tab === "leave") renderLeaves();
  if (tab === "people") renderPeople();
}

function renderGrid() {
  const { from, to } = viewRange();
  $("#gFrom").value = gFrom;
  $("#gLen").innerHTML = LENGTHS.map(([k, t]) => `<button type="button" data-len="${k}" class="${k === gLen ? "on" : ""}">${t}</button>`).join("");
  if (document.activeElement !== $("#gTarget")) $("#gTarget").value = settings.target ?? DEFAULT_TARGET;
  $("#gTarget").disabled = !canEdit;
  $("#gridWrap").classList.toggle("readonly", !canEdit);
  const days = range(from, to), t0 = today(), target = Number(settings.target ?? DEFAULT_TARGET);
  const dayCls = d => [weekday(d) === 0 || weekday(d) === 6 ? "we" : "", isHoliday(d) ? "hol" : "", d === t0 ? "today" : "", isDuty(me, d) ? "duty" : ""].join(" ");

  // Fejléc: hónapok és napok
  const monthSpans = []; for (const d of days) { const m = monthKey(d); const last = monthSpans[monthSpans.length - 1]; if (last && last.m === m) last.n++; else monthSpans.push({ m, n: 1 }); }
  const headMonths = `<tr class="months"><th class="name"></th>${monthSpans.map(s => `<th colspan="${s.n}">${s.m.slice(0, 4)}. ${MONTH_NAMES[Number(s.m.slice(5)) - 1]}</th>`).join("")}</tr>`;
  const headDays = `<tr class="days"><th class="name">Név</th>${days.map(d => `<th class="${dayCls(d)}">${Number(d.slice(8))}<small>${DAYS_SHORT[weekday(d)]}</small></th>`).join("")}</tr>`;

  // Kölcsönadott események gyors kereséshez
  const lent = {};
  for (const o of offers) if (o.classId === me && o.personId) (lent[o.personId + o.date] ||= []).push(o);

  const ppl = active();
  const rows = ppl.map(p => {
    const cells = days.map(d => {
      const v = cellOf(p.id, d), code = v && CODES[v.c], l = lent[p.id + d] || [];
      const isSel = sel && sel.pid === p.id && sel.date === d;
      const bg = code ? `background:${code.color};color:#1d2330` : "";
      const lentHtml = l.map(o => `<span class="lent" title="Kölcsönadva: ${esc(className(o.toClassId))}, ${esc(o.shift)}">${SHIFT_CODE[o.shift]}→${classNo(o.toClassId)}</span>`).join("");
      return `<td class="cell ${dayCls(d)} ${v?.t || l.length ? "ot" : ""} ${isSel ? "sel" : ""}" style="${bg}" data-pid="${p.id}" data-date="${d}"
        title="${esc(p.name)} · ${d}${code ? " · " + code.label : ""}${v?.t ? " · túlóra" : ""}">${v ? esc(v.c) + (v.t ? "+" : "") : ""}${lentHtml}</td>`;
    }).join("");
    return `<tr><td class="name" title="${esc(p.name)}">${esc(p.name)}<small>${p.pattern}h${p.role ? " · " + esc(p.role) : ""}</small>${canEdit ? `<button data-fill="${p.id}" title="Kitöltés mintával">⋯</button>` : ""}</td>${cells}</tr>`;
  }).join("");

  // Kölcsönkapott emberek (más osztálytól)
  const recv = offers.filter(o => o.toClassId === me);
  const groups = {};
  for (const o of recv) (groups[o.classId + "|" + o.person] ||= []).push(o);
  const recvRows = Object.entries(groups).map(([k, list]) => {
    const [cid, name] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    const by = {}; list.forEach(o => (by[o.date] ||= []).push(SHIFT_CODE[o.shift]));
    return `<tr class="borrowed"><td class="name"><span class="dot" style="--clr:${color(cid)}"></span>${esc(name)}<small>${esc(className(cid))}</small></td>
      ${days.map(d => { const c = by[d]; const code = c && CODES[c[0]]; return `<td class="cell ${dayCls(d)}" style="${code ? `background:${code.color};color:#1d2330` : ""}">${c ? c.join("/") : ""}</td>`; }).join("")}</tr>`;
  }).join("");

  // Napi létszám
  const countRow = days.map(d => countCell(me, d, target)).join("");

  $("#gridWrap").style.setProperty("--clr", color(me));
  $("#gridWrap").innerHTML = ppl.length ? `<table class="grid"><thead>${headMonths}${headDays}</thead><tbody>
      ${rows}
      ${recvRows ? `<tr class="section"><td class="name">Kölcsönkapott</td><td colspan="${days.length}"></td></tr>${recvRows}` : ""}
      <tr class="count"><td class="name">Létszám / nap <small>cél: ${target}</small></td>${countRow}</tr>
    </tbody></table>`
    : `<div class="empty-list">Még nincs ember felvéve. Az <b>Emberek</b> fülön tudod felvinni őket.</div>`;

  $("#legend").innerHTML = CODE_KEYS.map(k => [k, CODES[k]]).map(([k, c]) => `<span><b style="background:${c.color};color:#1d2330">${k}</b>${c.label}${c.hours ? ` (${c.hours}h)` : ""}</span>`).join("") +
    `<span><b style="box-shadow:inset 0 0 0 2px #e08a00">N+</b>túlóra</span><span><b style="color:#b45309">É→4</b>kölcsönadva a 4. osztálynak</span>
     <span><b class="low">12</b>cél alatt</span><span><b class="okc">15</b>pont annyi</span><span><b class="high">17</b>több</span>
     ${rotation ? `<span><b style="background:color-mix(in srgb, ${color(me)} 22%, transparent)">▔</b>az osztály szolgálati napja (7–7) – a létszámot csak ezeken a napokon színezi</span>` : `<span>Még nincs szolgálati sorrend beállítva (a szolgálatvezetés állítja be).</span>`}`;
  renderEditor();
}

// Egy osztály létszáma egy napon (saját szolgálatban lévők + kölcsönkapottak)
function headcount(cid, d) {
  const r = rosterBy[cid] || {}, cells = r[monthKey(d)] || {}, dd = d.slice(8);
  let day = 0, night = 0, total = 0;
  for (const p of peopleAll) {
    if (p.classId !== cid || p.active === false) continue;
    const v = cells[p.id]?.[dd]; if (!v || !CODES[v.c]?.duty) continue;
    total++;
    if (v.c === "N" || v.c === "24") day++;
    if (v.c === "É" || v.c === "24") night++;
  }
  for (const o of offers) if (o.toClassId === cid && o.date === d) { total++; if (o.shift === "Nappal") day++; else night++; }
  return { total, day, night };
}
function countCell(cid, d, target) {
  const { total, day, night } = headcount(cid, d);
  const off = rotation && !isDuty(cid, d);
  const cls = off ? "off" : !target ? "" : total < target ? "low" : total === target ? "okc" : "high";
  return `<td class="${cls}" title="${className(cid)} · ${d}: ${total} fő (cél: ${target}) · Nappal ${day} · Éjszaka ${night}">${total}</td>`;
}

// Összesítő: a 4 osztály napi létszáma egymás alatt
function renderOverview() {
  const { from, to } = viewRange();
  $("#gFrom").value = gFrom;
  $("#gLen").innerHTML = LENGTHS.map(([k, t]) => `<button type="button" data-len="${k}" class="${k === gLen ? "on" : ""}">${t}</button>`).join("");
  $("#gTarget").value = ""; $("#gTarget").disabled = true;
  const days = range(from, to), t0 = today();
  const dayCls = d => [weekday(d) === 0 || weekday(d) === 6 ? "we" : "", isHoliday(d) ? "hol" : "", d === t0 ? "today" : ""].join(" ");
  const monthSpans = []; for (const d of days) { const m = monthKey(d); const last = monthSpans[monthSpans.length - 1]; if (last && last.m === m) last.n++; else monthSpans.push({ m, n: 1 }); }
  const headMonths = `<tr class="months"><th class="name"></th>${monthSpans.map(s => `<th colspan="${s.n}">${s.m.slice(0, 4)}. ${MONTH_NAMES[Number(s.m.slice(5)) - 1]}</th>`).join("")}</tr>`;
  const headDays = `<tr class="days"><th class="name">Osztály</th>${days.map(d => `<th class="${dayCls(d)}">${Number(d.slice(8))}<small>${DAYS_SHORT[weekday(d)]}</small></th>`).join("")}</tr>`;
  const rows = CLASSES.map(c => {
    const target = Number(settingsBy[c.id]?.target ?? DEFAULT_TARGET);
    const n = peopleAll.filter(p => p.classId === c.id && p.active !== false).length;
    return `<tr><td class="name" data-goclass="${c.id}" title="Megnyitás"><span class="dot" style="--clr:${color(c.id)}"></span>${esc(c.name)}<small>${n} fő · cél ${target}</small></td>${days.map(d => countCell(c.id, d, target)).join("")}</tr>`;
  }).join("");
  const totals = days.map(d => `<td class="${dayCls(d)}" style="font-weight:700">${CLASSES.reduce((a, c) => a + headcount(c.id, d).total, 0)}</td>`).join("");
  const dutyRow = rotation ? `<tr class="dutyrow"><td class="name" style="color:var(--text)">Szolgálatban (7–7)</td>${days.map(d => { const c = dutyClassOf(rotation, d); return `<td style="background:${color(c)}" title="${d}: ${esc(className(c))}">${classNo(c)}</td>`; }).join("")}</tr>` : "";
  $("#gridWrap").innerHTML = `<table class="grid overview"><thead>${headMonths}${headDays}</thead><tbody>${dutyRow}${rows}
    <tr class="section"><td class="name">Összesen</td>${totals}</tr></tbody></table>`;
  $("#legend").innerHTML = `<span>Napi létszám osztályonként (saját + kölcsönkapott). ${rotation ? "Színezve csak az osztály szolgálati napján." : ""}</span><span><b class="low">12</b>cél alatt</span><span><b class="okc">15</b>pont annyi</span><span><b class="high">17</b>több</span><span>Osztálynévre kattintva megnyílik az osztály beosztása.</span>`;
  $("#editor").hidden = true;
}

function renderEditor() {
  const ed = $("#editor");
  if (!sel || tab !== "grid" || !canEdit) { ed.hidden = true; return; }
  const p = personOf(sel.pid); if (!p) { ed.hidden = true; return; }
  const v = cellOf(sel.pid, sel.date);
  let pctInfo = "";
  if (v?.t) {
    const evs = eventsOf(sel.pid); const e = evs.find(x => x.date === sel.date && !x.lent);
    if (e) pctInfo = `automatikusan: ${pctOf({ ...e, pct: null }, evs)}%`;
  }
  ed.hidden = false;
  ed.innerHTML = `<span class="who">${esc(p.name)} · ${fmtDate(sel.date)}</span>
    <span class="codes row" style="gap:4px">${CODE_KEYS.map(k => `<button data-code="${k}" class="${v?.c === k ? "primary" : ""}" style="${v?.c === k ? "" : `background:${CODES[k].color};color:#1d2330`}">${k}</button>`).join("")}
      <button data-code="">Üres</button></span>
    <label style="flex-direction:row;align-items:center;gap:6px;font-size:14px;color:var(--text)"><input type="checkbox" id="edOt" ${v?.t ? "checked" : ""} ${v && CODES[v.c]?.work ? "" : "disabled"}> Túlóra</label>
    <select id="edPct" ${v?.t ? "" : "disabled"} title="Túlóra-pótlék">
      <option value="">% automatikus</option><option value="100" ${v?.p === 100 ? "selected" : ""}>100%</option><option value="200" ${v?.p === 200 ? "selected" : ""}>200%</option>
    </select>
    <span class="muted" style="font-size:12px">${pctInfo}</span>
    <span class="grow" style="flex:1"></span>
    <span class="muted" style="font-size:12px">Billentyűk: N, E, 2 (24), K, S, B, P · Del törlés · + túlóra · nyilak</span>
    <button id="edClose">✕</button>`;
}

// ---------------------------------------------------------------- keret és túlóra
function keretStats() {
  const { from, to } = keretOf(keretDate);
  const days = range(from, to);
  const norm = days.filter(isWorkday).length * KERET.hoursPerWorkday;
  return people.slice().sort((a, b) => a.name.localeCompare(b.name, "hu")).map(p => {
    const evs = eventsOf(p.id);
    let regular = 0, ot100 = 0, ot200 = 0, lentH = 0, credit = 0, sz = 0, b = 0;
    for (const e of evs) {
      if (e.date < from || e.date > to) continue;
      if (!e.ot) regular += e.hours;
      else { const pc = pctOf(e, evs); if (pc === 200) ot200 += e.hours; else ot100 += e.hours; if (e.lent) lentH += e.hours; }
    }
    for (const d of days) {
      const v = cellOf(p.id, d); if (!v) continue;
      if (CODES[v.c]?.absence) { if (v.c === "SZ") sz++; if (v.c === "B") b++; if (isWorkday(d)) credit += KERET.hoursPerWorkday; }
    }
    return { p, norm, regular, credit, balance: regular + credit - norm, ot100, ot200, lentH, sz, b };
  });
}

function renderKeret() {
  const { from, to } = keretOf(keretDate);
  $("#kLabel").textContent = `${from.replaceAll("-", ".")}. – ${to.replaceAll("-", ".")}.`;
  const rows = keretStats();
  const sum = k => rows.reduce((a, r) => a + r[k], 0);
  const sign = v => `<span class="${v > 0 ? "pos" : v < 0 ? "neg" : ""}">${v > 0 ? "+" : ""}${fmtH(v)}</span>`;
  $("#keretTable").innerHTML = rows.length ? `<table class="plain"><thead><tr>
      <th>Név</th><th>Munkarend</th><th class="num">Kötelező óra</th><th class="num">Beosztott óra</th><th class="num">Távollét jóváírás</th>
      <th class="num">Egyenleg</th><th class="num">Túlóra 100%</th><th class="num">Túlóra 200%</th><th class="num">ebből kölcsönadva</th><th class="num">Szabadság nap</th><th class="num">Beteg nap</th></tr></thead>
    <tbody>${rows.map(r => `<tr${r.p.active === false ? ' class="muted"' : ""}><td>${esc(r.p.name)}</td><td>${r.p.pattern} órás</td>
      <td class="num">${fmtH(r.norm)}</td><td class="num">${fmtH(r.regular)}</td><td class="num">${fmtH(r.credit)}</td><td class="num">${sign(r.balance)}</td>
      <td class="num">${fmtH(r.ot100)}</td><td class="num">${fmtH(r.ot200)}</td><td class="num">${fmtH(r.lentH)}</td><td class="num">${r.sz}</td><td class="num">${r.b}</td></tr>`).join("")}
      <tr><td><b>Összesen</b></td><td></td><td></td><td class="num"><b>${fmtH(sum("regular"))}</b></td><td class="num"><b>${fmtH(sum("credit"))}</b></td><td></td>
      <td class="num"><b>${fmtH(sum("ot100"))}</b></td><td class="num"><b>${fmtH(sum("ot200"))}</b></td><td class="num"><b>${fmtH(sum("lentH"))}</b></td><td class="num"><b>${sum("sz")}</b></td><td class="num"><b>${sum("b")}</b></td></tr>
    </tbody></table>` : `<div class="empty-list">Még nincs ember felvéve.</div>`;
  $("#keretHelp").innerHTML = `<b>Kötelező óra</b> = a keret munkanapjai × ${KERET.hoursPerWorkday} óra (hétvége és ünnepnap nélkül).
    <b>Távollét jóváírás</b> = munkanapra eső szabadság/betegség × ${KERET.hoursPerWorkday} óra.
    <b>Egyenleg</b> = beosztott + jóváírás − kötelező (a túlóra nincs benne).
    <b>Túlóra</b>: a „+” jelű szolgálatok és a más osztálynak kölcsönadott szolgálatok. 200%, ha a saját szolgálat vége után
    ${OVERTIME_200_WINDOW_HOURS} órán belül kezdődik, különben 100% (cellánként felülírható).`;
}

// ---------------------------------------------------------------- szabadságkérelmek
function renderLeaves() {
  $("#lStatus").innerHTML = [["pending", "Függő"], ["all", "Mind"]].map(([k, t]) => `<button type="button" data-lf="${k}" class="${k === leaveFilter ? "on" : ""}">${t}</button>`).join("");
  const list = leaves.filter(l => leaveFilter === "all" || l.status === "függő")
    .sort((a, b) => (a.status === "függő" ? 0 : 1) - (b.status === "függő" ? 0 : 1) || a.from.localeCompare(b.from));
  const badge = s => s === "jóváhagyva" ? '<span class="badge done">jóváhagyva</span>' : s === "elutasítva" ? '<span class="badge no">elutasítva</span>' : '<span class="badge open">függő</span>';
  $("#leaveTable").innerHTML = list.length ? `<table class="plain"><thead><tr><th>Név</th><th>Mettől</th><th>Meddig</th><th class="num">Nap</th><th>Típus</th><th>Megjegyzés</th><th>Állapot</th><th></th></tr></thead><tbody>
    ${list.map(l => `<tr><td>${esc(l.personName)}</td><td>${fmtDate(l.from)}</td><td>${fmtDate(l.to)}</td><td class="num">${range(l.from, l.to).length}</td>
      <td>${esc(l.kind)}</td><td style="white-space:normal">${esc(l.note)}</td><td>${badge(l.status)}</td>
      <td style="white-space:nowrap">${!canEdit ? "" : l.status === "függő" ? `<button class="give small" data-approve="${l.id}">Jóváhagy</button> <button class="small danger" data-reject="${l.id}">Elutasít</button>` : ""}
      ${canEdit ? `<button class="del" data-delleave="${l.id}" title="Törlés">✕</button>` : ""}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty-list">${leaveFilter === "pending" ? "Nincs elbírálásra váró kérelem." : "Még nincs kérelem."}</div>`;
}

// ---------------------------------------------------------------- emberek
function renderPeople() {
  document.querySelector("#tab-people > .card").hidden = !canEdit;
  if (!canEdit) {
    const list = people.slice().sort((a, b) => a.name.localeCompare(b.name, "hu"));
    $("#peopleTable").innerHTML = list.length ? `<table class="plain"><thead><tr><th>Név</th><th>Munkarend</th><th>Beosztás</th><th>Aktív</th></tr></thead><tbody>
      ${list.map(p => `<tr${p.active === false ? ' class="muted"' : ""}><td>${esc(p.name)}</td><td>${p.pattern} órás</td><td>${esc(p.role || "–")}</td><td>${p.active !== false ? "igen" : "nem"}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty-list">Nincs felvett ember.</div>`;
    return;
  }
  if (!$("#pRole").options.length) $("#pRole").innerHTML = '<option value="">–</option>' + ROLES.map(r => `<option>${esc(r)}</option>`).join("");
  const list = people.slice().sort((a, b) => (a.active === false) - (b.active === false) || a.name.localeCompare(b.name, "hu"));
  $("#peopleTable").innerHTML = list.length ? `<table class="plain"><thead><tr><th>Név</th><th>Munkarend</th><th>Beosztás</th><th>Aktív</th><th></th></tr></thead><tbody>
    ${list.map(p => `<tr${p.active === false ? ' class="muted"' : ""}>
      <td><input value="${esc(p.name)}" data-pname="${p.id}" maxlength="80" style="width:100%;min-width:160px"></td>
      <td><select data-ppattern="${p.id}"><option value="12" ${p.pattern === "12" ? "selected" : ""}>12 órás</option><option value="24" ${p.pattern === "24" ? "selected" : ""}>24 órás</option></select></td>
      <td><select data-prole="${p.id}"><option value="">–</option>${ROLES.map(r => `<option ${p.role === r ? "selected" : ""}>${esc(r)}</option>`).join("")}</select></td>
      <td><input type="checkbox" data-pactive="${p.id}" ${p.active !== false ? "checked" : ""} title="Ha kiveszed a pipát, eltűnik a beosztásból, de az adatai megmaradnak"></td>
      <td><button class="del" data-pdel="${p.id}" title="Törlés">✕</button></td></tr>`).join("")}
    </tbody></table><p class="muted" style="font-size:13px">${people.filter(p => p.active !== false).length} aktív fő. A dolgozók ebből a névsorból választják ki magukat a szabadságkérelemnél.</p>`
    : `<div class="empty-list">Még nincs ember felvéve.</div>`;
}

// ---------------------------------------------------------------- felugró ablakok
function modal(html, onOk) {
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal">${html}<div class="actions"><button data-x>Mégse</button><button class="primary" data-ok>OK</button></div></div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.addEventListener("click", async e => {
    if (e.target === bg || e.target.dataset.x !== undefined) close();
    if (e.target.dataset.ok !== undefined) { if ((await onOk(bg)) !== false) close(); }
  });
  bg.querySelector("input,select")?.focus();
}

function openFill(pid) {
  const p = personOf(pid);
  const dutyPats = rotation ? (p.pattern === "24"
    ? [{ name: "Az osztály szolgálati napjain 24 óra (sorrend szerint)", duty: "24" }]
    : [{ name: "Szolgálati napokon nappal (N)", duty: "N" }, { name: "Szolgálati napokon éjszaka (É)", duty: "É" }]) : [];
  const pats = [...dutyPats, ...(PATTERNS[p.pattern] || [])];
  const { from, to } = viewRange();
  modal(`<h2>Kitöltés mintával – ${esc(p.name)}</h2>
    <div class="stack">
      <label>Minta <select id="fPat">${pats.map((x, i) => `<option value="${i}">${esc(x.name)}</option>`).join("")}</select></label>
      <label>Ezen a napon a minta ennyiedik napja <select id="fOff"></select></label>
      <div class="row"><label>Mettől <input type="date" id="fFrom" value="${from}"></label><label>Meddig <input type="date" id="fTo" value="${to}"></label></div>
      <label style="flex-direction:row;gap:6px;align-items:center;color:var(--text);font-size:14px"><input type="checkbox" id="fOver"> A már beírt napokat is felülírja (a szabadságot és betegséget nem)</label>
    </div>`, async bg => {
    const pat = pats[Number(bg.querySelector("#fPat").value)];
    const off = Number(bg.querySelector("#fOff").value), f = bg.querySelector("#fFrom").value, t = bg.querySelector("#fTo").value;
    const over = bg.querySelector("#fOver").checked;
    if (!pat || !f || !t || t < f) { alert("Ellenőrizd a dátumokat."); return false; }
    if (range(f, t).length > 400) { alert("Legfeljebb kb. 1 évet lehet egyszerre kitölteni."); return false; }
    const list = [];
    range(f, t).forEach((d, i) => {
      const cur = cellOf(pid, d);
      if (cur && (!over || CODES[cur.c]?.absence)) return;
      const c = pat.duty ? (isDuty(me, d) ? pat.duty : "P") : pat.cycle[(i + off) % pat.cycle.length];
      list.push({ pid, date: d, val: c === "P" && !over ? null : { c } });
    });
    await run(() => be.batch(cellsWrites(list.filter(x => x.val || cellOf(pid, x.date)))));
  });
  const fill = () => {
    const pat = pats[Number(document.querySelector("#fPat").value)];
    document.querySelector("#fOff").innerHTML = pat.duty ? '<option value="0">– (a sorrendből számolja)</option>' : pat.cycle.map((c, i) => `<option value="${i}">${i + 1}. nap (${c})</option>`).join("");
    document.querySelector("#fOff").disabled = !!pat.duty;
  };
  if (pats.length) { fill(); document.querySelector("#fPat").addEventListener("change", fill); }
}

// ---------------------------------------------------------------- export
function download(name, rows) {
  const q = v => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const blob = new Blob(["﻿" + rows.map(r => r.map(q).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportGrid() {
  const { from, to } = viewRange(), days = range(from, to);
  const rows = [["Név", "Munkarend", ...days]];
  for (const p of active()) rows.push([p.name, p.pattern + "h", ...days.map(d => {
    const v = cellOf(p.id, d);
    const l = offers.filter(o => o.classId === me && o.personId === p.id && o.date === d).map(o => `${SHIFT_CODE[o.shift]}→${classNo(o.toClassId)}`);
    return [v ? v.c + (v.t ? "+" : "") : "", ...l].filter(Boolean).join(" ");
  })]);
  download(`beosztas_${className(me).replace(/\W+/g, "_")}_${from}_${to}.csv`, rows);
}
function exportKeret() {
  const { from, to } = keretOf(keretDate);
  const rows = [["Név", "Munkarend", "Kötelező óra", "Beosztott óra", "Távollét jóváírás", "Egyenleg", "Túlóra 100%", "Túlóra 200%", "ebből kölcsönadva", "Szabadság nap", "Beteg nap"]];
  const n = v => String(Math.round(v * 10) / 10).replace(".", ",");
  for (const r of keretStats()) rows.push([r.p.name, r.p.pattern + "h", n(r.norm), n(r.regular), n(r.credit), n(r.balance), n(r.ot100), n(r.ot200), n(r.lentH), r.sz, r.b]);
  download(`keret_${className(me).replace(/\W+/g, "_")}_${from}_${to}.csv`, rows);
}

// ---------------------------------------------------------------- események
function moveSel(dx, dy) {
  if (!sel) return;
  const ppl = active(); const { from, to } = viewRange();
  let i = ppl.findIndex(p => p.id === sel.pid) + dy; i = Math.max(0, Math.min(ppl.length - 1, i));
  let d = addDays(sel.date, dx); if (d < from) d = from; if (d > to) d = to;
  sel = { pid: ppl[i].id, date: d };
  renderGrid();
  document.querySelector(`td.sel`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function applyCode(c) {
  if (!sel) return;
  const cur = cellOf(sel.pid, sel.date);
  const keepOt = cur?.t && CODES[c]?.work;
  setCell(sel.pid, sel.date, c ? { c, ...(keepOt ? { t: true } : {}), ...(keepOt && cur.p ? { p: cur.p } : {}) } : null);
}
function toggleOt() {
  if (!sel) return;
  const cur = cellOf(sel.pid, sel.date);
  if (!cur || !CODES[cur.c]?.work) return showError("Túlórának csak szolgálatot (N, É, 24, K) lehet jelölni.");
  setCell(sel.pid, sel.date, cur.t ? { c: cur.c } : { c: cur.c, t: true });
}

function wire() {
  document.addEventListener("click", e => {
    const t = e.target.closest("button, td.cell") || e.target;
    const d = t.dataset || {};
    if (d.tab) { tab = d.tab; store.set("sz.tab", tab); render(); }
    else if (d.len) { gLen = d.len; store.set("sz.len", gLen); resubscribe(); render(); }
    else if (t.id === "gPrev" || t.id === "gNext") {
      const dir = t.id === "gPrev" ? -1 : 1;
      if (gLen === "month") { const x = parse(monthKey(gFrom) + "-01"); x.setMonth(x.getMonth() + dir); gFrom = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-01`; }
      else if (gLen === "keret") { const k = keretOf(gFrom); gFrom = dir < 0 ? keretOf(addDays(k.from, -1)).from : addDays(k.to, 1); }
      else gFrom = addDays(gFrom, dir * Number(gLen));
      resubscribe(); render();
    }
    else if (t.id === "gToday") { gFrom = today(); resubscribe(); render(); }
    else if (t.id === "gExport") exportGrid();
    else if (t.id === "gPrint") window.print();
    else if (t.id === "kPrev" || t.id === "kNext") {
      const k = keretOf(keretDate); keretDate = t.id === "kPrev" ? addDays(k.from, -1) : addDays(k.to, 1); resubscribe(); render();
    }
    else if (t.id === "kExport") exportKeret();
    else if (t.id === "rotEdit" && user?.role === "admin") openRotation();
    else if (t.matches?.("td.cell") && d.pid) { if (canEdit) { sel = { pid: d.pid, date: d.date }; renderGrid(); } }
    else if (e.target.closest?.("[data-goclass]")) { me = e.target.closest("[data-goclass]").dataset.goclass; render(); }
    else if (d.code !== undefined) applyCode(d.code);
    else if (t.id === "edClose") { sel = null; renderGrid(); }
    else if (d.fill) openFill(d.fill);
    else if (d.lf) { leaveFilter = d.lf; render(); }
    else if (d.approve) approveLeave(d.approve);
    else if (d.reject) { const l = leaves.find(x => x.id === d.reject); if (confirm(`Elutasítod ${l.personName} kérelmét?`)) run(() => be.update("leave", l.id, { status: "elutasítva", decidedAt: NOW })); }
    else if (d.delleave) { const l = leaves.find(x => x.id === d.delleave); if (confirm(`Törlöd ${l.personName} kérelmét? (A beosztásba már beírt SZ megmarad.)`)) run(() => be.remove("leave", l.id)); }
    else if (d.pdel) {
      const p = personOf(d.pdel);
      if (confirm(`Törlöd: ${p.name}?\nHa csak nem dolgozik már itt, inkább vedd ki az „Aktív” pipát – úgy a korábbi adatai megmaradnak.`)) run(() => be.remove("people", p.id));
    }
  });
  document.addEventListener("change", e => {
    const t = e.target, d = t.dataset;
    if (t.id === "viewClass") { me = t.value; sel = null; store.set("sz.view", me); render(); }
    else if (t.id === "gFrom" && t.value) { gFrom = t.value; resubscribe(); render(); }
    else if (t.id === "gTarget") { const v = Math.max(0, Math.min(999, Number(t.value) || 0)); run(() => be.set("classSettings", me, { classId: me, target: v }, true)); }
    else if (t.id === "edOt") toggleOt();
    else if (t.id === "edPct") { const cur = cellOf(sel.pid, sel.date); const p = Number(t.value) || null; setCell(sel.pid, sel.date, { c: cur.c, t: true, ...(p ? { p } : {}) }); }
    else if (d.pname) { const v = t.value.trim(); if (v) run(() => be.update("people", d.pname, { name: v })); }
    else if (d.ppattern) run(() => be.update("people", d.ppattern, { pattern: t.value }));
    else if (d.prole !== undefined) run(() => be.update("people", d.prole, { role: t.value }));
    else if (d.pactive) run(() => be.update("people", d.pactive, { active: t.checked }));
  });
  document.addEventListener("keydown", e => {
    if (!canEdit || !sel || tab !== "grid" || e.target.matches?.("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (KEYS[k]) { e.preventDefault(); applyCode(KEYS[k]); moveSel(1, 0); }
    else if (k === "delete" || k === "backspace") { e.preventDefault(); applyCode(""); moveSel(1, 0); }
    else if (k === "+" || k === "t") { e.preventDefault(); toggleOt(); }
    else if (k === "arrowright") { e.preventDefault(); moveSel(1, 0); }
    else if (k === "arrowleft") { e.preventDefault(); moveSel(-1, 0); }
    else if (k === "arrowdown") { e.preventDefault(); moveSel(0, 1); }
    else if (k === "arrowup") { e.preventDefault(); moveSel(0, -1); }
    else if (k === "escape") { sel = null; renderGrid(); }
  });

  $("#pForm").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target, name = f.name.value.trim();
    if (!name) return;
    run(async () => { await be.add("people", { classId: me, name, pattern: f.pattern.value, role: f.role.value, active: true, createdAt: NOW }); f.name.value = ""; f.name.focus(); });
  });
  $("#pBulk").addEventListener("submit", e => {
    e.preventDefault();
    const names = $("#pBulkText").value.split("\n").map(s => s.trim()).filter(Boolean).slice(0, 200);
    if (!names.length) return;
    const pattern = $("#pBulkPattern").value;
    run(async () => {
      for (const name of names) await be.add("people", { classId: me, name: name.slice(0, 80), pattern, role: "", active: true, createdAt: NOW });
      $("#pBulkText").value = "";
    });
  });
}

function openRotation() {
  let order = rotation?.order?.length ? [...rotation.order] : CLASSES.map(c => c.id);
  const draw = () => {
    document.querySelector("#rotList").innerHTML = order.map((cid, i) => `<div style="--clr:${color(cid)}"><span>${i + 1}.</span><b>${esc(className(cid))}</b>
      <button type="button" class="small" data-up="${i}" ${i ? "" : "disabled"}>▲</button><button type="button" class="small" data-down="${i}" ${i < order.length - 1 ? "" : "disabled"}>▼</button></div>`).join("");
    const st = document.querySelector("#rotStart").value;
    document.querySelector("#rotPreview").innerHTML = st ? "Így megy: " + range(st, addDays(st, 7)).map(d => `${d.slice(5).replace("-", ".")}. ${DAYS_SHORT[weekday(d)]}: <b>${classNo(order[((Math.round((parse(d) - parse(st)) / 86400000)) % order.length + order.length) % order.length])}</b>`).join(" · ") : "";
  };
  modal(`<h2>Szolgálati sorrend</h2>
    <div class="stack">
      <p class="muted" style="margin:0;font-size:14px">Minden nap egy osztály van szolgálatban, 7-től másnap 7-ig. Állítsd be a sorrendet és hogy melyik naptól indul.</p>
      <label>Ezen a napon az 1. helyen álló osztály van szolgálatban <input type="date" id="rotStart" value="${rotation?.start || today()}"></label>
      <div class="rot-list" id="rotList"></div>
      <div class="muted" style="font-size:13px" id="rotPreview"></div>
    </div>`, async bg => {
    const start = bg.querySelector("#rotStart").value;
    if (!start) { alert("Add meg a kezdőnapot."); return false; }
    await run(() => be.set("settings", "rotation", { start, order }));
  });
  const bg = document.querySelector(".modal-bg");
  bg.addEventListener("click", e => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.up) { const i = Number(t.dataset.up); [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw(); }
    if (t.dataset.down) { const i = Number(t.dataset.down); [order[i + 1], order[i]] = [order[i], order[i + 1]]; draw(); }
  });
  bg.querySelector("#rotStart").addEventListener("change", draw);
  draw();
}

function approveLeave(id) {
  const l = leaves.find(x => x.id === id);
  const days = range(l.from, l.to);
  modal(`<h2>Szabadság jóváhagyása</h2>
    <p>${esc(l.personName)}: ${fmtDate(l.from)} – ${fmtDate(l.to)} (${days.length} nap)</p>
    <label style="flex-direction:row;gap:6px;align-items:center;color:var(--text);font-size:14px"><input type="checkbox" id="aWrite" checked ${personOf(l.personId) ? "" : "disabled"}>
      Írja be az SZ-t a beosztásba ezekre a napokra (a betegséget nem írja felül)</label>
    ${personOf(l.personId) ? "" : '<p class="muted">Ez az ember már nincs a névsorban, ezért a beosztásba nem írható be.</p>'}`, async bg => {
    const write = bg.querySelector("#aWrite").checked && personOf(l.personId);
    const ops = [{ col: "leave", id: l.id, op: "update", data: { status: "jóváhagyva", decidedAt: NOW } }];
    if (write) ops.push(...cellsWrites(days.filter(d => cellOf(l.personId, d)?.c !== "B").map(d => ({ pid: l.personId, date: d, val: { c: "SZ" } }))));
    await run(() => be.batch(ops));
  });
}

// ---------------------------------------------------------------- indulás
start({
  page: "szolgalat.html",
  onUser(backend, u) {
    be = backend; user = u; canEdit = u.role === "leader";
    if (u.role === "admin") { watched = CLASSES.map(c => c.id); me = store.get("sz.view") || "all"; }
    else { watched = [u.classId]; me = u.classId; }
    gFrom = today(); keretDate = today();
    rosterBy = {}; offers = []; peopleAll = []; leavesAll = []; settingsBy = {};
    if (u.role === "admin") {
      // a szolgálatvezetés minden osztályt lát
      subs.other.push(
        be.watch("people", [], d => { peopleAll = d; render(); }, showError),
        be.watch("leave", [], d => { leavesAll = d; render(); }, showError),
        ...watched.map(cid => be.watchDoc("classSettings", cid, d => { settingsBy[cid] = d || { target: DEFAULT_TARGET }; render(); }, showError))
      );
    } else {
      subs.other.push(
        be.watch("people", [["classId", "==", me]], d => { peopleAll = d; render(); }, showError),
        be.watch("leave", [["classId", "==", me]], d => { leavesAll = d; render(); }, showError),
        be.watchDoc("classSettings", me, d => { settingsBy[me] = d || { target: DEFAULT_TARGET }; render(); }, showError)
      );
    }
    subs.other.push(be.watchDoc("settings", "rotation", d => { rotation = d && d.order ? d : null; render(); }, showError));
    resubscribe();
    render();
  },
  onLogout() {
    subs.other.forEach(u => u()); subs.other = [];
    Object.values(subs.months).forEach(u => u()); subs.months = {};
    subs.offers && subs.offers(); subs.offers = null; subs.offersKey = "";
    me = null; sel = null;
  }
});
wire();
