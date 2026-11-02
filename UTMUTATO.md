# Embercsere – beállítási útmutató

Ingyenes: az oldal a **GitHub Pages**-en fut, az adatok a **Firebase** (Google) adatbázisában vannak.
Kb. 15–20 perc, egyszer kell megcsinálni.

Kell hozzá: egy Google-fiók és egy GitHub-fiók (mindkettő ingyenes).

> A Firebase konzol felülete időnként változik, ezért a gombok neve lehet kicsit más (és lehet angol).
> Zárójelben az angol nevet is írom.

---

## 1. Firebase projekt létrehozása

1. Nyisd meg: <https://console.firebase.google.com> és lépj be a Google-fiókoddal.
2. **Projekt létrehozása** (Create a project / Add project) → adj neki nevet, pl. `embercsere`.
3. A Google Analytics-et **kapcsold ki** (nem kell) → **Projekt létrehozása**.

## 2. Bejelentkezés bekapcsolása és a 4 osztály fiókja

1. Bal oldalt: **Build → Authentication** → **Kezdés** (Get started).
2. **Sign-in method** fül → **Email/Password** → kapcsold be (Enable) → **Mentés**.
   (A „Email link” részt hagyd kikapcsolva.)
3. **Users** fül → **Add user** – ezt **4-szer**:

   | E-mail                 | Jelszó                      |
   |------------------------|-----------------------------|
   | `osztaly1@example.com` | amit kitalálsz az 1. osztálynak |
   | `osztaly2@example.com` | … a 2. osztálynak           |
   | `osztaly3@example.com` | … a 3. osztálynak           |
   | `osztaly4@example.com` | … a 4. osztálynak           |

   Az e-mail címek nem valódiak, nem is kell, hogy azok legyenek – levél sosem megy rájuk.
   A jelszó legalább 6 karakter legyen. **Ezeket a jelszavakat adod oda az osztályoknak.**
4. **Regisztráció tiltása:** **Settings** fül → **User actions** → a **„Enable create (sign-up)”**
   pipát **vedd ki** → Mentés. Így rajtad kívül senki nem tud új fiókot létrehozni.
   (A biztonsági szabályok amúgy is csak ezt a 4 fiókot engedik be, ez plusz védelem.)

## 3. Adatbázis létrehozása

1. Bal oldalt: **Build → Firestore Database** → **Adatbázis létrehozása** (Create database).
2. Helynek válassz európait (pl. `eur3 (europe-west)`).
3. **Éles mód** (Start in production mode) → **Létrehozás**.
4. Fent a **Szabályok** (Rules) fül → töröld ki, ami ott van, és másold be a
   **`firestore.rules`** fájl teljes tartalmát → **Közzététel** (Publish).

## 4. A webes beállítások bemásolása

1. Bal fent a fogaskerék ⚙ → **Projektbeállítások** (Project settings).
2. Lent: **Saját alkalmazások** (Your apps) → a **`</>`** (Web) ikon.
3. Adj nevet (pl. `embercsere`), a „Firebase Hosting” pipát **ne** tedd be → **Register app**.
4. Kapsz egy ilyen részt:

   ```js
   const firebaseConfig = {
     apiKey: "AIza....",
     authDomain: "embercsere-xxxx.firebaseapp.com",
     projectId: "embercsere-xxxx",
     ...
   };
   ```

5. Nyisd meg a **`config.js`** fájlt egy szövegszerkesztővel (Mac: TextEdit, Windows: Jegyzettömb),
   és az `IDE_JON` helyekre másold be ezeket az értékeket. Mentsd el.

> Ezek az értékek nem titkosak, nyugodtan lehetnek nyilvánosak – az adatokat a 3. lépés
> szabályai és a jelszavak védik.

## 5. Feltöltés GitHubra

1. Lépj be: <https://github.com> → jobb fent **+** → **New repository**.
2. Név: pl. `embercsere`. Láthatóság: **Public**
   (az ingyenes GitHub Pages-hez nyilvános tároló kell – csak a program kódja látszik,
   az adatok nem, azok a Firebase-ben vannak jelszóval védve).
3. **Create repository** → a megjelenő oldalon: **uploading an existing file** link.
4. Húzd be az összes fájlt ebből a mappából (`index.html`, `app.js`, `backend.js`, `config.js`,
   `firestore.rules`, `UTMUTATO.md`) → lent **Commit changes**.
5. A tárolóban: **Settings → Pages** → *Source*: **Deploy from a branch** →
   Branch: **main**, mappa: **/ (root)** → **Save**.
6. 1–2 perc múlva ugyanitt megjelenik a cím, pl. `https://felhasznaloneved.github.io/embercsere/`.

## 6. Utolsó lépés a Firebase-ben

**Authentication → Settings → Authorized domains** → **Add domain** → írd be:
`felhasznaloneved.github.io` (a saját GitHub-neveddel).

## 7. Kész

Küldd el a címet és az osztályonkénti jelszót a kollégáknak.
Belépés: kiválasztják az osztályukat, beírják a jelszót. A gép megjegyzi őket, amíg ki nem lépnek.

---

## Jó tudni

- **Próbamód:** amíg a `config.js`-ben `IDE_JON` szerepel, az oldal próbamódban fut
  (sárga sáv fent) – semmit nem ment, jelszó nélkül bármelyik osztályként be lehet lépni.
- **Jelszócsere:** Firebase → Authentication → Users → a fiók sorában ⋮ → *Reset password*
  helyett egyszerűbb: töröld a fiókot és hozd létre újra ugyanazzal az e-mail címmel, új jelszóval.
- **Osztálynevek, beosztások:** a `config.js`-ben átírhatók, utána a fájlt újra fel kell tölteni GitHubra
  (a tárolóban a fájlra kattintva ✎ ceruza → szerkesztés → Commit changes).
  A beosztások listájának **a végére** lehet újat írni, a meglévők sorrendjét ne változtasd.
- **Ha a fiókok e-mail címét átírod** a `config.js`-ben, a `firestore.rules`-ban is írd át, és tedd közzé újra.
- **Ingyenes keret:** a Firebase ingyenes (Spark) csomagja napi több tízezer olvasást enged –
  néhány embernek bőven elég. Bankkártya nem kell hozzá.
- **Mentés:** az *Összes letöltése Excelbe* gombbal bármikor lementheted az összes adatot.
