# 185 — Marymont-Potok ⇄ Sielce

Jedna strona w Safari na iPhonie: autobusy linii 185 na żywo na dwóch odcinkach,
**Do pracy** (Marymont-Potok → Sielce) i **Do domu** (Sielce → Marymont-Potok).

- Strona: GitHub Pages, czysty HTML/CSS/JS (moduły ES), bez kroku budowania.
- Proxy: Cloudflare Worker (`worker/index.js`), trzyma token miasta i dodaje CORS.
- Pozycje: `dane.um.warszawa.pl` przez Workera, co 15 s.
- Rozkład: GTFS z mkuran.pl, przerabiany codziennie przez GitHub Actions na `data/timetable.json`
  (2 tygodnie naprzód) i publikowany razem ze stroną. Awaryjnie rozkład z API miasta przez Workera.

```
index.html, styles.css, app.js   UI, odpytywanie, stan
lib/board.js                     kursy, stany, opóźnienia, ukryte, przypięte
lib/time.js                      czas warszawski, 24:xx, dzień rozkładowy
lib/geo.js                       rzutowanie pozycji na listę przystanków
lib/timetable.js                 parsowanie API, składanie kursów (używa go Worker)
data/config.json                 przystanki, adres proxy
data/route-185.json              przystanki trasy i typowe czasy (generowany z GTFS)
scripts/build-route.mjs          GTFS -> route-185.json
scripts/build-timetable.mjs      GTFS -> data/timetable.json (codziennie w GitHub Actions)
scripts/check-stops.mjs          sprawdzenie słupków w API (z tokenem, lokalnie)
scripts/dev-server.mjs           podgląd lokalny z symulacją autobusów
worker/index.js, wrangler.toml   proxy
test/                            node --test + odpowiedzi w formacie API
```

## Pierwsze uruchomienie

### 1. Worker (z Maca)

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

```bash
npx wrangler secret put WAW_TOKEN
```

(wklej token z `dane.um.warszawa.pl/pl/key-api`)

```bash
openssl rand -base64 24
```

```bash
npx wrangler secret put APP_KEY
```

(wklej wygenerowany klucz aplikacji; zapisz go, wpiszesz go raz na telefonie)

`wrangler deploy` wypisze adres w rodzaju `https://bus-185-proxy.<konto>.workers.dev`.
Wpisz go jako `proxyUrl` w `data/config.json` i wypchnij na `main`.

### 2. Czy miasto przyjmuje Workera? (najważniejszy test)

```bash
curl -s -H "X-App-Key: $APP_KEY" https://bus-185-proxy.<konto>.workers.dev/positions | head -c 300
```

- `{"fetchedAt":…,"positions":[…]}` — działa.
- `502 {"error":"upstream"}` — miasto odrzuca albo nie odpowiada. W logach Workera
  (`npx wrangler tail`) będzie powód. Plan B ze specyfikacji: proxy na komputerze z polskim IP.

### 3. Strona

Workflow `.github/workflows/pages.yml` przy każdym pushu do `main` uruchamia testy i publikuje
stronę na `https://jach00lczyk.github.io/bus-to-work/`. Na iPhonie: otwórz, wpisz klucz aplikacji,
dodaj do zakładek (albo do ekranu początkowego).

### 4. Sprawdzenie słupków (opcjonalnie, z tokenem)

```bash
WAW_TOKEN='…' node scripts/check-stops.mjs --record
```

Potwierdza, że 185 staje na każdym słupku z `config.json`, i nagrywa prawdziwe odpowiedzi do
`test/fixtures` (zastępują zsyntetyzowane).

## Na co dzień

```bash
npm test
```

```bash
npm run dev
```

(podgląd na `http://localhost:8185` z symulowanymi autobusami; klucz aplikacji: dowolny)

Gdy zmieni się trasa 185:

```bash
node scripts/build-route.mjs
```

## Przystanki

Z GTFS (mkuran.pl, `stop_id` = zespół + słupek); do potwierdzenia skryptem `check-stops.mjs`.

| Kierunek | Pętla | Mój przystanek | Cel |
| --- | --- | --- | --- |
| Do pracy | Gwiaździsta 6082/04 | Marymont-Potok 6077/01 | Sielce 3058/01 |
| Do domu | CH Ursynów 3292/04 | Sielce 3058/02 | Marymont-Potok 6077/06 |

Słupek 06 na Marymont-Potok w kierunku „Do domu” potwierdzony w GTFS (kursy TP-GWI).

## Decyzje poza specyfikacją

- **Rozkład z GTFS zamiast z API miasta** (26.11.2026): miasto odpowiadało Workerowi z Cloudflare
  bardzo zawodnie. Rozkład nie zmienia się w ciągu dnia, więc buduje go codzienna akcja GitHub
  (`cron` w `pages.yml`) z GTFS mkuran.pl – bez tokenu i bez API miasta. Te same godziny i brygady
  co w API; id kursów w tym samym formacie, więc przypięcia działają tak samo. Plik ma kilka dni
  naraz, więc kursy po północy i zmiana dnia rozkładowego nie wymagają zgadywania. GitHub wyłącza
  harmonogram po 60 dniach bez zmian w repo – wtedy włączyć go w zakładce Actions (zapas: 2 tygodnie).

- **Opóźnienie** liczone względem planowego czasu w miejscu, w którym jest autobus (interpolacja
  w odcinku między przystankami), a nie na ostatnim minionym przystanku. Wersja ze specyfikacji
  zawyżała opóźnienie o czas jazdy od ostatniego przystanku (zwykle +1 min przy jeździe o czasie).
  Zmiana to jedna linia w `courseTile` (`lib/board.js`).
- **Ostatni miniony przystanek**: rzut pozycji na łamaną przystanków zamiast „najbliższy w 150 m”,
  żeby działało też między przystankami.
- **Autobus przed czasem** = „o czasie” (opóźnienie obcinane do 0), jak w otwartych kwestiach.
- **Brygada jest 2+ kursy przed tym kursem**: kafel bez etykiety, „wg rozkładu”, linia 3
  „kończy wcześniejszy kurs” (tego stanu nie ma w tabeli).
- **Dzień rozkładowy**: zasada 05:00, ale Worker rozpoznaje go też po danych (czy odjazdy wypadają
  w oknie ±30 min od teraz), bo API przełącza się ok. 04:51.
- **Brak odjazdu z pętli w API**: czas szacowany z typowego przejazdu pętla → mój przystanek.
- Kursy, które nie dojeżdżają do celu (np. skrócone do Pl. Wilsona), są pomijane.
- **Zawodne połączenie miasto ↔ Cloudflare** (26.11.2026: większość zapytań z Workera wisiała, ponowione
  przechodziły): Worker ma limit 2,5 s i 3 próby, pyta słupki po kolei i pamięta udane odjazdy do zmiany
  dnia rozkładowego. Strona trzyma rozkład dnia w `localStorage` (`bus185.tt`), więc po ponownym
  otwarciu od razu pokazuje kursy wg rozkładu, nawet gdy API chwilowo nie odpowiada.
