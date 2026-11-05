// Adatkezelés: Firebase (éles) vagy próbamód (csak a saját gépen).
// Mindkettő ugyanazt az egyszerű felületet adja: watch / watchDoc / add / set / update / remove / batch.
import { firebaseConfig, CLASSES, ADMIN } from "./config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const notConfigured = !firebaseConfig.apiKey || firebaseConfig.apiKey === "IDE_JON";
// Próbamód csak a saját gépen (localhost) indulhat – feltöltve soha.
const isLocal = ["localhost", "127.0.0.1", "[::1]", ""].includes(location.hostname);
export const isDemo = isLocal && (notConfigured || new URLSearchParams(location.search).has("proba"));

// Különleges értékek: szerver ideje / mező törlése
export const NOW = { __now: true };
export const DELETE = { __delete: true };

// Melyik fiók melyik osztály és milyen szerepben
export function accountOf(email) {
  const e = String(email || "").toLowerCase();
  if (ADMIN && ADMIN.email.toLowerCase() === e) return { classId: null, role: "admin" };
  for (const c of CLASSES) {
    if (c.email.toLowerCase() === e) return { classId: c.id, role: "leader" };
    if (c.workerEmail && c.workerEmail.toLowerCase() === e) return { classId: c.id, role: "worker" };
  }
  return null;
}
export function emailFor(classId, role) {
  if (role === "admin") return ADMIN.email;
  const c = CLASSES.find(x => x.id === classId);
  return role === "worker" ? c.workerEmail : c.email;
}

export async function createBackend() {
  if (notConfigured && !isLocal) throw new Error("Az oldal még nincs beállítva (config.js). Szólj a gazdájának.");
  return isDemo ? demoBackend() : firebaseBackend();
}

function friendly(e) {
  const code = (e && e.code) || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "Hibás jelszó.";
  if (code.includes("missing-password")) return "Írd be a jelszót.";
  if (code.includes("too-many-requests")) return "Túl sok próbálkozás, várj pár percet.";
  if (code.includes("permission-denied")) return "Ezt nem teheted meg (vagy közben valaki más már módosította). Próbáld újra.";
  if (code.includes("network") || code.includes("unavailable")) return "Nincs internetkapcsolat.";
  if (code.includes("invalid-email")) return "Hibás e-mail formátum a config.js-ben.";
  if (code.includes("operation-not-allowed")) return "A Firebase-ben nincs bekapcsolva az Email/Password belépés.";
  if (code.includes("unauthorized-domain") || code.includes("requests-from-referer")) return "Ez a webcím nincs engedélyezve a Firebase-ben (Authentication → Settings → Authorized domains). Kód: " + code;
  if (code.includes("api-key")) return "A config.js-ben lévő apiKey hibás. Kód: " + code;
  if (code.includes("failed-precondition")) return "A Firebase-nek ehhez indexre van szüksége. Kód: " + code;
  return "Hiba történt: " + (code || (e && e.message) || e);
}
const wrap = fn => async (...a) => { try { return await fn(...a); } catch (e) { throw new Error(friendly(e)); } };

// ---------------------------------------------------------------- Firebase
async function firebaseBackend() {
  const { initializeApp } = await import(SDK + "firebase-app.js");
  const A = await import(SDK + "firebase-auth.js");
  const F = await import(SDK + "firebase-firestore.js");
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);

  // NOW / DELETE átalakítása Firebase-értékekké
  const conv = v => {
    if (v === NOW) return F.serverTimestamp();
    if (v === DELETE) return F.deleteField();
    if (v && typeof v === "object" && !Array.isArray(v)) { const o = {}; for (const k in v) o[k] = conv(v[k]); return o; }
    return v;
  };
  const q = (col, filters = []) => F.query(F.collection(db, col), ...filters.map(([f, op, v]) => F.where(f, op, v)));
  const docs = s => s.docs.map(d => ({ id: d.id, ...d.data() }));

  return {
    isDemo: false,
    onAuth(cb) {
      return A.onAuthStateChanged(auth, u => {
        if (!u) return cb(null);
        const acc = accountOf(u.email);
        if (!acc) {
          A.signOut(auth);
          return cb(null, `A(z) „${u.email}” fiók nincs osztályhoz rendelve a config.js-ben.`);
        }
        cb(acc);
      });
    },
    login: wrap((classId, role, password) => A.signInWithEmailAndPassword(auth, emailFor(classId, role), password)),
    logout: () => A.signOut(auth),

    watch(col, filters, cb, onErr) {
      return F.onSnapshot(q(col, filters), s => cb(docs(s)), e => onErr && onErr(friendly(e)));
    },
    watchDoc(col, id, cb, onErr) {
      return F.onSnapshot(F.doc(db, col, id), s => cb(s.exists() ? { id: s.id, ...s.data() } : null), e => onErr && onErr(friendly(e)));
    },
    add: wrap(async (col, data) => (await F.addDoc(F.collection(db, col), conv(data))).id),
    set: wrap((col, id, data, merge = false) => F.setDoc(F.doc(db, col, id), conv(data), { merge })),
    // createOnly: ha már létezik, a szabályok elutasítják (módosítás ott tiltott)
    createOnly: wrap((col, id, data) => F.setDoc(F.doc(db, col, id), conv(data))),
    update: wrap((col, id, patch) => F.updateDoc(F.doc(db, col, id), conv(patch))),
    remove: wrap((col, id) => F.deleteDoc(F.doc(db, col, id))),
    batch: wrap(async ops => {
      for (let i = 0; i < ops.length; i += 450) {   // egy köteg legfeljebb 500 művelet
        const b = F.writeBatch(db);
        for (const o of ops.slice(i, i + 450)) {
          const ref = F.doc(db, o.col, o.id);
          if (o.op === "delete") b.delete(ref);
          else if (o.op === "update") b.update(ref, conv(o.data));
          else b.set(ref, conv(o.data), { merge: !!o.merge });
        }
        await b.commit();
      }
    })
  };
}

