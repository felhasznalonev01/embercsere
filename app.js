import { CLASSES, ROLES, SHIFTS } from "./config.js";
import { createBackend } from "./backend.js";

const COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)"];
const DAYS = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];
const STATUS = [["open", "Nyitott"], ["all", "Mind"], ["done", "Teljesült"]];

let be;                                   // adatkezelő (Firebase vagy próbamód)
let me = null;                            // belépett osztály id
let data = { requests: [], offers: [] };
let unsubscribe = null;
let qty = ROLES.map(() => 0);             // új kérés darabszámai
let shift = SHIFTS[0];
let status = "open";
let giving = null;                        // nyitott "Adok" mező: requestId|roleIndex
let busy = false;

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const classOf = id => CLASSES.find(c => c.id === id);
const className = id => classOf(id)?.name || "?";
const color = id => COLORS[CLASSES.findIndex(c => c.id === id)] || "var(--muted)";
const today = () => new Date().toLocaleDateString("sv-SE");
const fmtDate = d => `${d.replaceAll("-", ".")}. <span class="muted">${DAYS[new Date(d + "T12:00").getDay()]}</span>`;
const items = r => (r.qty || []).map((n, i) => ({ roleIndex: i, role: ROLES[i] || `#${i + 1}`, qty: n })).filter(x => x.qty > 0);
const offersOf = (r, roleIndex) => data.offers.filter(o => o.requestId === r.id && (roleIndex == null || o.roleIndex === roleIndex));
const needed = r => (r.qty || []).reduce((a, b) => a + b, 0);
const isDone = r => offersOf(r).length >= needed(r);
const shiftOrder = s => SHIFTS.indexOf(s);

function showError(msg) {
  $("#errBanner").textContent = msg;
  $("#errBanner").hidden = !msg;
  if (msg) setTimeout(() => { if ($("#errBanner").textContent === msg) $("#errBanner").hidden = true; }, 8000);
}
async function run(fn) {
  if (busy) return;
  busy = true; document.body.style.cursor = "wait";
  try { await fn(); showError(""); } catch (e) { showError(e.message || String(e)); }
  finally { busy = false; document.body.style.cursor = ""; }
}

// ------------------------------------------------------------------ belépés
function showLogin() {
  $("#loginView").hidden = false; $("#appView").hidden = true;
  $("#loginClass").innerHTML = '<option value="">– válaszd ki az osztályodat –</option>' +
    CLASSES.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  $("#loginPass").closest("label").hidden = be.isDemo;
}
function showApp() {
  $("#loginView").hidden = true; $("#appView").hidden = false;
  $("#meName").textContent = className(me);
  $("#meName").style.setProperty("--clr", color(me));
  render();
}
$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const cid = $("#loginClass").value;
  if (!cid) return ($("#loginErr").textContent = "Válaszd ki az osztályt.");
  $("#loginBtn").disabled = true; $("#loginErr").textContent = "";
  try { await be.login(cid, $("#loginPass").value); $("#loginPass").value = ""; }
  catch (err) { $("#loginErr").textContent = err.message; }
  finally { $("#loginBtn").disabled = false; }
});
$("#logout").addEventListener("click", () => be.logout());

// ------------------------------------------------------------------ megjelenítés
function render() {
  if (!me) return;
  const fc = $("#fClass").value;
  $("#fClass").innerHTML = '<option value="">Mind</option>' + CLASSES.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  $("#fClass").value = fc;

  // Osztály összesítő: kért / kapott / adott fő
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

  // Új kérés
  $("#rShift").innerHTML = SHIFTS.map(s => `<button type="button" data-shift="${esc(s)}" class="${s === shift ? "on" : ""}">${s === "Éjszaka" ? "☾ " : "☀︎ "}${esc(s)}</button>`).join("");
  $("#rRoles").innerHTML = ROLES.map((role, i) => `<div class="role ${qty[i] ? "has" : ""}"><span>${esc(role)}</span>
      <span class="stepper"><button type="button" data-step="-1" data-ri="${i}">−</button><span>${qty[i]}</span><button type="button" data-step="1" data-ri="${i}">+</button></span></div>`).join("");
  const total = qty.reduce((a, b) => a + b, 0);
  $("#rSummary").textContent = total ? `Összesen ${total} főt kérsz (${className(me)} nevében)` : "";

  $("#fStatus").innerHTML = STATUS.map(([k, t]) => `<button type="button" data-status="${k}" class="${k === status ? "on" : ""}">${t}</button>`).join("");

  // Lista
  const from = $("#fFrom").value;
  const list = data.requests
    .filter(r => (!fc || r.classId === fc || offersOf(r).some(o => o.classId === fc)) && (!from || r.date >= from))
    .filter(r => status === "all" || (status === "done") === isDone(r))
    .sort((a, b) => a.date.localeCompare(b.date) || shiftOrder(a.shift) - shiftOrder(b.shift));

  $("#list").innerHTML = list.map(renderRequest).join("") ||
    `<div class="card empty-list">${status === "open" ? "Nincs nyitott kérés." : "Nincs ilyen kérés."}</div>`;

  const inp = giving && document.querySelector("[data-give-input]");
  if (inp) inp.focus();
}

