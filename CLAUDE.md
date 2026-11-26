# CLAUDE.md

Strona z autobusami 185 (Marymont-Potok ⇄ Sielce) dla jednego użytkownika na iPhonie. Opis
całości i decyzje: `README.md`. Projekt interfejsu (wiążący): kanwa
https://claude.ai/artifact/BagC8rKj55qx5zD3oFkGvH.

## Zasady

- Bez frameworka i bez kroku budowania. Moduły ES ładowane wprost przez przeglądarkę.
- Logika w `lib/` bez DOM, testowana w Node (`npm test`). Nowy stan albo reguła = nowy test.
- Token miasta (`WAW_TOKEN`) tylko w sekretach Workera. Nigdy w repo, w kodzie strony ani w testach.
- API miasta: `POST`, nagłówek `Authorization: <JWT>` bez `Bearer`, wartości w ciele jako stringi,
  odpowiedzi to gołe listy, każdy błąd = `500 {"message":"Service unavailable"}`.
  Stare `api.um.warszawa.pl` nie działa – nie używać.
- Wymiary, kolory i animacje 1:1 z kanwy; jedna krzywa `cubic-bezier(0.32, 0.72, 0, 1)`.
- Teksty interfejsu po polsku.

## Komendy

- `npm test` – testy jednostkowe (lib + Worker z podstawionym `fetch`).
- `npm run dev` – podgląd na `localhost:8185`, proxy udawane pod `/mock` (symulacja jazdy).
- `node scripts/build-route.mjs [katalog-gtfs]` – odświeżenie `data/route-185.json`.
- `npx wrangler deploy` – wdrożenie Workera.
