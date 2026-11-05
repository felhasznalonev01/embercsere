// Embercsere / kölcsönkérés (osztályvezetők)
import { CLASSES, ROLES, SHIFTS } from "./config.js";
import { NOW } from "./backend.js";
import { $, esc, className, color, COLORS, run, showError, start, today, addDays, fmtDate } from "./common.js";

const STATUS = [["open", "Nyitott"], ["all", "Mind"], ["done", "Teljesült"]];
const RECENT_DAYS = 14;           // ennyi napnál régebbi kéréseket nem tölt be (olvasás-takarékosság)

let be, me = null;
let data = { requests: [], offers: [] };
let people = [];                  // saját osztály névsora (az "Adok" listához)
let unsubs = [];
let qty = ROLES.map(() => 0);
let shift = SHIFTS[0];
let status = "open";
let giving = null;                // nyitott "Adok" mező: requestId|roleIndex

const items = r => (r.qty || []).map((n, i) => ({ roleIndex: i, role: ROLES[i] || `#${i + 1}`, qty: n })).filter(x => x.qty > 0);
const offersOf = (r, roleIndex) => data.offers.filter(o => o.requestId === r.id && (roleIndex == null || o.roleIndex === roleIndex));
const needed = r => (r.qty || []).reduce((a, b) => a + b, 0);
const isDone = r => offersOf(r).length >= needed(r);
const shiftOrder = s => SHIFTS.indexOf(s);
const offerId = (requestId, roleIndex, slot) => `${requestId}_${roleIndex}_${slot}`;
function freeSlot(r, roleIndex) {
  const taken = new Set(offersOf(r, roleIndex).map(o => o.slot));
  for (let s = 0; s < (r.qty[roleIndex] || 0); s++) if (!taken.has(s)) return s;
  return -1;
}

// ------------------------------------------------------------------ megjelenítés
function render() {
  if (!me) return;
  const fc = $("#fClass").value;
  $("#fClass").innerHTML = '<option value="">Mind</option>' + CLASSES.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  $("#fClass").value = fc;

  $("#classes").innerHTML = CLASSES.map((c, i) => {
    const own = data.requests.filter(r => r.classId === c.id);
    const asked = own.reduce((a, r) => a + needed(r), 0);
    const got = own.reduce((a, r) => a + offersOf(r).length, 0);
    const gave = data.offers.filter(o => o.classId === c.id && data.requests.some(r => r.id === o.requestId)).length;
    return `<div class="card cls ${fc === c.id ? "active" : ""}" style="--clr:${COLORS[i]}" data-cls="${c.id}">
      <div class="name">${esc(c.name)}${me === c.id ? ' <span class="muted">(én)</span>' : ""}</div>
      <div class="nums"><span><b>${asked}</b>kért</span><span><b>${got}</b>kapott</span><span><b>${gave}</b>adott</span></div>
      <button class="export" data-export="${c.id}">⬇ Excel</button>
    </div>`;
  }).join("");

  $("#rShift").innerHTML = SHIFTS.map(s => `<button type="button" data-shift="${esc(s)}" class="${s === shift ? "on" : ""}">${s === "Éjszaka" ? "☾ " : "☀︎ "}${esc(s)}</button>`).join("");
  $("#rRoles").innerHTML = ROLES.map((role, i) => `<div class="role ${qty[i] ? "has" : ""}"><span>${esc(role)}</span>
      <span class="stepper"><button type="button" data-step="-1" data-ri="${i}">−</button><span>${qty[i]}</span><button type="button" data-step="1" data-ri="${i}">+</button></span></div>`).join("");
  const total = qty.reduce((a, b) => a + b, 0);
  $("#rSummary").textContent = total ? `Összesen ${total} főt kérsz (${className(me)} nevében)` : "";
  $("#fStatus").innerHTML = STATUS.map(([k, t]) => `<button type="button" data-status="${k}" class="${k === status ? "on" : ""}">${t}</button>`).join("");

  const from = $("#fFrom").value;
  const list = data.requests
    .filter(r => (!fc || r.classId === fc || offersOf(r).some(o => o.classId === fc)) && (!from || r.date >= from))
    .filter(r => status === "all" || (status === "done") === isDone(r))
    .sort((a, b) => a.date.localeCompare(b.date) || shiftOrder(a.shift) - shiftOrder(b.shift));
  $("#list").innerHTML = list.map(renderRequest).join("") ||
    `<div class="card empty-list">${status === "open" ? "Nincs nyitott kérés." : "Nincs ilyen kérés."}</div>`;
}