// ---------------------------------------------------------------- Próbamód (a böngészőfülben tárolva)
const DEMO_KEY = "embercsere-proba-v8";
function demoBackend() {
  const ss = { get: k => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} } };
  const store = {};                 // col -> Map(id -> data)
  const listeners = new Set();
  let n = 1;
  const colMap = c => (store[c] ||= new Map());
  const clone = v => JSON.parse(JSON.stringify(v));
  const save = () => ss.set(DEMO_KEY, JSON.stringify({ n, store: Object.fromEntries(Object.entries(store).map(([c, m]) => [c, Object.fromEntries(m)])) }));
  const saved = ss.get(DEMO_KEY);
  if (saved) {
    const o = JSON.parse(saved); n = o.n;
    for (const c in o.store) store[c] = new Map(Object.entries(o.store[c]));
  } else { seedDemo(colMap); save(); }
  let user = JSON.parse(ss.get(DEMO_KEY + "-user") || "null"), authCb = () => {};

  const resolve = v => {
    if (v === NOW) return { seconds: Date.now() / 1000 };
    if (v && typeof v === "object" && !Array.isArray(v)) { const o = {}; for (const k in v) if (v[k] !== DELETE) o[k] = resolve(v[k]); return o; }
    return v;
  };
  const deepMerge = (t, src) => {
    for (const k in src) {
      const v = src[k];
      if (v === DELETE) delete t[k];
      else if (v && typeof v === "object" && !Array.isArray(v) && v !== NOW && t[k] && typeof t[k] === "object" && !Array.isArray(t[k])) deepMerge(t[k], v);
      else t[k] = resolve(v);
    }
    return t;
  };
  const setPath = (obj, path, val) => {
    const parts = path.split("."); let o = obj;
    for (const p of parts.slice(0, -1)) o = (o[p] ||= {});
    const last = parts[parts.length - 1];
    if (val === DELETE) delete o[last]; else o[last] = resolve(val);
  };
  const match = (d, filters) => filters.every(([f, op, v]) => {
    const x = f.split(".").reduce((o, k) => o?.[k], d);
    return op === "==" ? x === v : op === ">=" ? x >= v : op === "<=" ? x <= v : op === "in" ? v.includes(x) : true;
  });
  const emit = () => { save(); setTimeout(() => listeners.forEach(l => l.fire())); };

  const api = {
    isDemo: true,
    onAuth(cb) { authCb = cb; cb(user); return () => {}; },
    async login(classId, role) { user = role === "admin" ? { classId: null, role } : { classId, role }; ss.set(DEMO_KEY + "-user", JSON.stringify(user)); authCb(user); },
    async logout() { user = null; ss.set(DEMO_KEY + "-user", "null"); authCb(null); },
    watch(col, filters, cb) {
      const l = { fire: () => cb([...colMap(col)].filter(([, d]) => match(d, filters || [])).map(([id, d]) => ({ id, ...clone(d) }))) };
      listeners.add(l); setTimeout(l.fire); return () => listeners.delete(l);
    },
    watchDoc(col, id, cb) {
      const l = { fire: () => { const d = colMap(col).get(id); cb(d ? { id, ...clone(d) } : null); } };
      listeners.add(l); setTimeout(l.fire); return () => listeners.delete(l);
    },
    async add(col, data) { const id = "d" + n++; colMap(col).set(id, resolve(data)); emit(); return id; },
    async set(col, id, data, merge = false) {
      const m = colMap(col);
      m.set(id, merge && m.has(id) ? deepMerge(m.get(id), data) : deepMerge({}, data)); emit();
    },
    async createOnly(col, id, data) {
      if (colMap(col).has(id)) throw new Error("Közben valaki már betöltötte ezt a helyet. Próbáld újra.");
      return api.set(col, id, data);
    },
    async update(col, id, patch) {
      const d = colMap(col).get(id); if (!d) throw new Error("Nem található.");
      for (const k in patch) setPath(d, k, patch[k]); emit();
    },
    async remove(col, id) { colMap(col).delete(id); emit(); },
    async batch(ops) {
      for (const o of ops) {
        if (o.op === "delete") colMap(o.col).delete(o.id);
        else if (o.op === "update") { const d = colMap(o.col).get(o.id); if (d) for (const k in o.data) setPath(d, k, o.data[k]); }
        else { const m = colMap(o.col); m.set(o.id, o.merge && m.has(o.id) ? deepMerge(m.get(o.id), o.data) : deepMerge({}, o.data)); }
      }
      emit();
    }
  };
  return api;
}

