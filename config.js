// ======================================================================
//  BEÁLLÍTÁSOK – ezt a fájlt kell kitölteni (lásd: UTMUTATO.md)
// ======================================================================

// 1) Ide másold be a Firebase konzolból kapott firebaseConfig értékeit.
//    Amíg itt "IDE_JON" szerepel, az oldal PRÓBAMÓDBAN fut (nem ment semmit).
export const firebaseConfig = {
  apiKey: "IDE_JON",
  authDomain: "IDE_JON",
  projectId: "IDE_JON",
  storageBucket: "IDE_JON",
  messagingSenderId: "IDE_JON",
  appId: "IDE_JON"
};

// 2) A 4 osztály. Az "email" a Firebase-ben létrehozott fiók címe
//    (nem kell valódinak lennie, sosem megy rá levél).
//    Ha itt átírod a neveket, az oldalon is úgy jelenik meg.
export const CLASSES = [
  { id: "o1", name: "1. osztály", email: "osztaly1@example.com" },
  { id: "o2", name: "2. osztály", email: "osztaly2@example.com" },
  { id: "o3", name: "3. osztály", email: "osztaly3@example.com" },
  { id: "o4", name: "4. osztály", email: "osztaly4@example.com" }
];

// 3) Kérhető beosztások. A sorrendet NE változtasd, ha már vannak kérések
//    (a végére hozzáírni lehet, legfeljebb 10 elem).
export const ROLES = ["Irányító", "Régió parancsnok", "020-as", "009-es", "Ügyeletvezető helyettes"];

export const SHIFTS = ["Nappal", "Éjszaka"];
