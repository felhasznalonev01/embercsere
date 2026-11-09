// Szolgálatvezénylés – az osztályvezető a saját osztályát szerkeszti; a szolgálatvezetés mindet látja (csak olvasás).
import { CLASSES, ROLES, CODES, PATTERNS, SHIFT_CODE, OVERTIME_200_WINDOW_HOURS, DEFAULT_TARGET, KERET, EXAMS, EXAM_WARN_DAYS, DEFAULT_LEAVE_DAYS, DEFAULT_TARGET_DAY, DEFAULT_TARGET_NIGHT } from "./config.js";
import { cellSpan, offerSpan, codeAllowed, targetsOf, headcount as hcCalc } from "./calc.js";
import { DELETE, NOW } from "./backend.js";
import {
  $, esc, className, color, store, run, showError, start, today, addDays, range, monthsIn, monthKey, weekday, isHoliday,
  isWorkday, keretOf, parse, fmtDate, DAYS_SHORT, lastOfMonth, dutyClassOf, daysBetween
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
let gFrom = null, gLen = store.get("sz.len") || (innerWidth < 700 ? "7" : "month");   // telefonon alapból 1 hét
let keretDate = today();
let sel = null;                  // { pid, date }
let leaveFilter = "pending";

// ---------------------------------------------------------------- segédek
const cellOf = (pid, d) => roster[monthKey(d)]?.[pid]?.[d.slice(8)] || null;
// Nevek sorrendje: "abc" vagy "custom" (osztályonként mentve, a saját sorrend az emberek "order" mezőjében)
const sortMode = () => settings.sortMode === "custom" ? "custom" : "abc";
const byOrder = (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.name.localeCompare(b.name, "hu");
const active = () => people.filter(p => p.active !== false).sort(sortMode() === "custom" ? byOrder : (a, b) => a.name.localeCompare(b.name, "hu"));
const personOf = id => people.find(p => p.id === id);
const at = (d, hhmm) => { const [h, m] = (hhmm || "07:00").split(":").map(Number); const x = parse(d); x.setHours(h, m, 0, 0); return x.getTime(); };
const H = 3600000;
const fmtH = h => (Math.round(h * 10) / 10).toString().replace(".", ",");
const classNo = id => CLASSES.findIndex(c => c.id === id) + 1;
const isDuty = (cid, d) => dutyClassOf(rotation, d) === cid;

// ---- Érvényességek (vizsgák) és szabadság
// állapot: "bad" = lejárt / nincs megadva, "warn" = hamarosan lejár, "" = rendben
function examState(dateStr) {
  if (!dateStr) return "none";
  const left = daysBetween(today(), dateStr);
  return left < 0 ? "bad" : left <= EXAM_WARN_DAYS ? "warn" : "";
}
function examProblems(p) {
  return EXAMS.map(x => ({ x, d: p.exams?.[x.id] || "", st: examState(p.exams?.[x.id]) })).filter(e => e.st === "bad" || e.st === "warn");
}
const fmtD = s => s ? s.replaceAll("-", ".") + "." : "–";
// Idén felhasznált szabadság: az idei SZ-ek száma a beosztásban
function leaveUsed(pid, year = today().slice(0, 4)) {
  let n = 0;
  for (const m in roster) if (m.startsWith(year)) for (const dd in roster[m]?.[pid] || {}) if (roster[m][pid][dd].c === "SZ") n++;
  return n;
}
// Időpont szövegesen: "7:00–19:00" / röviden "7–19"
function timeOf(code, short) {
  const c = CODES[code]; if (!c?.start || !c.hours) return "";
  const [h, m] = c.start.split(":").map(Number), e = (h * 60 + m + c.hours * 60) % 1440;
  const f = (x, mm) => short && !mm ? `${x}` : `${x}:${String(mm).padStart(2, "0")}`;
  return `${f(h, m)}–${f(Math.floor(e / 60), e % 60)}`;
}

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
      const v = cells[dd], d = `${m}-${dd}`, sp = cellSpan(d, v);
      if (!sp) continue;
      ev.push({ date: d, ...sp, ot: !!v.t, pct: v.p || null, code: v.c });
    }
  }
  for (const o of offers) {
    if (o.classId !== me || o.personId !== pid) continue;
    const sp = offerSpan(o); if (!sp) continue;
    ev.push({ date: o.date, ...sp, ot: true, lent: true, to: o.toClassId });
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
  const y = today().slice(0, 4);
  const months = new Set([...monthsIn(lo, hi), ...monthsIn(`${y}-01-01`, `${y}-12-31`)]);   // az egész év kell a szabadság-számításhoz
  const need = new Set(watched.flatMap(cid => [...months].map(m => `${cid}_${m}`)));
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
// Egy cella teljes értéke (a hiányzó mezőket törli, hogy összefésüléskor ne maradjon bent régi túlóra / időpont)
const fullCell = v => v ? { c: v.c, t: v.t ? true : DELETE, p: v.p || DELETE, s: v.s || DELETE, e: v.e || DELETE } : DELETE;
function cellWrite(pid, d, val) {
  const m = monthKey(d);
  return { col: "roster", id: `${me}_${m}`, op: "set", merge: true,
    data: { classId: me, month: m, cells: { [pid]: { [d.slice(8)]: fullCell(val) } } } };
}
const setCell = (pid, d, val) => run(() => be.batch([cellWrite(pid, d, val)]));

// Több cella egyszerre (havonta egy írás)
function cellsWrites(list) {      // list: [{pid, date, val}]
  const byMonth = {};
  for (const { pid, date, val } of list) {
    const m = monthKey(date);
    byMonth[m] ||= { classId: me, month: m, cells: {} };
    (byMonth[m].cells[pid] ||= {})[date.slice(8)] = fullCell(val);
  }
  return Object.entries(byMonth).map(([m, data]) => ({ col: "roster", id: `${me}_${m}`, op: "set", merge: true, data }));
}

// ---------------------------------------------------------------- megjelenítés
function render() {
  if (!me) return;
  syncView();
  linkOffers();
  $("#adminBar").hidden = user.role !== "admin";
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
  $("#gSort").innerHTML = [["abc", "ABC"], ["custom", "Saját"]].map(([k, t]) => `<button type="button" data-sort="${k}" class="${k === sortMode() ? "on" : ""}" ${canEdit ? "" : "disabled"}>${t}</button>`).join("");
  const tg = targetsOf(settings, DEFAULT_TARGET_DAY, DEFAULT_TARGET_NIGHT);
  if (document.activeElement !== $("#gTargetDay")) $("#gTargetDay").value = tg.day;
  if (document.activeElement !== $("#gTargetNight")) $("#gTargetNight").value = tg.night;
  $("#gTargetDay").disabled = $("#gTargetNight").disabled = !canEdit;
  $("#gridWrap").classList.toggle("readonly", !canEdit);
  const days = range(from, to), t0 = today();
  const dayCls = d => [weekday(d) === 0 || weekday(d) === 6 ? "we" : "", isHoliday(d) ? "hol" : "", d === t0 ? "today" : "", isDuty(me, d) ? "duty" : ""].join(" ");

  // Fejléc: hónapok és napok
  const monthSpans = []; for (const d of days) { const m = monthKey(d); const last = monthSpans[monthSpans.length - 1]; if (last && last.m === m) last.n++; else monthSpans.push({ m, n: 1 }); }
  const headMonths = `<tr class="months"><th class="name"></th>${monthSpans.map(s => `<th colspan="${s.n}">${s.m.slice(0, 4)}. ${MONTH_NAMES[Number(s.m.slice(5)) - 1]}</th>`).join("")}</tr>`;
  const headDays = `<tr class="days"><th class="name">Név</th>${days.map(d => `<th class="${dayCls(d)}" title="${isDuty(me, d) ? "Az osztály szolgálati napja: 7:00-tól másnap 7:00-ig" : ""}">${Number(d.slice(8))}<small>${DAYS_SHORT[weekday(d)]}</small>${isDuty(me, d) ? '<small class="dlbl">7–7</small>' : ""}</th>`).join("")}</tr>`;

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
      return `<td class="cell ${dayCls(d)} ${v?.t || l.length ? "ot" : ""} ${isSel ? "sel" : ""}" style="${bg}" data-pid="${p.id}" data-date="${d}" ${canEdit ? 'draggable="true"' : ""}
        title="${esc(p.name)} · ${d}${code ? " · " + code.label + " " + (v.s ? `${v.s}–${v.e}` : timeOf(v.c)) : ""}${v?.t ? " · túlóra" : ""}${canEdit ? "\nKattints a módosításhoz, vagy húzd át cseréhez" : ""}">${v ? esc(v.c) + (v.t ? "+" : "") : ""}${v?.s ? `<span class="tm">${shortT(v.s)}–${shortT(v.e)}</span>` : ""}${lentHtml}</td>`;
    }).join("");
    return `<tr data-row="${p.id}"><td class="name ${canEdit ? "clickable" : ""}" ${canEdit ? `data-person="${p.id}" draggable="true"` : ""} title="${esc(p.name)}${canEdit ? " – kattints az adataihoz, vagy húzd fel / le a sorrendhez" : ""}">${canEdit ? '<span class="grip">⠿</span>' : ""}${esc(p.name)}${(() => { const pr = examProblems(p); return pr.length ? `<span class="warn ${pr.some(e => e.st === "bad") ? "exp-bad" : "exp-warn"}" title="${esc(pr.map(e => `${e.x.label}: ${e.st === "bad" ? "LEJÁRT" : "hamarosan lejár"} (${fmtD(e.d)})`).join("\n"))}">⚠</span>` : ""; })()}<small>${p.pattern}h${p.role ? " · " + esc(p.role) : ""}</small>${canEdit ? `<button data-person="${p.id}" title="Szerkesztés">✎</button>` : ""}</td>${cells}</tr>`;
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

  // Napi létszám nappal / éjszaka
  const countDay = days.map(d => countCell(me, d, "day", tg.day)).join("");
  const countNight = days.map(d => countCell(me, d, "night", tg.night)).join("");

  $("#gridWrap").style.setProperty("--clr", color(me));
  $("#gridWrap").innerHTML = ppl.length ? `<table class="grid ${gLen === "keret" ? "" : "fit"}"><thead>${headMonths}${headDays}</thead><tbody>
      ${rows}
      ${recvRows ? `<tr class="section"><td class="name">Kölcsönkapott</td><td colspan="${days.length}"></td></tr>${recvRows}` : ""}
      <tr class="count cday"><td class="name">☀︎ Nappal 7–19 <small>cél: ${tg.day}</small></td>${countDay}</tr>
      <tr class="count"><td class="name">☾ Éjszaka 19–7 <small>cél: ${tg.night}</small></td>${countNight}</tr>
    </tbody></table>`
    : `<div class="empty-list">Még nincs ember felvéve. Az <b>Emberek</b> fülön tudod felvinni őket.</div>`;

  $("#gridHelp").innerHTML = canEdit
    ? `<div class="gridhelp"><span>✎ <b>Kattints egy cellára</b> a módosításhoz vagy törléshez</span><span>⇄ <b>Húzd át</b> a cellát egy másikra: a kettő helyet cserél</span><span>👤 <b>Kattints a névre</b> az ember adataihoz</span><span>⠿ <b>Húzd a nevet</b> fel / le: így állítod a sorrendet (megmarad)</span></div>`
    : `<div class="viewonly" id="viewonly">👁 <b>Csak megtekintés.</b> A beosztást az osztályvezetők szerkesztik – ehhez osztályvezetőként kell belépni.${be.isDemo ? " (Próbamódban: Kilépés → Ki vagy? → Osztályvezető.)" : ""}</div>`;
  $("#legend").innerHTML = CODE_KEYS.map(k => [k, CODES[k]]).map(([k, c]) => `<span><b style="background:${c.color};color:#1d2330">${k}</b>${c.label}${timeOf(k) ? ` ${timeOf(k)}` : ""}</span>`).join("") +
    `<span><b style="box-shadow:inset 0 0 0 2px #e08a00">N+</b>túlóra</span><span><b style="color:#b45309">É→4</b>kölcsönadva a 4. osztálynak</span>
     <span><b class="low">12</b>cél alatt</span><span><b class="okc">15</b>pont annyi</span><span><b class="high">17</b>több</span>
     <span>Létszám: nappalba az számít, aki 7–19 között legalább 6 órát, éjszakába, aki 19–7 között legalább 6 órát dolgozik (a 24 órás mindkettőbe)</span>
     ${rotation ? `<span><b style="background:color-mix(in srgb, ${color(me)} 22%, transparent)">▔</b>az osztály szolgálati napja (7–7) – a létszámot csak ezeken a napokon színezi</span>` : `<span>Még nincs szolgálati sorrend beállítva (a szolgálatvezetés állítja be).</span>`}`;
  renderEditor();
}

