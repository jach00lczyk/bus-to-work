# Nagrane odpowiedzi

Kształt odpowiedzi jest taki, jak zmierzył autor integracji
[`ztm_warsaw`](https://github.com/solarssk/ztm_warsaw/tree/main/tests/e2e/fake_city/data)
na nowym hoście `dane.um.warszawa.pl`: goła lista wierszy, każdy wiersz to lista par `{value, key}`
(`symbol_2, symbol_1, brygada, kierunek, trasa, czas`).

- `odjazdy_<zespół>_<słupek>_185.json` – odjazdy linii 185 z sześciu słupków aplikacji w czwartek
  26.11.2026. **Zsyntetyzowane z rozkładu GTFS** (mkuran.pl, dzień `2026-11-26:PcS`), bo przy pisaniu
  testów nie było tokenu do API miasta. Brygady zostawione z zerami wiodącymi (`013`), żeby testy
  sprawdzały porównywanie bez zer.
- `positions.json` – kilka wierszy `get_ztm_lokalizacja_pojazdow` (zsyntetyzowane): dwie bieżące
  pozycje 185, jedna stara z poprzedniego dnia, inne linie.

Po wdrożeniu Workera warto podmienić je na prawdziwe odpowiedzi (`curl` do Workera), zostawiając te
same nazwy plików.
