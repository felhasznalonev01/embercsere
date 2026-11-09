// Push értesítések az osztályvezetőknek (Firebase Cloud Functions, Blaze csomag).
// Akkor fut, amikor új kérés / szabadságkérelem / felajánlás jön létre az adatbázisban.
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
// Az adatbázis az "eur3" (európai) helyen van → európai régió
setGlobalOptions({ region: "europe-west1", maxInstances: 2, memory: "256MiB" });

const CLASSES = { o1: "1. osztály", o2: "2. osztály", o3: "3. osztály", o4: "4. osztály" };
const ROLES = ["Irányító", "Régió parancsnok", "020-as", "009-es", "Ügyeletvezető helyettes", "Osztályvezető", "Ügyeletvezető"];
const day = d => `${String(d).slice(5).replace("-", ".")}.`;
const roleList = qty => (qty || []).map((n, i) => (n ? `${n} db ${ROLES[i] || "?"}` : "")).filter(Boolean).join(", ");

// Értesítés küldése a megadott osztályok vezetőinek minden regisztrált készülékére
async function sendTo(classIds, { title, body, url, tag }) {
  if (!classIds.length) return;
  const snap = await db.collection("pushTokens").where("classId", "in", classIds).get();
  const tokens = snap.docs.map(d => d.id);
  if (!tokens.length) return;
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    data: { title, body, url: url || "./", tag: tag || "" },
    webpush: { headers: { Urgency: "high", TTL: "86400" } }
  });
  // Lejárt / törölt készülékek eltávolítása
  const dead = [];
  res.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (code && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(code)) dead.push(tokens[i]);
  });
  await Promise.all(dead.map(t => db.collection("pushTokens").doc(t).delete().catch(() => {})));
}

// Egy osztály embert kér → a másik 3 osztály vezetője kap értesítést
exports.ujKeres = onDocumentCreated("requests/{id}", async e => {
  const r = e.data && e.data.data(); if (!r) return;
  const others = Object.keys(CLASSES).filter(c => c !== r.classId);
  await sendTo(others, {
    title: `${CLASSES[r.classId] || "Egy osztály"} embert kér`,
    body: `${day(r.date)} ${r.shift}: ${roleList(r.qty)}${r.note ? ` – ${r.note}` : ""}`,
    url: "index.html", tag: "req-" + e.params.id
  });
});

// Szabadságkérelem → a saját osztály vezetője kap értesítést
exports.ujSzabadsag = onDocumentCreated("leave/{id}", async e => {
  const l = e.data && e.data.data(); if (!l) return;
  await sendTo([l.classId], {
    title: "Új szabadságkérelem",
    body: `${l.personName}: ${day(l.from)} – ${day(l.to)} (${l.kind})`,
    url: "szolgalat.html", tag: "leave-" + e.params.id
  });
});

// Valaki embert adott a kérésre → a kérő osztály vezetője kap értesítést
exports.ujFelajanlas = onDocumentCreated("offers/{id}", async e => {
  const o = e.data && e.data.data(); if (!o) return;
  let to = o.toClassId, date = o.date, shift = o.shift;
  if (!to) { const r = (await db.collection("requests").doc(o.requestId).get()).data() || {}; to = r.classId; date = r.date; shift = r.shift; }
  if (!to) return;
  await sendTo([to], {
    title: `${CLASSES[o.classId] || "Egy osztály"} embert adott`,
    body: `${o.person} (${ROLES[o.roleIndex] || ""}) – ${day(date)} ${shift}`,
    url: "index.html", tag: "offer-" + e.params.id
  });
});