// Egy osztály létszáma egy napon (saját szolgálatban lévők + kölcsönkapottak)
function headcount(cid, d) { return hcCalc(cid, d, rosterBy[cid] || {}, peopleAll, offers); }
const levelOf = (n, t) => !t ? "" : n < t ? "low" : n === t ? "okc" : "high";
// Egy napszak létszáma (which: "day" | "night")
function countCell(cid, d, which, target) {
  const h = headcount(cid, d), n = h[which];
  const cls = rotation && !isDuty(cid, d) ? "off" : levelOf(n, target);
  return `<td class="${cls}" title="${className(cid)} · ${d} · ${which === "day" ? "nappal (7–19)" : "éjszaka (19–7)"}: ${n} fő (cél: ${target})">${n}</td>`;
}
// Összesítőhöz: "nappal/éjszaka", a rosszabbik szerint színezve
function countPairCell(cid, d, tg) {
  const h = headcount(cid, d);
  const a = levelOf(h.day, tg.day), b = levelOf(h.night, tg.night);
  const cls = rotation && !isDuty(cid, d) ? "off" : [a, b].includes("low") ? "low" : [a, b].includes("okc") ? "okc" : a || b;
  return `<td class="${cls}" title="${className(cid)} · ${d}\nNappal: ${h.day} (cél ${tg.day})\nÉjszaka: ${h.night} (cél ${tg.night})" style="font-size:11px">${h.day}/${h.night}</td>`;
}
const shortT = t => { const [h, m] = String(t).split(":"); return m === "00" ? String(Number(h)) : `${Number(h)}:${m}`; };