function giveForm(r, roleIndex, key) {
  const role = ROLES[roleIndex];
  // aki már adva van ugyanarra a napra és napszakra, az nem jelenik meg
  const busy = new Set(data.offers.filter(o => o.date === r.date && o.shift === r.shift && o.personId).map(o => o.personId));
  const list = people.filter(p => p.active !== false && !busy.has(p.id))
    .sort((a, b) => (b.role === role) - (a.role === role) || a.name.localeCompare(b.name, "hu"));
  return `<span class="give-form">
    <select data-give-select><option value="">– kit adsz? –</option>
      ${list.map(p => `<option value="${p.id}">${esc(p.name)}${p.role ? " · " + esc(p.role) : ""}</option>`).join("")}
      <option value="__other">Más (név beírása)…</option></select>
    <input data-give-input maxlength="100" placeholder="Név" hidden>
    <button class="give" data-giveok="${key}">OK</button><button data-givecancel>Mégse</button></span>`;
}

function renderRequest(r) {
  const got = offersOf(r).length, need = needed(r), mine = me === r.classId;
  const rows = items(r).map(it => {
    const offs = offersOf(r, it.roleIndex).sort((a, b) => a.slot - b.slot);
    const missing = it.qty - offs.length, key = r.id + "|" + it.roleIndex;
    const chips = offs.map(o => `<span class="chip"><span class="dot" style="--clr:${color(o.classId)}"></span>${esc(o.person)}
        <span class="from">${esc(className(o.classId))}</span>
        ${me === o.classId || mine ? `<button class="del" data-deloffer="${esc(o.id)}" title="Visszavonás">✕</button>` : ""}</span>`).join("");
    const empties = Array.from({ length: Math.max(0, missing) }, () => '<span class="chip empty">még kell</span>').join("");
    const action = missing > 0 && !mine ? (giving === key ? giveForm(r, it.roleIndex, key) : `<button class="give" data-give="${key}">Adok 1-et</button>`) : "";
    return `<div class="need"><div class="rname">${esc(it.role)}<small>${offs.length} / ${it.qty}</small></div><div class="slots">${chips}${empties}${action}</div></div>`;
  }).join("");
  return `<div class="card req ${r.date < today() ? "past" : ""}" style="--clr:${color(r.classId)}">
    <div class="req-head">
      <span class="who"><span class="dot" style="--clr:${color(r.classId)}"></span>${esc(className(r.classId))} kér</span>
      <span class="date">${fmtDate(r.date)}</span>
      <span class="pill ${r.shift === "Éjszaka" ? "night" : "day"}">${r.shift === "Éjszaka" ? "☾" : "☀︎"} ${esc(r.shift)}</span>
      <span class="badge ${got >= need ? "done" : "open"}">${got >= need ? "Teljesült" : `Még ${need - got} fő kell`}</span>
      <span class="spacer"></span>
      ${mine ? `<button class="del" data-delreq="${esc(r.id)}">Kérés törlése</button>` : ""}
    </div>${rows}${r.note ? `<div class="note">📝 ${esc(r.note)}</div>` : ""}</div>`;
}

// ------------------------------------------------------------------ Excel (CSV)
function exportCsv(onlyId) {
  const q = v => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const head = ["Dátum", "Napszak", "Kérő osztály", "Beosztás", "Adó osztály", "Név", "Megjegyzés"];
  if (onlyId) head.unshift("Mi történt");
  const lines = [head.map(q).join(";")];
  [...data.requests].sort((a, b) => a.date.localeCompare(b.date) || shiftOrder(a.shift) - shiftOrder(b.shift)).forEach(r => {
    items(r).forEach(it => {
      const offs = offersOf(r, it.roleIndex).sort((a, b) => a.slot - b.slot);
      for (let n = 0; n < it.qty; n++) {
        const o = offs[n];
        const row = [r.date, r.shift, className(r.classId), it.role, o ? className(o.classId) : "— még nincs —", o ? o.person : "", r.note];
        if (onlyId) {
          if (r.classId === onlyId) row.unshift(o ? "Kaptunk" : "Kértünk (még nincs meg)");
          else if (o && o.classId === onlyId) row.unshift("Adtunk");
          else continue;
        }
        lines.push(row.map(q).join(";"));
      }
    });
  });
  const name = onlyId ? "csere_" + className(onlyId).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\W+/g, "_").replace(/^_|_$/g, "") : "csere_osszes";
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name + ".csv" });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ műveletek
function submitGive(key) {
  const sel = document.querySelector("[data-give-select]"), inp = document.querySelector("[data-give-input]");
  let personId = sel.value, person = "";
  if (personId === "__other") { person = inp.value.trim(); personId = ""; if (!person) return inp.focus(); }
  else if (personId) person = people.find(p => p.id === personId)?.name || "";
  else return sel.focus();
  const [rid, ri] = key.split("|");
  const r = data.requests.find(x => x.id === rid);
  if (!r) return showError("Ez a kérés közben megszűnt.");
  const roleIndex = Number(ri), slot = freeSlot(r, roleIndex);
  if (slot < 0) return showError("Ebből már megvan a kért létszám.");
  run(async () => {
    await be.createOnly("offers", offerId(r.id, roleIndex, slot), {
      requestId: r.id, roleIndex, slot, classId: me, person: person.slice(0, 100), personId,
      date: r.date, shift: r.shift, toClassId: r.classId, createdAt: NOW
    });
    giving = null; render();
  });
}