// Kitalált próbaadatok: 4 osztály × 20 ember, 3 hónap beosztás, cserék, szabadságok
function seedDemo(colMap) {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const pad = x => String(x).padStart(2, "0");
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const add = (s, k) => { const [y, m, d] = s.split("-").map(Number); return iso(new Date(y, m - 1, d + k, 12)); };
  const now = new Date(), t0 = iso(now);
  const start = iso(new Date(now.getFullYear(), 0, 1, 12));      // az egész év (statisztikához)
  const end = iso(new Date(now.getFullYear(), now.getMonth() + 2, 0, 12));
  const last = ["Kovács", "Nagy", "Szabó", "Tóth", "Horváth", "Varga", "Kiss", "Molnár", "Németh", "Farkas", "Balogh", "Papp", "Takács", "Juhász", "Lakatos", "Mészáros", "Oláh", "Simon", "Rácz", "Fekete"];
  const first = ["Péter", "Anna", "Gábor", "Éva", "Bence", "Réka", "Dániel", "Júlia", "Tamás", "Zsófia", "László", "Katalin", "Attila", "Eszter", "Zoltán", "Nóra", "Balázs", "Viktória", "Ádám", "Krisztina"];
  const roles = ["Irányító", "Régió parancsnok", "020-as", "009-es", "Ügyeletvezető helyettes"];
  const classes = ["o1", "o2", "o3", "o4"];
  const ppl = {};
  const rosterCell = (cid, pid, d, val) => {
    const m = d.slice(0, 7), id = `${cid}_${m}`, mp = colMap("roster");
    if (!mp.has(id)) mp.set(id, { classId: cid, month: m, cells: {} });
    (mp.get(id).cells[pid] ||= {})[d.slice(8)] = val;
  };
  const getCell = (cid, pid, d) => colMap("roster").get(`${cid}_${d.slice(0, 7)}`)?.cells?.[pid]?.[d.slice(8)];
  // szolgálati sorrend: a kezdőnaptól o1, o2, o3, o4, o1, ...
  colMap("settings").set("rotation", { start, order: classes });
  colMap("settings").set("limits", { maxOvertime: 136, share200: 33, period: "year" });
  const duty = d => classes[((Math.round((new Date(d + "T12:00") - new Date(start + "T12:00")) / 86400000) % 4) + 4) % 4];
  classes.forEach((cid, ci) => {
    colMap("classSettings").set(cid, { classId: cid, target: 17 });
    ppl[cid] = [];
    for (let i = 0; i < 20; i++) {
      const id = `p${ci}_${i}`, pattern = i % 5 < 3 ? "24" : "12";
      // érvényességek: többnyire jövőbeli dátum, néhány hamarosan lejár vagy már lejárt
      const ex = () => { const r = rnd(); return add(t0, r < 0.08 ? -Math.floor(rnd() * 40) - 1 : r < 0.18 ? Math.floor(rnd() * 28) + 1 : Math.floor(rnd() * 600) + 40); };
      const p = { classId: cid, name: `${pick(last)} ${pick(first)}`, pattern, role: i < 10 ? roles[i % roles.length] : "", active: true,
        leaveDays: 25 + Math.floor(rnd() * 11), exams: { pszich: ex(), eu: ex(), fiz: ex(), lo: ex() } };
      colMap("people").set(id, p); ppl[cid].push({ id, ...p });
      // a saját osztály szolgálati napján dolgozik: 24 órások 24-et, 12 órások felváltva N / É
      let k = 0;
      for (let d = start; d <= end; d = add(d, 1)) {
        if (duty(d) === cid) { rosterCell(cid, id, d, { c: pattern === "24" ? "24" : ((k + i) % 2 ? "É" : "N") }); k++; }
      }
    }
    // néhány szabadság, betegség, túlóra
    for (let j = 0; j < 5; j++) {
      const p = pick(ppl[cid]), from = add(t0, Math.floor(rnd() * 40) - 15), len = 4 + Math.floor(rnd() * 6);
      for (let x = 0; x < len; x++) if (getCell(cid, p.id, add(from, x))) rosterCell(cid, p.id, add(from, x), { c: j === 4 ? "B" : "SZ" });
    }
    // szabadság az év során: 2–4 alkalommal 2–4 szolgálati nap
    ppl[cid].forEach(p => {
      const times = 2 + Math.floor(rnd() * 3);
      for (let j = 0; j < times; j++) {
        let d = add(`${now.getFullYear()}-01-01`, Math.floor(rnd() * 330)), k = 0, len = 2 + Math.floor(rnd() * 3);
        for (let x = 0; x < 20 && k < len; x++, d = add(d, 1)) if (getCell(cid, p.id, d) && d <= end) { rosterCell(cid, p.id, d, { c: "SZ" }); k++; }
      }
    });
    // túlóra: szolgálat utáni napon behívva (200%) vagy később (100%); pár embernek sok
    const yearStart = `${now.getFullYear()}-01-01`;
    const otCount = i => i === 0 || i === 7 ? 7 : i === 4 ? 5 : i % 3 === 0 ? 3 : 1 + Math.floor(rnd() * 2);
    ppl[cid].forEach((p, i) => {
      for (let j = 0; j < otCount(i); j++) {
        let d = add(yearStart, Math.floor(rnd() * Math.max(10, (Math.round((new Date(end + "T12:00") - new Date(yearStart + "T12:00")) / 86400000) - 10))));
        while (duty(d) !== cid) d = add(d, 1);
        const gap = rnd() < 0.33 ? 1 : 2;                  // 1 nappal utána → 200%, 2 nappal → 100%
        const od = add(d, gap);
        if (od <= end && !getCell(cid, p.id, od)) rosterCell(cid, p.id, od, { c: p.pattern === "24" ? "24" : "N", t: true });
      }
    });
    // szabadságkérelmek
    const lp = ppl[cid];
    colMap("leave").set(`l${ci}a`, { classId: cid, personId: lp[3].id, personName: lp[3].name, from: add(t0, 10), to: add(t0, 14), kind: "Szabadság", note: "családi program", status: "függő", createdAt: { seconds: 0 } });
    colMap("leave").set(`l${ci}b`, { classId: cid, personId: lp[7].id, personName: lp[7].name, from: add(t0, 20), to: add(t0, 21), kind: "Egyéb távollét", note: "", status: "függő", createdAt: { seconds: 0 } });
    colMap("leave").set(`l${ci}c`, { classId: cid, personId: lp[11].id, personName: lp[11].name, from: add(t0, -5), to: add(t0, -2), kind: "Szabadság", note: "", status: "jóváhagyva", createdAt: { seconds: 0 } });
  });
  // embercsere: kérések és felajánlások
  const nextDuty = (cid, from) => { let d = from; while (duty(d) !== cid) d = add(d, 1); return d; };
  const reqs = [
    { id: "r1", classId: "o1", date: nextDuty("o1", add(t0, 1)), shift: "Nappal", qty: [0, 0, 2, 0, 0], note: "szabadságok miatt" },
    { id: "r2", classId: "o3", date: nextDuty("o3", add(t0, 3)), shift: "Éjszaka", qty: [1, 0, 0, 0, 0], note: "" },
    { id: "r3", classId: "o2", date: nextDuty("o2", t0), shift: "Nappal", qty: [0, 0, 0, 1, 0], note: "" },
    { id: "r4", classId: "o4", date: nextDuty("o4", add(t0, -4)), shift: "Éjszaka", qty: [0, 0, 1, 0, 1], note: "" }
  ];
  reqs.forEach(r => colMap("requests").set(r.id, { classId: r.classId, date: r.date, shift: r.shift, qty: r.qty, note: r.note, createdAt: { seconds: 0 } }));
  const give = (r, roleIndex, slot, fromCid, pIdx) => {
    const p = ppl[fromCid][pIdx];
    colMap("offers").set(`${r.id}_${roleIndex}_${slot}`, { requestId: r.id, roleIndex, slot, classId: fromCid, person: p.name, personId: p.id, date: r.date, shift: r.shift, toClassId: r.classId, createdAt: { seconds: 0 } });
  };
  give(reqs[0], 2, 0, "o4", 2);
  give(reqs[2], 3, 0, "o1", 3);
  give(reqs[3], 2, 0, "o2", 4);
  give(reqs[3], 4, 0, "o1", 5);
}