// Összesítő: a 4 osztály napi létszáma egymás alatt
function renderOverview() {
  const { from, to } = viewRange();
  $("#gFrom").value = gFrom;
  $("#gLen").innerHTML = LENGTHS.map(([k, t]) => `<button type="button" data-len="${k}" class="${k === gLen ? "on" : ""}">${t}</button>`).join("");
  $("#gTargetDay").value = $("#gTargetNight").value = ""; $("#gTargetDay").disabled = $("#gTargetNight").disabled = true;
  const days = range(from, to), t0 = today();
  const dayCls = d => [weekday(d) === 0 || weekday(d) === 6 ? "we" : "", isHoliday(d) ? "hol" : "", d === t0 ? "today" : ""].join(" ");
  const monthSpans = []; for (const d of days) { const m = monthKey(d); const last = monthSpans[monthSpans.length - 1]; if (last && last.m === m) last.n++; else monthSpans.push({ m, n: 1 }); }
  const headMonths = `<tr class="months"><th class="name"></th>${monthSpans.map(s => `<th colspan="${s.n}">${s.m.slice(0, 4)}. ${MONTH_NAMES[Number(s.m.slice(5)) - 1]}</th>`).join("")}</tr>`;
  const headDays = `<tr class="days"><th class="name">Osztály</th>${days.map(d => `<th class="${dayCls(d)}">${Number(d.slice(8))}<small>${DAYS_SHORT[weekday(d)]}</small></th>`).join("")}</tr>`;
  const rows = CLASSES.map(c => {
    const tg = targetsOf(settingsBy[c.id], DEFAULT_TARGET_DAY, DEFAULT_TARGET_NIGHT);
    const n = peopleAll.filter(p => p.classId === c.id && p.active !== false).length;
    return `<tr><td class="name" data-goclass="${c.id}" title="Megnyitás"><span class="dot" style="--clr:${color(c.id)}"></span>${esc(c.name)}<small>${n} fő · cél ${tg.day}/${tg.night}</small></td>${days.map(d => countPairCell(c.id, d, tg)).join("")}</tr>`;
  }).join("");
  const totals = days.map(d => `<td class="${dayCls(d)}" style="font-weight:700">${CLASSES.reduce((a, c) => a + headcount(c.id, d).total, 0)}</td>`).join("");
  const dutyRow = rotation ? `<tr class="dutyrow"><td class="name" style="color:var(--text)">Szolgálatban (7–7)</td>${days.map(d => { const c = dutyClassOf(rotation, d); return `<td style="background:${color(c)}" title="${d}: ${esc(className(c))}">${classNo(c)}</td>`; }).join("")}</tr>` : "";
  $("#gridWrap").innerHTML = `<table class="grid overview ${gLen === "keret" ? "" : "fit"}"><thead>${headMonths}${headDays}</thead><tbody>${dutyRow}${rows}
    <tr class="section"><td class="name">Összesen</td>${totals}</tr></tbody></table>`;
  $("#gridHelp").innerHTML = "";
  $("#legend").innerHTML = `<span>Napi létszám osztályonként: <b>nappal / éjszaka</b> (saját + kölcsönkapott). ${rotation ? "Színezve csak az osztály szolgálati napján." : ""}</span><span><b class="low">12</b>cél alatt</span><span><b class="okc">15</b>pont annyi</span><span><b class="high">17</b>több</span><span>Osztálynévre kattintva megnyílik az osztály beosztása.</span>`;
  $("#editor").hidden = true;
}

const endOf = code => { const c = CODES[code]; const [h, m] = c.start.split(":").map(Number); const e = (h * 60 + m + c.hours * 60) % 1440; return `${String(Math.floor(e / 60)).padStart(2, "0")}:${String(e % 60).padStart(2, "0")}`; };
function renderEditor() {
  const ed = $("#editor");
  if (!sel || tab !== "grid" || !canEdit) { ed.hidden = true; return; }
  const p = personOf(sel.pid); if (!p) { ed.hidden = true; return; }
  const v = cellOf(sel.pid, sel.date);
  let pctInfo = "";
  if (v?.t) {
    const evs = eventsOf(sel.pid); const e = evs.find(x => x.date === sel.date && !x.lent);
    if (e) pctInfo = `automatikusan ${pctOf({ ...e, pct: null }, evs)}%`;
  }
  ed.hidden = false;
  ed.innerHTML = `<div class="ed-head"><div><b>${esc(p.name)}</b><small>${fmtDate(sel.date)}${isDuty(me, sel.date) ? " · szolgálati nap 7–7" : ""}</small></div><button id="edClose" title="Bezár">✕</button></div>
    <div class="ed-codes">${CODE_KEYS.map(k => { const ok = codeAllowed(k, p.pattern); return `<button data-code="${k}" class="${v?.c === k ? "cur" : ""}" style="background:${CODES[k].color}" ${ok ? "" : "disabled"} title="${ok ? CODES[k].label : `${CODES[k].label} – csak ${k === "24" ? "24" : "12"} órásnak adható (${esc(p.name)} ${p.pattern} órás)`}">${k}<small>${timeOf(k, true) || CODES[k].label}</small></button>`; }).join("")}</div>
    ${v && (v.c === "N" || v.c === "É") ? `<div class="ed-row times">
      <label style="flex-direction:row;align-items:center;gap:6px;font-size:13px;color:var(--text)">Mettől <input type="time" id="edS" value="${v.s || CODES[v.c].start}"></label>
      <label style="flex-direction:row;align-items:center;gap:6px;font-size:13px;color:var(--text)">meddig <input type="time" id="edE" value="${v.e || endOf(v.c)}"></label>
      ${v.s ? `<button class="small" id="edTReset" title="Vissza az alap időre">alap</button>` : ""}
      <span class="hint">legfeljebb 12 óra (${v.c === "N" ? "nappal 7–19" : "éjszaka 19–7"} keretben)</span></div>` : ""}
    <div class="ed-row">
      <label style="flex-direction:row;align-items:center;gap:6px;font-size:14px;color:var(--text)"><input type="checkbox" id="edOt" ${v?.t ? "checked" : ""} ${v && CODES[v.c]?.work ? "" : "disabled"}> Túlóra</label>
      <select id="edPct" ${v?.t ? "" : "disabled"} title="Túlóra-pótlék"><option value="">% automatikus</option><option value="100" ${v?.p === 100 ? "selected" : ""}>100%</option><option value="200" ${v?.p === 200 ? "selected" : ""}>200%</option></select>
      <span class="hint">${pctInfo}</span>
    </div>
    <div class="ed-row"><button class="danger" data-code="" ${v ? "" : "disabled"}>🗑 Törlés</button><button id="edRange" title="Betegség, szabadság stb. beírása több napra egyszerre">📅 Időszakra…</button><span class="grow" style="flex:1"></span><button id="edClose2">Kész</button></div>
    <div class="hint">Gyorsbillentyűk: N, E, 2 (=24), K, S, B, P · Del = törlés · + = túlóra · nyilak = lépés</div>`;
  positionEditor();
}
// A szerkesztőt a kijelölt cella mellé teszi (ha kifér, jobbra, különben balra)
function positionEditor() {
  const ed = $("#editor"), td = document.querySelector("td.sel");
  if (ed.hidden || !td) return;
  if (innerWidth < 700) { td.scrollIntoView({ block: "nearest", inline: "nearest" }); return; }   // telefonon alul jelenik meg
  const r = td.getBoundingClientRect(), w = ed.offsetWidth, h = ed.offsetHeight;
  let left = r.right + 8; if (left + w > innerWidth - 8) left = Math.max(8, r.left - w - 8);
  let top = Math.min(Math.max(8, r.top - 10), innerHeight - h - 8);
  ed.style.left = left + "px"; ed.style.top = top + "px";
}

