// Közös részek: belépés, menü, hibaüzenet, dátum-segédek.
import { CLASSES, FIXED_HOLIDAYS, KERET, ADMIN } from "./config.js";
import { createBackend } from "./backend.js";

export const COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)"];
export const DAYS = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];
export const DAYS_SHORT = ["V", "H", "K", "Sze", "Cs", "P", "Szo"];
export const $ = s => document.querySelector(s);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const classOf = id => CLASSES.find(c => c.id === id);
export const className = id => classOf(id)?.name || "?";
export const color = id => COLORS[CLASSES.findIndex(c => c.id === id)] || "var(--muted)";
export const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }
};

// ---------------------------------------------------------------- dátumok (YYYY-MM-DD szövegként)
export const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d, 12); };
export const today = () => iso(new Date());
export const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
export const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
export const range = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
export const monthKey = s => s.slice(0, 7);
export const weekday = s => parse(s).getDay();
export const fmtDate = s => `${s.replaceAll("-", ".")}. <span class="muted">${DAYS[weekday(s)]}</span>`;
export const monthsIn = (from, to) => { const out = []; for (let m = monthKey(from); m <= monthKey(to);) { out.push(m); const [y, mm] = m.split("-").map(Number); m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`; } return out; };
export const lastOfMonth = m => { const [y, mm] = m.split("-").map(Number); return iso(new Date(y, mm, 0, 12)); };

// Húsvét vasárnap (Gauss-féle számítás)
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(new Date(y, month - 1, day, 12));
}
const holidayCache = {};
export function isHoliday(s) {
  const y = Number(s.slice(0, 4));
  if (!holidayCache[y]) {
    const e = easter(y);
    holidayCache[y] = new Set([...FIXED_HOLIDAYS.map(md => `${y}-${md}`), addDays(e, -2), e, addDays(e, 1), addDays(e, 49), addDays(e, 50)]);
  }
  return holidayCache[y].has(s);
}
export const isWorkday = s => { const w = weekday(s); return w !== 0 && w !== 6 && !isHoliday(s); };

// Szolgálati sorrend: melyik osztály van szolgálatban az adott napon (7-től másnap 7-ig)
// rotation = { start: "YYYY-MM-DD", order: ["o1","o2","o3","o4"] }
export function dutyClassOf(rotation, s) {
  if (!rotation?.start || !rotation?.order?.length) return null;
  const n = rotation.order.length, i = ((daysBetween(rotation.start, s) % n) + n) % n;
  return rotation.order[i];
}

// A dátumot tartalmazó 4 havi munkaidőkeret első és utolsó napja
export function keretOf(s) {
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7));
  const idx = Math.floor(((m - KERET.firstMonth + 12) % 12) / KERET.months);
  let sm = KERET.firstMonth + idx * KERET.months, sy = y;
  if (sm > 12) sm -= 12;
  if (sm > m) sy -= 1;
  const start = `${sy}-${String(sm).padStart(2, "0")}-01`;
  let em = sm + KERET.months - 1, ey = sy;
  if (em > 12) { em -= 12; ey += 1; }
  return { from: start, to: lastOfMonth(`${ey}-${String(em).padStart(2, "0")}`) };
}

// ---------------------------------------------------------------- hibaüzenet / várakozás
export function showError(msg) {
  const el = $("#errBanner"); if (!el) return alert(msg);
  el.textContent = msg; el.hidden = !msg;
  if (msg) setTimeout(() => { if (el.textContent === msg) el.hidden = true; }, 9000);
}
let busy = false;
export async function run(fn) {
  if (busy) return;
  busy = true; document.body.style.cursor = "wait";
  try { await fn(); showError(""); } catch (e) { showError(e.message || String(e)); }
  finally { busy = false; document.body.style.cursor = ""; }
}

// ---------------------------------------------------------------- belépés + menü
const PAGES = [
  { href: "index.html", title: "Embercsere", roles: ["leader"] },
  { href: "szolgalat.html", title: "Szolgálatbeosztás", roles: ["leader", "admin"] },
  { href: "dolgozo.html", title: "Szabadságkérelem", roles: ["leader", "worker"] }
];

// page: a PAGES href-je; onUser(be, user) belépéskor, onLogout() kilépéskor
export async function start({ page, onUser, onLogout }) {
  const allowed = PAGES.find(p => p.href === page).roles;
  document.body.insertAdjacentHTML("afterbegin", `
    <div class="topbar" id="topbar" hidden>
      <nav id="nav"></nav>
      <div class="me"><span class="muted" id="meRole"></span><b id="meName"></b><button id="logout">Kilépés</button></div>
    </div>
    <main class="banners">
      <div class="banner" id="demoBanner" hidden><b>Próbamód:</b> ez csak a saját gépeden látszik, semmi nem mentődik, jelszó nélkül be lehet lépni. A kitalált adatok a böngészőfül bezárásáig megmaradnak.</div>
      <div class="banner error" id="errBanner" hidden></div>
    </main>
    <section class="card login" id="loginView" hidden>
      <h1 style="margin-bottom:16px">Belépés</h1>
      <form id="loginForm">
        <label>Ki vagy? <select id="loginRole">
          <option value="leader">Osztályvezető</option><option value="worker">Dolgozó</option>${ADMIN ? `<option value="admin">${esc(ADMIN.name)} (minden osztály)</option>` : ""}
        </select></label>
        <label id="classLabel">Osztály <select id="loginClass">
          <option value="">– válaszd ki –</option>${CLASSES.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
        </select></label>
        <label id="passLabel">Jelszó <input type="password" id="loginPass" autocomplete="current-password"></label>
        <button class="primary" id="loginBtn">Belépés</button>
        <div class="err" id="loginErr"></div>
      </form>
    </section>`);
  $("#loginRole").value = store.get("role") || (allowed.includes("leader") ? "leader" : "worker");
  $("#loginClass").value = store.get("class") || "";
  const syncRole = () => { $("#classLabel").hidden = $("#loginRole").value === "admin"; };
  $("#loginRole").addEventListener("change", syncRole); syncRole();

  let be;
  try { be = await createBackend(); }
  catch (e) { showError(e.message.startsWith("Az oldal") ? e.message : "Nem sikerült betölteni a Firebase-t. Van internet? (" + e.message + ")"); return; }
  $("#demoBanner").hidden = !be.isDemo;
  $("#passLabel").hidden = be.isDemo;

  $("#loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    const cid = $("#loginClass").value, role = $("#loginRole").value;
    if (!cid && role !== "admin") return ($("#loginErr").textContent = "Válaszd ki az osztályt.");
    store.set("class", cid); store.set("role", role);
    $("#loginBtn").disabled = true; $("#loginErr").textContent = "";
    try { await be.login(cid, role, $("#loginPass").value); $("#loginPass").value = ""; }
    catch (err) { $("#loginErr").textContent = err.message; }
    finally { $("#loginBtn").disabled = false; }
  });
  $("#logout").addEventListener("click", () => be.logout());

  const keep = location.search;  // ?proba megtartása oldalváltáskor
  be.onAuth((user, problem) => {
    if (problem) $("#loginErr").textContent = problem;
    if (!user) {
      $("#loginView").hidden = false; $("#topbar").hidden = true; $("#app").hidden = true;
      onLogout && onLogout();
      return;
    }
    if (!allowed.includes(user.role)) {
      // Mindenki a neki szóló oldalra kerül
      location.href = (user.role === "admin" ? "szolgalat.html" : "dolgozo.html") + keep;
      return;
    }
    $("#loginView").hidden = true; $("#topbar").hidden = false; $("#app").hidden = false;
    $("#nav").innerHTML = PAGES.filter(p => p.roles.includes(user.role))
      .map(p => `<a href="${p.href}${keep}" class="${p.href === page ? "on" : ""}">${p.title}</a>`).join("");
    $("#meRole").textContent = user.role === "leader" ? "Osztályvezető:" : user.role === "admin" ? "" : "Dolgozó:";
    $("#meName").textContent = user.role === "admin" ? ADMIN.name : className(user.classId);
    $("#meName").style.setProperty("--clr", color(user.classId));
    onUser(be, user);
  });
}
