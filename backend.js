// Adatkezelés: Firebase (éles) vagy próbamód (ha a config.js nincs kitöltve).
import { firebaseConfig, CLASSES } from "./config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const notConfigured = !firebaseConfig.apiKey || firebaseConfig.apiKey === "IDE_JON";
// Próbamód csak a saját gépen (localhost) indulhat – feltöltve soha.
const isLocal = ["localhost", "127.0.0.1", "[::1]", ""].includes(location.hostname);
export const isDemo = isLocal && (notConfigured || new URLSearchParams(location.search).has("proba"));

export async function createBackend() {
  if (notConfigured && !isLocal) throw new Error("Az oldal még nincs beállítva (config.js). Szólj a gazdájának.");
  return isDemo ? demoBackend() : firebaseBackend();
}

const classByEmail = email => CLASSES.find(c => c.email.toLowerCase() === String(email || "").toLowerCase());
const offerId = (requestId, roleIndex, slot) => `${requestId}_${roleIndex}_${slot}`;

// Az első szabad hely egy beosztáson belül
function freeSlot(request, roleIndex, offers) {
  const taken = new Set(offers.filter(o => o.requestId === request.id && o.roleIndex === roleIndex).map(o => o.slot));
  for (let s = 0; s < (request.qty[roleIndex] || 0); s++) if (!taken.has(s)) return s;
  return -1;
}


// ---------------------------------------------------------------- Firebase
async function firebaseBackend() {
  const { initializeApp } = await import(SDK + "firebase-app.js");
  const A = await import(SDK + "firebase-auth.js");
  const F = await import(SDK + "firebase-firestore.js");

  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  let last = { requests: [], offers: [] };

  const friendly = e => {
    const code = e && e.code || "";
    if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found"))
      return "Hibás jelszó.";
    if (code.includes("too-many-requests")) return "Túl sok próbálkozás, várj pár percet.";
    if (code.includes("permission-denied")) return "Ezt nem teheted meg (vagy közben valaki más már módosította). Próbáld újra.";
    if (code.includes("network") || code.includes("unavailable")) return "Nincs internetkapcsolat.";
    if (code.includes("missing-password")) return "Írd be a jelszót.";
    if (code.includes("invalid-email")) return "Hibás e-mail formátum a config.js-ben.";
    if (code.includes("operation-not-allowed")) return "A Firebase-ben nincs bekapcsolva az Email/Password belépés.";
    if (code.includes("unauthorized-domain") || code.includes("requests-from-referer")) return "Ez a webcím nincs engedélyezve a Firebase-ben (Authentication → Settings → Authorized domains). Kód: " + code;
    if (code.includes("api-key")) return "A config.js-ben lévő apiKey hibás. Kód: " + code;
    return "Hiba történt: " + (code || (e && e.message) || e);
  };
  const wrap = fn => async (...a) => { try { return await fn(...a); } catch (e) { throw new Error(friendly(e)); } };

  return {
    isDemo: false,
    onAuth(cb) {
      return A.onAuthStateChanged(auth, u => {
        const c = u && classByEmail(u.email);
        if (u && !c) {
          // Belépett, de ez a fiók nincs a config.js-ben
          A.signOut(auth);
          return cb(null, `A(z) „${u.email}” fiók nincs osztályhoz rendelve. A Firebase-ben pontosan így kell lennie: osztaly1@example.com … osztaly4@example.com`);
        }
        cb(c ? { classId: c.id } : null);
      });
    },
    login: wrap(async (classId, password) => {
      const c = CLASSES.find(x => x.id === classId);
      await A.signInWithEmailAndPassword(auth, c.email, password);
    }),
    logout: () => A.signOut(auth),

    subscribe(cb, onError) {
      let requests = null, offers = null;
      const emit = () => { if (requests && offers) { last = { requests, offers }; cb(last); } };
      const err = e => onError && onError(friendly(e));
      const u1 = F.onSnapshot(F.collection(db, "requests"),
        s => { requests = s.docs.map(d => ({ id: d.id, ...d.data() })); emit(); }, err);
      const u2 = F.onSnapshot(F.collection(db, "offers"),
        s => { offers = s.docs.map(d => ({ id: d.id, ...d.data() })); emit(); }, err);
      return () => { u1(); u2(); };
    },

    addRequest: wrap(async ({ classId, date, shift, qty, note }) => {
      await F.addDoc(F.collection(db, "requests"),
        { classId, date, shift, qty, note, createdAt: F.serverTimestamp() });
    }),

    deleteRequest: wrap(async request => {
      const batch = F.writeBatch(db);
      last.offers.filter(o => o.requestId === request.id).forEach(o => batch.delete(F.doc(db, "offers", o.id)));
      batch.delete(F.doc(db, "requests", request.id));
      await batch.commit();
    }),

    addOffer: wrap(async ({ request, roleIndex, classId, person }) => {
      const slot = freeSlot(request, roleIndex, last.offers);
      if (slot < 0) throw { code: "permission-denied" };
      // Ha valaki közben ugyanerre a helyre adott, a szabályok elutasítják.
      await F.setDoc(F.doc(db, "offers", offerId(request.id, roleIndex, slot)),
        { requestId: request.id, roleIndex, slot, classId, person, createdAt: F.serverTimestamp() });
    }),

    deleteOffer: wrap(async offer => { await F.deleteDoc(F.doc(db, "offers", offer.id)); })
  };
}

// ---------------------------------------------------------------- Próbamód
function demoBackend() {
  const data = { requests: [], offers: [] };
  let user = null, authCb = () => {}, listeners = new Set();
  const emit = () => listeners.forEach(cb => cb({ requests: [...data.requests], offers: [...data.offers] }));
  let n = 100;

  return {
    isDemo: true,
    onAuth(cb) { authCb = cb; cb(user); return () => {}; },
    async login(classId) { user = { classId }; authCb(user); },
    async logout() { user = null; authCb(null); },
    subscribe(cb) { listeners.add(cb); setTimeout(emit); return () => listeners.delete(cb); },
    async addRequest(r) { data.requests.push({ id: "r" + n++, ...r, createdAt: null }); emit(); },
    async deleteRequest(r) {
      data.requests = data.requests.filter(x => x.id !== r.id);
      data.offers = data.offers.filter(o => o.requestId !== r.id); emit();
    },
    async addOffer({ request, roleIndex, classId, person }) {
      const slot = freeSlot(request, roleIndex, data.offers);
      if (slot < 0) throw new Error("Ebből már megvan a kért létszám.");
      data.offers.push({ id: offerId(request.id, roleIndex, slot), requestId: request.id, roleIndex, slot, classId, person });
      emit();
    },
    async deleteOffer(o) { data.offers = data.offers.filter(x => x.id !== o.id); emit(); }
  };
}