// Kis ablak: egy kód beírása időszakra (pl. betegség)
function openRange(pid, date, code = "B") {
  const p = personOf(pid); if (!p) return;
  modal(`<h2>${esc(p.name)}</h2>
    <div class="stack">
      <label>Mi <select id="rgCode"><option value="B">Beteg</option><option value="SZ">Szabadság</option><option value="P">Pihenő</option><option value="K">Képzés</option><option value="">Üres (törlés)</option></select></label>
      <div class="row"><label>Mettől <input type="date" id="rgFrom" value="${date}"></label><label>Meddig <input type="date" id="rgTo" value="${date}"></label></div>
      <div class="muted" style="font-size:12px" id="rgInfo"></div>
    </div>`, async bg => {
    const c = bg.querySelector("#rgCode").value, f = bg.querySelector("#rgFrom").value, t = bg.querySelector("#rgTo").value;
    if (!f || !t || t < f) { alert("A „Meddig” nem lehet korábbi a „Mettől”-nél."); return false; }
    const days = range(f, t);
    if (days.length > 366) { alert("Legfeljebb 1 évet lehet egyszerre beírni."); return false; }
    await run(() => be.batch(cellsWrites(days.map(d => ({ pid, date: d, val: c ? { c } : null })))));
  });
  const bg = document.querySelector(".modal-bg");
  bg.querySelector("#rgCode").value = code;
  const info = () => { const f = bg.querySelector("#rgFrom").value, t = bg.querySelector("#rgTo").value; bg.querySelector("#rgInfo").textContent = f && t && t >= f ? `${range(f, t).length} nap` : ""; };
  bg.addEventListener("change", info); info();
  setTimeout(() => bg.querySelector("#rgTo").focus(), 0);
}

