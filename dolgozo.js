// Beosztotti oldal: a beosztott kiválasztja magát az osztálya névsorából, és szabadságot kér.
import { NOW } from "./backend.js";
import { $, esc, store, run, showError, start, today, range, fmtDate } from "./common.js";

let be, me, people = [], leaves = [], unsubs = [];

const who = () => $("#who").value;

function render() {
  const sel = who() || store.get("dolgozo.who." + me) || "";
  const list = people.filter(p => p.active !== false).sort((a, b) => a.name.localeCompare(b.name, "hu"));
  $("#who").innerHTML = '<option value="">– válaszd ki –</option>' + list.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  $("#who").value = list.some(p => p.id === sel) ? sel : "";
  const pid = who();
  $("#formCard").hidden = !pid; $("#listCard").hidden = !pid;
  if (!pid) return;

  const mine = leaves.filter(l => l.personId === pid).sort((a, b) => b.from.localeCompare(a.from));
  const badge = s => s === "jóváhagyva" ? '<span class="badge done">jóváhagyva</span>' : s === "elutasítva" ? '<span class="badge no">elutasítva</span>' : '<span class="badge open">elbírálásra vár</span>';
  $("#mine").innerHTML = mine.length ? `<table class="plain"><thead><tr><th>Mettől</th><th>Meddig</th><th class="num">Nap</th><th>Típus</th><th>Állapot</th><th></th></tr></thead><tbody>
    ${mine.map(l => `<tr><td>${fmtDate(l.from)}</td><td>${fmtDate(l.to)}</td><td class="num">${range(l.from, l.to).length}</td><td>${esc(l.kind)}${l.note ? `<br><small class="muted">${esc(l.note)}</small>` : ""}</td>
      <td>${badge(l.status)}${l.status === "jóváhagyva" && l.szDays != null ? `<br><small class="muted">${l.szDays} nap szabadság${l.pDays ? `, ${l.pDays} pihenőnap` : ""}</small>` : ""}</td><td>${l.status === "függő" ? `<button class="small danger" data-withdraw="${l.id}">Visszavonom</button>` : ""}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty-list">Még nincs kérelmed.</div>`;
}

$("#who").addEventListener("change", () => { store.set("dolgozo.who." + me, who()); render(); });
$("#lForm").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target, p = people.find(x => x.id === who());
  if (!p) return showError("Előbb válaszd ki a nevedet.");
  const from = f.from.value, to = f.to.value;
  if (!from || !to || to < from) return showError("A „Meddig” nem lehet korábbi a „Mettől”-nél.");
  if (range(from, to).length > 60) return showError("Egyszerre legfeljebb 60 napot lehet kérni.");
  run(async () => {
    await be.add("leave", { classId: me, personId: p.id, personName: p.name, from, to, kind: f.kind.value, note: f.note.value.trim().slice(0, 300), status: "függő", createdAt: NOW });
    f.reset(); f.from.value = today();
  });
});
document.addEventListener("click", e => {
  const id = e.target.dataset?.withdraw;
  if (id && confirm("Visszavonod a kérelmet?")) run(() => be.remove("leave", id));
});

start({
  page: "dolgozo.html",
  onUser(backend, user) {
    be = backend; me = user.classId;
    $("#lForm").from.value = today();
    unsubs.push(
      be.watch("people", [["classId", "==", me]], d => { people = d; render(); }, showError),
      be.watch("leave", [["classId", "==", me]], d => { leaves = d; render(); }, showError)
    );
  },
  onLogout() { unsubs.forEach(u => u()); unsubs = []; }
});