function wire() {
  document.addEventListener("click", e => {
    const t = e.target.closest("button") || e.target;
    const d = t.dataset || {};
    if (d.export) { e.stopPropagation(); exportCsv(d.export); }
    else if (t.id === "exportAll") exportCsv(null);
    else if (d.shift) { shift = d.shift; render(); }
    else if (d.step) { const i = Number(d.ri); qty[i] = Math.max(0, Math.min(50, qty[i] + Number(d.step))); render(); }
    else if (d.status) { status = d.status; render(); }
    else if (d.give) { giving = d.give; render(); document.querySelector("[data-give-select]")?.focus(); }
    else if (d.giveok) submitGive(d.giveok);
    else if ("givecancel" in d) { giving = null; render(); }
    else if (d.deloffer) {
      const o = data.offers.find(x => x.id === d.deloffer);
      if (o && confirm(`Visszavonod: ${o.person}?`)) run(() => be.remove("offers", o.id));
    } else if (d.delreq) {
      const r = data.requests.find(x => x.id === d.delreq);
      if (r && confirm("Törlöd a kérést? A már felajánlott emberek is törlődnek róla.")) run(() =>
        be.batch([...offersOf(r).map(o => ({ op: "delete", col: "offers", id: o.id })), { op: "delete", col: "requests", id: r.id }]));
    } else if (t.id === "rSubmit") {
      if (!qty.some(n => n > 0)) return showError("Válaszd ki a + gombbal, miből hány főt kérsz.");
      const date = $("#rDate").value;
      if (!date) return showError("Add meg a napot.");
      run(async () => {
        await be.add("requests", { classId: me, date, shift, qty: [...qty], note: $("#rNote").value.trim().slice(0, 500), createdAt: NOW });
        qty = ROLES.map(() => 0); $("#rNote").value = ""; status = "open"; render();
      });
    } else {
      const card = e.target.closest(".cls");
      if (card) { $("#fClass").value = $("#fClass").value === card.dataset.cls ? "" : card.dataset.cls; render(); }
    }
  });
  document.addEventListener("change", e => {
    if (e.target.matches?.("[data-give-select]")) {
      const inp = document.querySelector("[data-give-input]");
      inp.hidden = e.target.value !== "__other"; if (!inp.hidden) inp.focus();
    }
  });
  document.addEventListener("keydown", e => {
    if (e.target.matches?.("[data-give-input], [data-give-select]")) {
      if (e.key === "Enter") { e.preventDefault(); submitGive(giving); }
      if (e.key === "Escape") { giving = null; render(); }
    }
  });
  $("#fClass").addEventListener("change", render);
  $("#fFrom").addEventListener("change", render);
  $("#rDate").value = today();
}

start({
  page: "index.html",
  onUser(backend, user) {
    be = backend; me = user.classId; giving = null;
    const since = addDays(today(), -RECENT_DAYS);
    // élő frissítés közben a félig kitöltött "Adok" mező megmarad
    const keep = fn => d => {
      const inp = document.querySelector("[data-give-input]"), sel = document.querySelector("[data-give-select]");
      const typed = inp ? [inp.value, inp.hidden] : null, chosen = sel ? sel.value : null;
      fn(d); render();
      const i2 = document.querySelector("[data-give-input]"), s2 = document.querySelector("[data-give-select]");
      if (i2 && typed) { i2.value = typed[0]; i2.hidden = typed[1]; }
      if (s2 && chosen != null) s2.value = chosen;
    };
    unsubs.push(
      be.watch("requests", [["date", ">=", since]], keep(d => { data.requests = d; }), showError),
      be.watch("offers", [["date", ">=", since]], keep(d => { data.offers = d; }), showError),
      be.watch("people", [["classId", "==", me]], keep(d => { people = d; }), showError)
    );
  },
  onLogout() { unsubs.forEach(u => u()); unsubs = []; me = null; }
});
wire();