function renderRequest(r) {
  const got = offersOf(r).length, need = needed(r);
  const mine = me === r.classId;
  const rows = items(r).map(it => {
    const offs = offersOf(r, it.roleIndex).sort((a, b) => a.slot - b.slot);
    const missing = it.qty - offs.length;
    const key = r.id + "|" + it.roleIndex;
    const chips = offs.map(o => `<span class="chip"><span class="dot" style="--clr:${color(o.classId)}"></span>${esc(o.person)}
        <span class="from">${esc(className(o.classId))}</span>
        ${me === o.classId || mine ? `<button class="del" data-deloffer="${esc(o.id)}" title="Visszavonás">✕</button>` : ""}</span>`).join("");
    const empties = Array.from({ length: Math.max(0, missing) }, () => '<span class="chip empty">még kell</span>').join("");
    let action = "";
    if (missing > 0 && !mine) {
      action = giving === key
        ? `<span class="give-form"><input data-give-input maxlength="100" placeholder="Ki megy? (név)"><button class="give" data-giveok="${key}">OK</button><button data-givecancel>Mégse</button></span>`
        : `<button class="give" data-give="${key}">Adok 1-et</button>`;
    }
    return `<div class="need"><div class="rname">${esc(it.role)}<small>${offs.length} / ${it.qty}</small></div>
      <div class="slots">${chips}${empties}${action}</div></div>`;
  }).join("");
  return `<div class="card req ${r.date < today() ? "past" : ""}" style="--clr:${color(r.classId)}">
    <div class="req-head">
      <span class="who"><span class="dot" style="--clr:${color(r.classId)}"></span>${esc(className(r.classId))} kér</span>
      <span class="date">${fmtDate(r.date)}</span>
      <span class="pill ${r.shift === "Éjszaka" ? "night" : "day"}">${r.shift === "Éjszaka" ? "☾" : "☀︎"} ${esc(r.shift)}</span>
      <span class="badge ${got >= need ? "done" : "open"}">${got >= need ? "Teljesült" : `Még ${need - got} fő kell`}</span>
      <span class="spacer"></span>
      ${mine ? `<button class="del" data-delreq="${esc(r.id)}">Kérés törlése</button>` : ""}
    </div>
    ${rows}
    ${r.note ? `<div class="note">📝 ${esc(r.note)}</div>` : ""}
  </div>`;
}

// ------------------------------------------------------------------ Excel (CSV) export
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
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ események
function submitGive(key) {
  const inp = document.querySelector("[data-give-input]");
  const person = inp.value.trim();
  if (!person) return inp.focus();
  const [rid, ri] = key.split("|");
  const request = data.requests.find(r => r.id === rid);
  if (!request) return showError("Ez a kérés közben megszűnt.");
  run(async () => { await be.addOffer({ request, roleIndex: Number(ri), classId: me, person }); giving = null; render(); });
}

document.addEventListener("click", e => {
  const t = e.target.closest("button") || e.target;
  const d = t.dataset || {};
  if (d.export) { e.stopPropagation(); exportCsv(d.export); }
  else if (t.id === "exportAll") exportCsv(null);
  else if (d.shift) { shift = d.shift; render(); }
  else if (d.step) { const i = Number(d.ri); qty[i] = Math.max(0, Math.min(50, qty[i] + Number(d.step))); render(); }
  else if (d.status) { status = d.status; render(); }
  else if (d.give) { giving = d.give; render(); }
  else if (d.giveok) submitGive(d.giveok);
  else if ("givecancel" in d) { giving = null; render(); }
  else if (d.deloffer) {
    const o = data.offers.find(x => x.id === d.deloffer);
    if (o && confirm(`Visszavonod: ${o.person}?`)) run(() => be.deleteOffer(o));
  } else if (d.delreq) {
    const r = data.requests.find(x => x.id === d.delreq);
    if (r && confirm("Törlöd a kérést? A már felajánlott emberek is törlődnek róla.")) run(() => be.deleteRequest(r));
  } else if (t.id === "rSubmit") {
    if (!qty.some(n => n > 0)) return showError("Válaszd ki a + gombbal, miből hány főt kérsz.");
    const date = $("#rDate").value;
    if (!date) return showError("Add meg a napot.");
    run(async () => {
      await be.addRequest({ classId: me, date, shift, qty: [...qty], note: $("#rNote").value.trim().slice(0, 500) });
      qty = ROLES.map(() => 0); $("#rNote").value = ""; status = "open"; render();
    });
  } else {
    const card = e.target.closest(".cls");
    if (card) { $("#fClass").value = $("#fClass").value === card.dataset.cls ? "" : card.dataset.cls; render(); }
  }
});
document.addEventListener("keydown", e => {
  if (e.target.matches("[data-give-input]")) {
    if (e.key === "Enter") submitGive(giving);
    if (e.key === "Escape") { giving = null; render(); }
  }
});
$("#fClass").addEventListener("change", render);
$("#fFrom").addEventListener("change", render);
$("#rDate").value = today();

// ------------------------------------------------------------------ indulás
(async () => {
  try { be = await createBackend(); }
  catch (e) {
    $("#errBanner").textContent = e.message.startsWith("Az oldal") ? e.message : "Nem sikerült betölteni a Firebase-t. Van internet? (" + e.message + ")";
    $("#errBanner").hidden = false;
    return;
  }
  $("#demoBanner").hidden = !be.isDemo;
  be.onAuth((user, problem) => {
    if (problem) $("#loginErr").textContent = problem;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    me = user ? user.classId : null;
    giving = null;
    if (!me) return showLogin();
    showApp();
    // Élő frissítés: a többi osztály változásai azonnal megjelennek
    unsubscribe = be.subscribe(d => {
      data = d;
      // ha épp nevet ír valaki, ne töröljük ki a mezőt
      const inp = document.querySelector("[data-give-input]");
      const typed = inp ? inp.value : null;
      render();
      const again = document.querySelector("[data-give-input]");
      if (again && typed != null) again.value = typed;
    }, msg => showError(msg));
  });
})();
