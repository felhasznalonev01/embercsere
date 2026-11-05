// ======================================================================
//  BEÁLLÍTÁSOK (lásd: UTMUTATO.md)
// ======================================================================

// 1) Firebase projekt adatai (Firebase konzol → Project settings → Your apps).
export const firebaseConfig = {
  apiKey: "AIzaSyAQ0yIZL-I2TTodu-109wMViieNFnd8a4A",
  authDomain: "emberecsere.firebaseapp.com",
  projectId: "emberecsere",
  storageBucket: "emberecsere.firebasestorage.app",
  messagingSenderId: "569766677652",
  appId: "1:569766677652:web:6b96ed7001925cf005b881"
};

// 2) A 4 osztály és a fiókjaik (a Firebase Authentication → Users listában ugyanezek kellenek).
//    email       = az osztályvezető fiókja (embercsere + szolgálatbeosztás)
//    workerEmail = az osztály közös dolgozói fiókja (csak szabadságkérelem)
//    Ha itt átírod az e-maileket, a firestore.rules fájlban is írd át!
export const CLASSES = [
  { id: "o1", name: "1. osztály", email: "osztaly1@example.com", workerEmail: "dolgozo1@example.com" },
  { id: "o2", name: "2. osztály", email: "osztaly2@example.com", workerEmail: "dolgozo2@example.com" },
  { id: "o3", name: "3. osztály", email: "osztaly3@example.com", workerEmail: "dolgozo3@example.com" },
  { id: "o4", name: "4. osztály", email: "osztaly4@example.com", workerEmail: "dolgozo4@example.com" }
];

// Szolgálatvezetői fiók: minden osztály beosztását látja (csak nézni tudja, szerkeszteni nem).
//    Ha átírod, a firestore.rules fájlban is írd át!
export const ADMIN = { email: "vezeto@example.com", name: "Szolgálatvezetés" };

// 3) Beosztások (embercseréhez és a névsorhoz). A sorrendet NE változtasd,
//    ha már vannak kérések (a végére hozzáírni lehet, legfeljebb 10 elem).
export const ROLES = ["Irányító", "Régió parancsnok", "020-as", "009-es", "Ügyeletvezető helyettes", "Osztályvezető", "Ügyeletvezető"];

// Embercsere napszakai és hogy a beosztásban melyik kódnak felelnek meg
export const SHIFTS = ["Nappal", "Éjszaka"];
export const SHIFT_CODE = { "Nappal": "N", "Éjszaka": "É" };

// Emberenként nyilvántartott érvényességek (vizsgák, alkalmasságok)
export const EXAMS = [
  { id: "pszich", label: "Pszichológiai" },
  { id: "eu",     label: "Egészségügyi" },
  { id: "fiz",    label: "Fizikai" },
  { id: "lo",     label: "Lőkiképzés" }
];
// Ennyi nappal a lejárat előtt figyelmeztet (narancs), lejárt = piros
export const EXAM_WARN_DAYS = 30;
// Alapértelmezett éves szabadság (új embernél)
export const DEFAULT_LEAVE_DAYS = 25;

// 4) Szolgálat-kódok a beosztás-táblázatban
//    start = kezdés, hours = hány óra; work = munkaidőnek számít; absence = távollét
//    duty = beszámít a napi létszámba
//    (a távollét munkanapra eső része 8 órával beszámít a keretbe)
export const CODES = {
  "N":  { duty: true, label: "Nappal",      start: "07:00", hours: 12, work: true,  color: "#fff1c9" },
  "É":  { duty: true, label: "Éjszaka",     start: "19:00", hours: 12, work: true,  color: "#d9defa" },
  "24": { duty: true, label: "24 órás",     start: "07:00", hours: 24, work: true,  color: "#cdeedd" },
  "K":  { label: "Képzés",      start: "08:00", hours: 8,  work: true,  color: "#e6dcf7" },
  "SZ": { label: "Szabadság",   hours: 0, absence: true, color: "#ffd6d6" },
  "B":  { label: "Beteg",       hours: 0, absence: true, color: "#f3d1e6" },
  "P":  { label: "Pihenő",      hours: 0, color: "#eef0f3" }
};

// 5) Kitöltési minták (ciklusok) munkarend szerint
export const PATTERNS = {
  "12": [
    { name: "Nappal – Éjszaka – Pihenő – Pihenő", cycle: ["N", "É", "P", "P"] },
    { name: "Nappal – Nappal – Pihenő – Pihenő",  cycle: ["N", "N", "P", "P"] },
    { name: "Éjszaka – Éjszaka – Pihenő – Pihenő", cycle: ["É", "É", "P", "P"] }
  ],
  "24": [
    { name: "24 – 48 pihenő", cycle: ["24", "P", "P"] },
    { name: "24 – 72 pihenő", cycle: ["24", "P", "P", "P"] }
  ]
};

// 6) Munkaidőkeret: 4 hónapos, ettől a hónaptól számolva (jan–ápr, máj–aug, szept–dec)
export const KERET = { firstMonth: 1, months: 4, hoursPerWorkday: 8 };

// 7) Túlóra: ha a túlóra a saját szolgálat vége után ennyi órán belül kezdődik → 200%, különben 100%
export const OVERTIME_200_WINDOW_HOURS = 24;

// 8) Alapértelmezett napi cél-létszám (osztályonként az oldalon átírható), külön nappal és éjszaka
export const DEFAULT_TARGET = 15;
export const DEFAULT_TARGET_DAY = 15;
export const DEFAULT_TARGET_NIGHT = 15;
// Nappal és éjszaka határa a létszám-számításhoz: nappal 7:00–19:00, éjszaka 19:00–7:00.
// Valaki akkor számít bele, ha legalább ennyi órát dolgozik az adott napszakban.
export const DAY_FROM = "07:00", NIGHT_FROM = "19:00", COUNT_MIN_HOURS = 6;

// Magyar munkaszüneti napok (a húsvéti / pünkösdi napokat magától számolja)
export const FIXED_HOLIDAYS = ["01-01", "03-15", "05-01", "08-20", "10-23", "11-01", "12-25", "12-26"];
