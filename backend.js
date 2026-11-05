// Adatkezelés: Firebase (éles) vagy próbamód (csak a saját gépen).
// Mindkettő ugyanazt az egyszerű felületet adja: watch / watchDoc / add / set / update / remove / batch.
import { firebaseConfig, CLASSES } from "./config.js";

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
  for (const c of CLASSES) {
    if (c.email.toLowerCase() === e) return { classId: c.id, role: "leader" };
    if (c.workerEmail && c.workerEmail.toLowerCase() === e) return { classId: c.id, role: "worker" };
  }
  return null;
}
export function emailFor(classId, role) {
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

// ---------------------------------------------------------------- Próbamód (memóriában)
function demoBackend() {
  const store = {};                 // col -> Map(id -> data)
  const listeners = new Set();
  let user = null, authCb = () => {};
  let n = 1;
  const colMap = c => (store[c] ||= new Map());
  const clone = v => JSON.parse(JSON.stringify(v));

  const resolve = v => {
    if (v === NOW) return { seconds: Date.now() / 1000 };
    if (v && typeof v === "object" && !Array.isArray(v)) { const o = {}; for (const k in v) if (v[k] !== DELETE) o[k] = resolve(v[k]); return o; }
    return v;
  };
  const deepMerge = (t, s) => {
    for (const k in s) {
      const v = s[k];
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
  const emit = () => setTimeout(() => listeners.forEach(l => l.fire()));

  const api = {
    isDemo: true,
    onAuth(cb) { authCb = cb; cb(user); return () => {}; },
    async login(classId, role) { user = { classId, role }; authCb(user); },
    async logout() { user = null; authCb(null); },
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
  // Próbamódhoz pár kitalált ember, hogy legyen mit nézni
  const names = ["Kovács Péter", "Nagy Éva", "Szabó Gábor", "Tóth Anna", "Horváth Bence", "Kiss Réka", "Varga Dániel", "Molnár Júlia"];
  ["o1", "o2", "o3", "o4"].forEach((cid, ci) => names.forEach((nm, i) =>
    colMap("people").set(`p${ci}${i}`, { classId: cid, name: `${nm} (${ci + 1})`, pattern: i % 2 ? "12" : "24", role: "", active: true })));
  return api;
}