// Ember adatai (névre kattintva)
function openPerson(pid, rangeDate = null) {
  const focusRange = !!rangeDate, rd = rangeDate || today();
  const p = personOf(pid); if (!p) return;
  modal(`<h2>${esc(p.name)}</h2>
    <div class="stack">
      <label>Név <input id="ppName" value="${esc(p.name)}" maxlength="80"></label>
      <div class="row">
        <label>Munkarend <select id="ppPat"><option value="12" ${p.pattern === "12" ? "selected" : ""}>12 órás</option><option value="24" ${p.pattern === "24" ? "selected" : ""}>24 órás</option></select></label>
        <label>Beosztás <select id="ppRole"><option value="">–</option>${ROLES.map(r => `<option ${p.role === r ? "selected" : ""}>${esc(r)}</option>`).join("")}</select></label>
      </div>
      <label>Éves szabadság (nap) <input type="number" id="ppLeave" min="0" max="99" value="${p.leaveDays ?? ""}" style="width:100px"> <span class="muted">idén felhasználva: ${leaveUsed(p.id)} nap</span></label>
      <div class="row">${EXAMS.map(x => { const d = p.exams?.[x.id] || "", st = examState(d); return `<label>${esc(x.label)} érvényes eddig <input type="date" class="exam-input ${d && st === "bad" ? "exp-bad" : d && st === "warn" ? "exp-warn" : ""}" data-ppexam="${x.id}" value="${d}"></label>`; }).join("")}</div>
      <label style="flex-direction:row;gap:6px;align-items:center;color:var(--text);font-size:14px"><input type="checkbox" id="ppAct" ${p.active !== false ? "checked" : ""}> Aktív (ha kiveszed, eltűnik a beosztásból, de az adatai megmaradnak)</label>
      <fieldset style="border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:0">
        <legend style="font-size:13px;padding:0 4px"><b>Időszak beállítása</b> (pl. betegség)</legend>
        <div class="row">
          <label>Mi <select id="prCode"><option value="B">Beteg</option><option value="SZ">Szabadság</option><option value="P">Pihenő</option><option value="K">Képzés</option><option value="">Üres (törlés)</option></select></label>
          <label>Mettől <input type="date" id="prFrom" value="${rd}"></label>
          <label>Meddig <input type="date" id="prTo" value="${rd}"></label>
          <button type="button" id="prApply">Beírás</button>
        </div>
        <div class="hint muted" style="font-size:12px;margin-top:4px">Az időszak minden napját felülírja (a túlórát és a kölcsönadást nem érinti).</div>
      </fieldset>
      <div class="row"><button type="button" id="ppFill">Kitöltés mintával…</button><span class="grow" style="flex:1"></span><button type="button" class="danger" id="ppDel">🗑 Ember törlése</button></div>
    </div>`, async bg => {
    const name = bg.querySelector("#ppName").value.trim();
    if (!name) { alert("A név nem lehet üres."); return false; }
    const exams = {}; bg.querySelectorAll("[data-ppexam]").forEach(i => { exams[i.dataset.ppexam] = i.value || ""; });
    const lv = bg.querySelector("#ppLeave").value;
    await run(() => be.update("people", pid, { name, pattern: bg.querySelector("#ppPat").value, role: bg.querySelector("#ppRole").value,
      active: bg.querySelector("#ppAct").checked, leaveDays: lv === "" ? null : Math.max(0, Math.min(99, Number(lv))), exams }));
  });
  const bg = document.querySelector(".modal-bg");
  bg.querySelector("#ppFill").addEventListener("click", () => { bg.remove(); openFill(pid); });
  if (focusRange) { const fs = bg.querySelector("#prCode").closest("fieldset"); fs.style.borderColor = "var(--accent)"; fs.scrollIntoView({ block: "center" }); bg.querySelector("#prTo").focus(); }
  bg.querySelector("#prApply").addEventListener("click", () => {
    const c = bg.querySelector("#prCode").value, f = bg.querySelector("#prFrom").value, t = bg.querySelector("#prTo").value;
    if (!f || !t || t < f) return alert("Ellenőrizd a dátumokat (a „Meddig” nem lehet korábbi).");
    const days = range(f, t);
    if (days.length > 366) return alert("Legfeljebb 1 évet lehet egyszerre beírni.");
    const label = c ? CODES[c].label.toLowerCase() : "törlés";
    if (!confirm(`${p.name}: ${f.replaceAll("-", ".")}. – ${t.replaceAll("-", ".")}. (${days.length} nap) → ${label}?`)) return;
    bg.remove();
    run(() => be.batch(cellsWrites(days.map(d => ({ pid, date: d, val: c ? { c } : null })))));
  });
  bg.querySelector("#ppDel").addEventListener("click", () => {
    if (confirm(`Törlöd: ${p.name}?\nHa csak nem dolgozik már itt, inkább vedd ki az „Aktív” pipát – úgy a korábbi adatai megmaradnak.`)) { bg.remove(); sel = null; run(() => be.remove("people", pid)); }
  });
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
    ${list.map(l => `<tr><td>${esc(l.personName)}</td><td>${fmtDate(l.from)}</td><td>${fmtDate(l.to)}</td><td class="num">${range(l.from, l.to).length}${l.status === "jóváhagyva" && l.szDays != null ? `<br><small class="muted">${l.szDays} SZ · ${l.pDays || 0} P</small>` : ""}</td>
      <td>${esc(l.kind)}</td><td style="white-space:normal">${esc(l.note)}</td><td>${badge(l.status)}</td>
      <td style="white-space:nowrap">${!canEdit ? "" : l.status === "függő" ? `<button class="give small" data-approve="${l.id}">Jóváhagy</button> <button class="small danger" data-reject="${l.id}">Elutasít</button>` : ""}
      ${canEdit ? `<button class="del" data-delleave="${l.id}" title="Törlés">✕</button>` : ""}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty-list">${leaveFilter === "pending" ? "Nincs elbírálásra váró kérelem." : "Még nincs kérelem."}</div>`;
}

// ---------------------------------------------------------------- emberek
function renderPeople() {
  document.querySelector("#tab-people > .card").hidden = !canEdit;
  if (canEdit && !$("#pRole").options.length) {
    $("#pRole").innerHTML = '<option value="">–</option>' + ROLES.map(r => `<option>${esc(r)}</option>`).join("");
    $("#pExams").innerHTML = EXAMS.map(x => `<label>${esc(x.label)} érvényes eddig <input type="date" name="exam_${x.id}" class="exam-input"></label>`).join("");
    $("#pForm").leaveDays.value = DEFAULT_LEAVE_DAYS;
  }
  const list = people.slice().sort((a, b) => (a.active === false) - (b.active === false) || a.name.localeCompare(b.name, "hu"));

  // Az embercserében adott, de a névsorban még nem szereplő nevek
  const missing = canEdit ? exchangeMissing() : [];
  const exHtml = missing.length ? `<div class="card alerts" style="border-left-color:var(--accent)"><b>Embercseréből – még nincs a névsorban (${missing.length})</b>
    <p class="muted" style="font-size:13px;margin:4px 0 8px">Ezeket az embereket az osztályod már adta embercserében. Ha felveszed őket, a beosztásban is megjelenik, hová adtad őket (pl. „É→4”), és a túlórájuk is számolódik.</p>
    <div class="row" style="gap:6px">${missing.map(m => `<button class="small" data-addex="${esc(m.name)}" title="${m.count} alkalommal adva">+ ${esc(m.name)}${m.role ? ` · ${esc(m.role)}` : ""}</button>`).join("")}
    <button class="small primary" data-addex-all>Mind felvétele (12 órás)</button></div></div>` : "";

  // Lejárt / hamarosan lejáró érvényességek
  const alerts = list.filter(p => p.active !== false).flatMap(p => examProblems(p).map(e => ({ p, ...e })))
    .sort((a, b) => (a.d || "").localeCompare(b.d || ""));
  $("#examAlerts").innerHTML = exHtml + (alerts.length ? `<div class="card alerts"><b>⚠ Lejárt vagy ${EXAM_WARN_DAYS} napon belül lejáró érvényességek (${alerts.length})</b><ul>
    ${alerts.map(a => `<li><span class="${a.st === "bad" ? "exp-bad" : "exp-warn"}">${a.st === "bad" ? "LEJÁRT" : "lejár"}</span> · ${esc(a.p.name)} – ${esc(a.x.label)}: ${fmtD(a.d)}</li>`).join("")}</ul></div>` : "");

  const leaveCell = p => {
    const total = Number(p.leaveDays ?? 0), used = leaveUsed(p.id), left = total - used;
    return `<span title="Idén felhasznált (beírt SZ): ${used} nap">${used} / ${total} · <b class="${left < 0 ? "exp-bad" : ""}">marad ${left}</b></span>`;
  };
  const examTd = (p, x) => {
    const d = p.exams?.[x.id] || "", st = examState(d);
    const cls = st === "bad" ? "exp-bad" : st === "warn" ? "exp-warn" : "";
    return canEdit
      ? `<td><input type="date" class="exam-input ${d ? cls : ""}" value="${d}" data-pexam="${p.id}|${x.id}"></td>`
      : `<td class="${d ? cls : "muted"}">${fmtD(d)}</td>`;
  };
  const head = `<th>Név</th><th>Munkarend</th><th>Beosztás</th><th>Éves szabadság</th><th>Felhasznált / keret</th>${EXAMS.map(x => `<th>${esc(x.label)}</th>`).join("")}<th>Aktív</th>${canEdit ? "<th></th>" : ""}`;
  $("#peopleTable").innerHTML = list.length ? `<table class="plain"><thead><tr>${head}</tr></thead><tbody>
    ${list.map(p => canEdit ? `<tr${p.active === false ? ' class="muted"' : ""}>
      <td><input value="${esc(p.name)}" data-pname="${p.id}" maxlength="80" style="width:100%;min-width:150px"></td>
      <td><select data-ppattern="${p.id}"><option value="12" ${p.pattern === "12" ? "selected" : ""}>12 órás</option><option value="24" ${p.pattern === "24" ? "selected" : ""}>24 órás</option></select></td>
      <td><select data-prole="${p.id}"><option value="">–</option>${ROLES.map(r => `<option ${p.role === r ? "selected" : ""}>${esc(r)}</option>`).join("")}</select></td>
      <td><input type="number" min="0" max="99" value="${p.leaveDays ?? ""}" data-pleave="${p.id}" style="width:70px"> nap</td>
      <td style="white-space:nowrap">${leaveCell(p)}</td>
      ${EXAMS.map(x => examTd(p, x)).join("")}
      <td><input type="checkbox" data-pactive="${p.id}" ${p.active !== false ? "checked" : ""} title="Ha kiveszed a pipát, eltűnik a beosztásból, de az adatai megmaradnak"></td>
      <td><button class="del" data-pdel="${p.id}" title="Törlés">✕</button></td></tr>`
      : `<tr${p.active === false ? ' class="muted"' : ""}><td>${esc(p.name)}</td><td>${p.pattern} órás</td><td>${esc(p.role || "–")}</td>
      <td>${p.leaveDays ?? "–"} nap</td><td style="white-space:nowrap">${leaveCell(p)}</td>${EXAMS.map(x => examTd(p, x)).join("")}<td>${p.active !== false ? "igen" : "nem"}</td></tr>`).join("")}
    </tbody></table><p class="muted" style="font-size:13px">${people.filter(p => p.active !== false).length} aktív fő. A felhasznált szabadság az idei, beosztásba beírt SZ napok száma.
      A dátum <span class="exp-warn">narancs</span>, ha ${EXAM_WARN_DAYS} napon belül lejár, <span class="exp-bad">piros</span>, ha már lejárt.</p>`
    : `<div class="empty-list">Még nincs ember felvéve.</div>`;
}

// ---------------------------------------------------------------- nevek sorrendje
let rowDrag = null;
function setSort(mode) {
  if (mode === sortMode()) return;
  const ops = [{ col: "classSettings", id: me, op: "set", merge: true, data: { classId: me, sortMode: mode } }];
  // Első váltáskor a saját sorrend az eddigi (ABC) sorrendből indul
  if (mode === "custom" && people.some(p => p.order == null)) {
    people.slice().sort(byOrder).forEach((p, i) => ops.push({ col: "people", id: p.id, op: "update", data: { order: (i + 1) * 10 } }));
  }
  run(() => be.batch(ops));
}
function moveRow(id, targetId, after) {
  const list = active().map(p => p.id).filter(x => x !== id);
  let at = list.indexOf(targetId); if (at < 0) return;
  if (after) at++;
  list.splice(at, 0, id);
  // az inaktívak a végére kerülnek, hogy ne keveredjenek
  const rest = people.filter(p => !list.includes(p.id)).sort(byOrder).map(p => p.id);
  const ops = [...list, ...rest].map((pid, i) => ({ col: "people", id: pid, op: "update", data: { order: (i + 1) * 10 } }))
    .filter(o => personOf(o.id)?.order !== o.data.order);
  if (sortMode() !== "custom") ops.push({ col: "classSettings", id: me, op: "set", merge: true, data: { classId: me, sortMode: "custom" } });
  run(() => be.batch(ops));
}

// ---------------------------------------------------------------- embercsere ↔ névsor
const normName = x => String(x || "").trim().toLowerCase().replace(/\s+/g, " ");
function exchangeMissing() {
  const have = new Set(people.map(p => normName(p.name))), out = {};
  for (const o of offers) {
    if (o.classId !== me || o.personId || !o.person) continue;
    const k = normName(o.person); if (have.has(k)) continue;
    (out[k] ||= { name: o.person.trim(), count: 0, role: ROLES[o.roleIndex] || "" }).count++;
  }
  return Object.values(out).sort((a, b) => a.name.localeCompare(b.name, "hu"));
}
// A saját osztály név szerint egyező felajánlásait a névsorbeli emberhez kapcsolja
const linked = new Set();
function linkOffers() {
  if (!canEdit) return;
  for (const o of offers) {
    if (o.classId !== me || o.personId || linked.has(o.id)) continue;
    const p = people.find(x => normName(x.name) === normName(o.person)); if (!p) continue;
    linked.add(o.id);
    be.update("offers", o.id, { personId: p.id }).catch(() => linked.delete(o.id));
  }
}
async function addFromExchange(names) {
  for (const m of names) {
    await be.add("people", { classId: me, name: m.name.slice(0, 80), pattern: "12", role: m.role || "", active: true, leaveDays: DEFAULT_LEAVE_DAYS, exams: {}, createdAt: NOW });
  }
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
  const pp = personOf(sel.pid);
  if (c && pp && !codeAllowed(c, pp.pattern)) return showError(`${pp.name} ${pp.pattern} órás – ${c === "24" ? "24 órás szolgálat csak 24 órásnak" : "nappal / éjszaka csak 12 órásnak"} adható.`);
  const cur = cellOf(sel.pid, sel.date);
  const keepOt = cur?.t && CODES[c]?.work;
  setCell(sel.pid, sel.date, c ? { c, ...(keepOt ? { t: true } : {}), ...(keepOt && cur.p ? { p: cur.p } : {}) } : null);
}
function toggleOt() {
  if (!sel) return;
  const cur = cellOf(sel.pid, sel.date);
  if (!cur || !CODES[cur.c]?.work) return showError("Túlórának csak szolgálatot (N, É, 24, K) lehet jelölni.");
  setCell(sel.pid, sel.date, cur.t ? { ...cur, t: false, p: null } : { ...cur, t: true });
}

function wire() {
  document.addEventListener("click", e => {
    const t = e.target.closest("button, td.cell") || e.target;
    const d = t.dataset || {};
    if (d.tab) { tab = d.tab; sel = null; store.set("sz.tab", tab); render(); }
    else if (d.sort && canEdit) setSort(d.sort);
    else if (d.len) { gLen = d.len; store.set("sz.len", gLen); resubscribe(); render(); }
    else if (t.id === "gPrev" || t.id === "gNext") {
      const dir = t.id === "gPrev" ? -1 : 1;
      if (gLen === "month") { const x = parse(monthKey(gFrom) + "-01"); x.setMonth(x.getMonth() + dir); gFrom = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-01`; }
      else if (gLen === "keret") { const k = keretOf(gFrom); gFrom = dir < 0 ? keretOf(addDays(k.from, -1)).from : addDays(k.to, 1); }
      else gFrom = addDays(gFrom, dir * Number(gLen));
      resubscribe(); render();
    }
    else if (t.id === "gToday") { gFrom = today(); resubscribe(); render(); }
    else if (t.id === "tbToggle") $("#tbMore").classList.toggle("open");
    else if (t.id === "gExport") exportGrid();
    else if (t.id === "gPrint") window.print();
    else if (t.id === "kPrev" || t.id === "kNext") {
      const k = keretOf(keretDate); keretDate = t.id === "kPrev" ? addDays(k.from, -1) : addDays(k.to, 1); resubscribe(); render();
    }
    else if (t.id === "kExport") exportKeret();
    else if (t.id === "rotEdit" && user?.role === "admin") openRotation();
    else if (t.matches?.("td.cell") && d.pid) {
      if (canEdit) { sel = { pid: d.pid, date: d.date }; renderGrid(); }
      else { const v = $("#viewonly"); if (v) { v.classList.remove("flash"); void v.offsetWidth; v.classList.add("flash"); } }
    }
    else if (e.target.closest?.("[data-person]") && canEdit) openPerson(e.target.closest("[data-person]").dataset.person);
    else if (e.target.closest?.("[data-goclass]")) { me = e.target.closest("[data-goclass]").dataset.goclass; render(); }
    else if (d.code === "B" && e.target.closest?.("#editor")) { const { pid, date } = sel; openRange(pid, date, "B"); }
    else if (d.code !== undefined) applyCode(d.code);
    else if (t.id === "edClose" || t.id === "edClose2") { sel = null; renderGrid(); }
    else if (t.id === "edRange") { const { pid, date } = sel; openRange(pid, date, cellOf(pid, date)?.c && ["B", "SZ", "P", "K"].includes(cellOf(pid, date).c) ? cellOf(pid, date).c : "B"); }
    else if (t.id === "edTReset") { const cur = cellOf(sel.pid, sel.date); setCell(sel.pid, sel.date, { ...cur, s: null, e: null }); }
    else if (d.fill) openFill(d.fill);
    else if (d.lf) { leaveFilter = d.lf; render(); }
    else if (d.approve) approveLeave(d.approve);
    else if (d.reject) { const l = leaves.find(x => x.id === d.reject); if (confirm(`Elutasítod ${l.personName} kérelmét?`)) run(() => be.update("leave", l.id, { status: "elutasítva", decidedAt: NOW })); }
    else if (d.delleave) { const l = leaves.find(x => x.id === d.delleave); if (confirm(`Törlöd ${l.personName} kérelmét? (A beosztásba már beírt SZ megmarad.)`)) run(() => be.remove("leave", l.id)); }
    else if (sel && !e.target.closest?.("#editor, .modal-bg, td.cell")) { sel = null; renderGrid(); }
    else if (d.addex) { const m = exchangeMissing().find(x => x.name === d.addex); if (m) run(() => addFromExchange([m])); }
    else if ("addexAll" in d) { const ms = exchangeMissing(); if (ms.length && confirm(`Felveszed mind a ${ms.length} embert 12 órásként? (Utána egyenként átállíthatod.)`)) run(() => addFromExchange(ms)); }
    else if (d.pdel) {
      const p = personOf(d.pdel);
      if (confirm(`Törlöd: ${p.name}?\nHa csak nem dolgozik már itt, inkább vedd ki az „Aktív” pipát – úgy a korábbi adatai megmaradnak.`)) run(() => be.remove("people", p.id));
    }
  });
  document.addEventListener("change", e => {
    const t = e.target, d = t.dataset;
    if (t.id === "viewClass") { me = t.value; sel = null; store.set("sz.view", me); render(); }
    else if (t.id === "gFrom" && t.value) { gFrom = t.value; resubscribe(); render(); }
    else if (t.id === "gTargetDay" || t.id === "gTargetNight") {
      const n = x => Math.max(0, Math.min(999, Number(x) || 0));
      run(() => be.set("classSettings", me, { classId: me, targetDay: n($("#gTargetDay").value), targetNight: n($("#gTargetNight").value) }, true));
    }
    else if (t.id === "edS" || t.id === "edE") {
      const cur = cellOf(sel.pid, sel.date); if (!cur) return;
      const sv = $("#edS").value, ev = $("#edE").value; if (!sv || !ev) return;
      const mins = x => { const [h, m] = x.split(":").map(Number); return h * 60 + m; };
      const dur = ((mins(ev) - mins(sv)) + 1440) % 1440 || 1440;
      if (dur > 720) return showError("Egy nappali / éjszakai szolgálat legfeljebb 12 óra lehet.");
      const def = sv === CODES[cur.c].start && ev === endOf(cur.c);
      setCell(sel.pid, sel.date, def ? { ...cur, s: null, e: null } : { ...cur, s: sv, e: ev });
    }
    else if (t.id === "edOt") toggleOt();
    else if (t.id === "edPct") { const cur = cellOf(sel.pid, sel.date); const p = Number(t.value) || null; setCell(sel.pid, sel.date, { ...cur, t: true, p }); }
    else if (d.pname) { const v = t.value.trim(); if (v) run(() => be.update("people", d.pname, { name: v })); }
    else if (d.ppattern) run(() => be.update("people", d.ppattern, { pattern: t.value }));
    else if (d.prole !== undefined) run(() => be.update("people", d.prole, { role: t.value }));
    else if (d.pactive) run(() => be.update("people", d.pactive, { active: t.checked }));
    else if (d.pleave) run(() => be.update("people", d.pleave, { leaveDays: t.value === "" ? null : Math.max(0, Math.min(99, Number(t.value))) }));
    else if (d.pexam) { const [pid, ex] = d.pexam.split("|"); run(() => be.update("people", pid, { ["exams." + ex]: t.value || "" })); }
  });
  document.addEventListener("keydown", e => {
    if (!canEdit || !sel || tab !== "grid" || e.target.matches?.("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "b") { e.preventDefault(); openRange(sel.pid, sel.date, "B"); }
    else if (KEYS[k]) { e.preventDefault(); applyCode(KEYS[k]); moveSel(1, 0); }
    else if (k === "delete" || k === "backspace") { e.preventDefault(); applyCode(""); moveSel(1, 0); }
    else if (k === "+" || k === "t") { e.preventDefault(); toggleOt(); }
    else if (k === "arrowright") { e.preventDefault(); moveSel(1, 0); }
    else if (k === "arrowleft") { e.preventDefault(); moveSel(-1, 0); }
    else if (k === "arrowdown") { e.preventDefault(); moveSel(0, 1); }
    else if (k === "arrowup") { e.preventDefault(); moveSel(0, -1); }
    else if (k === "escape") { sel = null; renderGrid(); }
  });

  // A szerkesztő kövesse a cellát görgetéskor / átméretezéskor
  addEventListener("resize", positionEditor);
  addEventListener("scroll", positionEditor, true);

  // ---- Áthúzásos csere a beosztásban
  let drag = null;
  document.addEventListener("dragstart", e => {
    const nm = e.target.closest?.("td.name[draggable]");
    if (nm && canEdit) {
      rowDrag = nm.dataset.person;
      nm.closest("tr").classList.add("rowdragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "row:" + rowDrag);
      return;
    }
    const td = e.target.closest?.("td.cell[draggable]");
    if (td && canEdit) {
      drag = { pid: td.dataset.pid, date: td.dataset.date };
      td.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", drag.pid + "|" + drag.date);
      return;
    }
    const row = e.target.closest?.(".rot-list [data-rot]");
    if (row) { rotDrag = Number(row.dataset.rot); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(rotDrag)); }
  });
  document.addEventListener("dragover", e => {
    if (rowDrag) {
      const tr = e.target.closest?.("tr[data-row]"); if (!tr) return;
      e.preventDefault();
      const r = tr.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      document.querySelectorAll(".rowdrop-before, .rowdrop-after").forEach(x => x.classList.remove("rowdrop-before", "rowdrop-after"));
      if (tr.dataset.row !== rowDrag) tr.classList.add(after ? "rowdrop-after" : "rowdrop-before");
      return;
    }
    const td = e.target.closest?.("td.cell[draggable]");
    const row = e.target.closest?.(".rot-list [data-rot]");
    if ((td && drag) || (row && rotDrag != null)) {
      e.preventDefault();
      document.querySelectorAll(".dropover").forEach(x => x !== (td || row) && x.classList.remove("dropover"));
      (td || row).classList.add("dropover");
    }
  });
  document.addEventListener("dragend", () => {
    drag = null; rotDrag = null; rowDrag = null;
    document.querySelectorAll(".dragging, .dropover, .rowdragging, .rowdrop-before, .rowdrop-after").forEach(x => x.classList.remove("dragging", "dropover", "rowdragging", "rowdrop-before", "rowdrop-after"));
  });
  document.addEventListener("drop", e => {
    if (rowDrag) {
      const tr = e.target.closest?.("tr[data-row]"), moving = rowDrag;
      rowDrag = null;
      const after = tr?.classList.contains("rowdrop-after");
      document.querySelectorAll(".rowdragging, .rowdrop-before, .rowdrop-after").forEach(x => x.classList.remove("rowdragging", "rowdrop-before", "rowdrop-after"));
      if (!tr || tr.dataset.row === moving) return;
      e.preventDefault();
      moveRow(moving, tr.dataset.row, after);
      return;
    }
    const td = e.target.closest?.("td.cell[draggable]");
    if (td && drag) {
      e.preventDefault();
      const a = drag, b = { pid: td.dataset.pid, date: td.dataset.date };
      drag = null;
      document.querySelectorAll(".dragging, .dropover").forEach(x => x.classList.remove("dragging", "dropover"));
      if (a.pid === b.pid && a.date === b.date) return;
      const va = cellOf(a.pid, a.date), vb = cellOf(b.pid, b.date);
      if (!va && !vb) return;
      const pa = personOf(a.pid), pb = personOf(b.pid);
      if ((va && !codeAllowed(va.c, pb.pattern)) || (vb && !codeAllowed(vb.c, pa.pattern)))
        return showError("Ez a csere nem lehetséges: nappal / éjszaka csak 12 órásnak, 24 órás szolgálat csak 24 órásnak adható.");
      sel = { ...b };
      run(() => be.batch(cellsWrites([{ pid: a.pid, date: a.date, val: vb }, { pid: b.pid, date: b.date, val: va }])));
      return;
    }
    const row = e.target.closest?.(".rot-list [data-rot]");
    if (row && rotDrag != null && rotMove) { e.preventDefault(); rotMove(rotDrag, Number(row.dataset.rot)); rotDrag = null; }
  });

  $("#pForm").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target, name = f.name.value.trim();
    if (!name) return;
    const exams = {}; EXAMS.forEach(x => { exams[x.id] = f["exam_" + x.id].value || ""; });
    const lv = f.leaveDays.value;
    run(async () => {
      await be.add("people", { classId: me, name, pattern: f.pattern.value, role: f.role.value, active: true,
        leaveDays: lv === "" ? null : Math.max(0, Math.min(99, Number(lv))), exams, createdAt: NOW });
      f.name.value = ""; EXAMS.forEach(x => { f["exam_" + x.id].value = ""; }); f.name.focus();
    });
  });
  $("#pBulk").addEventListener("submit", e => {
    e.preventDefault();
    const names = $("#pBulkText").value.split("\n").map(s => s.trim()).filter(Boolean).slice(0, 200);
    if (!names.length) return;
    const pattern = $("#pBulkPattern").value;
    run(async () => {
      for (const name of names) await be.add("people", { classId: me, name: name.slice(0, 80), pattern, role: "", active: true, leaveDays: DEFAULT_LEAVE_DAYS, exams: {}, createdAt: NOW });
      $("#pBulkText").value = "";
    });
  });
}

let rotDrag = null, rotMove = null;
function openRotation() {
  let order = rotation?.order?.length ? [...rotation.order] : CLASSES.map(c => c.id);
  rotMove = (from, to) => { if (from === to) return; const [x] = order.splice(from, 1); order.splice(to, 0, x); draw(); };
  const draw = () => {
    document.querySelector("#rotList").innerHTML = order.map((cid, i) => `<div style="--clr:${color(cid)}" draggable="true" data-rot="${i}"><span class="grip" title="Húzd a helyére">⠿</span><span>${i + 1}.</span><b>${esc(className(cid))}</b>
      <button type="button" class="small" data-up="${i}" ${i ? "" : "disabled"}>▲</button><button type="button" class="small" data-down="${i}" ${i < order.length - 1 ? "" : "disabled"}>▼</button></div>`).join("");
    const st = document.querySelector("#rotStart").value;
    document.querySelector("#rotPreview").innerHTML = st ? "Így megy: " + range(st, addDays(st, 7)).map(d => `${d.slice(5).replace("-", ".")}. ${DAYS_SHORT[weekday(d)]}: <b>${classNo(order[((Math.round((parse(d) - parse(st)) / 86400000)) % order.length + order.length) % order.length])}</b>`).join(" · ") : "";
  };
  modal(`<h2>Szolgálati sorrend</h2>
    <div class="stack">
      <p class="muted" style="margin:0;font-size:14px">Minden nap egy osztály van szolgálatban, 7-től másnap 7-ig. Állítsd be a sorrendet (húzd a helyére, vagy a nyilakkal) és hogy melyik naptól indul.</p>
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
  const inRoster = !!personOf(l.personId);
  // Alapból: ahol szolgálatba lett volna beosztva (vagy az osztály szolgálati napja) → szabadság, máshol pihenőnap
  const kind = {};
  for (const d of days) { const v = cellOf(l.personId, d); kind[d] = v?.c === "B" ? "B" : (v && CODES[v.c]?.work) || (!v && isDuty(me, d)) ? "SZ" : "P"; }
  const draw = () => {
    const box = document.querySelector("#lvDays"); if (!box) return;
    box.innerHTML = days.map(d => `<div><span>${d.slice(5).replace("-", ".")}. ${DAYS_SHORT[weekday(d)]}${isDuty(me, d) ? " ●" : ""}</span>
      ${kind[d] === "B" ? '<span class="muted" style="padding-right:6px">beteg</span>' : `<span class="seg"><button type="button" data-lk="${d}|SZ" class="${kind[d] === "SZ" ? "on" : ""}">SZ</button><button type="button" data-lk="${d}|P" class="${kind[d] === "P" ? "on" : ""}">P</button></span>`}</div>`).join("");
    const sz = days.filter(d => kind[d] === "SZ").length, pp = days.filter(d => kind[d] === "P").length;
    document.querySelector("#lvSum").innerHTML = `<b>${sz}</b> nap szabadság · <b>${pp}</b> pihenőnap${days.some(d => kind[d] === "B") ? " · a betegséget nem írja felül" : ""}`;
  };
  modal(`<h2>Szabadság jóváhagyása</h2>
    <div class="stack">
      <p style="margin:0">${esc(l.personName)}: ${fmtDate(l.from)} – ${fmtDate(l.to)} (${days.length} nap)${l.note ? `<br><span class="muted">${esc(l.note)}</span>` : ""}</p>
      ${inRoster ? `<p class="muted" style="margin:0;font-size:13px">Naponként döntsd el: <b>SZ</b> = szabadság (levonódik a keretből), <b>P</b> = pihenőnap. ● = az osztály szolgálati napja.</p>
      <div class="row" style="gap:6px"><button type="button" class="small" data-lall="SZ">Mind szabadság</button><button type="button" class="small" data-lall="P">Mind pihenőnap</button></div>
      <div class="leave-days" id="lvDays"></div>
      <div id="lvSum" style="font-size:14px"></div>` : '<p class="muted">Ez az ember már nincs a névsorban, ezért a beosztásba nem írható be – csak a kérelem állapota változik.</p>'}
    </div>`, async () => {
    const sz = days.filter(d => kind[d] === "SZ").length, pp = days.filter(d => kind[d] === "P").length;
    const ops = [{ col: "leave", id: l.id, op: "update", data: { status: "jóváhagyva", decidedAt: NOW, szDays: inRoster ? sz : days.length, pDays: inRoster ? pp : 0 } }];
    if (inRoster) ops.push(...cellsWrites(days.filter(d => kind[d] !== "B").map(d => ({ pid: l.personId, date: d, val: { c: kind[d] } }))));
    await run(() => be.batch(ops));
  });
  const bg = document.querySelector(".modal-bg");
  bg.addEventListener("click", e => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.lk) { const [d, k] = t.dataset.lk.split("|"); kind[d] = k; draw(); }
    if (t.dataset.lall) { days.forEach(d => { if (kind[d] !== "B") kind[d] = t.dataset.lall; }); draw(); }
  });
  draw();
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
