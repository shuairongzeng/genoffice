# Ekran strony głównej: gdzie mieszkają Twoje pliki

Strona główna to punkt wyjścia GenOffice: pulpit z ikonami i dock przy dolnej krawędzi okna, listy plików i karty szybkiego tworzenia pośrodku.

![Ekran strony głównej](img/home-screen.png)

## Dock

- **Ostatnie**: pliki, które ostatnio otwierałeś. Każdy wiersz ma na sobie czas — dzisiaj, wczoraj albo datę.
- **Ulubione**: pliki oznaczone gwiazdką. Najedź na wiersz pliku i kliknij gwiazdkę, aby dodać lub usunąć plik. **Przenieś do grupy** w menu ⋯ porządkuje pliki z gwiazdką w nazwane grupy; widok Oznaczone filtruje po nich.
- **Ask AI**: panel bazy wiedzy — zadawaj pytania i otrzymuj odpowiedzi z cytatami z plików oznaczonych gwiazdką (patrz niżej).
- **Genspark Projects**: po zalogowaniu na konto Genspark pokazuje projekty utworzone w sieci za pomocą Genspark AI; kliknięcie projektu otwiera go w przeglądarce do dalszej edycji. Dostępne są wyszukiwanie, sortowanie według czasu, odświeżanie i wczytanie kolejnych.
- **Foldery**: katalogi dodane do paska bocznego przyciskiem **Dodaj folder…** albo przeciągnięte tam z menedżera plików. Każdy staje się katalogiem głównym, który można otworzyć, utworzyć w nim podfoldery, zmienić jego nazwę i usunąć; ten, który przestanie być dostępny, jest oznaczany jako niedostępny i można go zdjąć z listy. **Nowy folder** tworzy kolejny.
- **Foldery**: korzenie żyją na pulpicie. Kliknij prawym przyciskiem puste miejsce, by **Dodać folder do pulpitu…**; kliknięcie prawym na ikonę korzenia zdejmuje go z pulpitu (folder na dysku nigdy nie jest dotykany). Korzeń otwiera się jako własny widok — przeglądanie, tworzenie podfolderów, zmiana nazwy i przenoszenie dzieje się stamtąd. Pliki przeciągnięte z menedżera plików przypinają się jako aliasy.

Dock przy dolnej krawędzi to launcher w stylu macOS: ikony powiększają się pod wskaźnikiem, kropka oznacza bieżący widok, przeciągnij by przestawić w obrębie grupy, prawy przycisk otwiera menu. Ustawienia → Dock wyłącza powiększanie, zmienia rozmiar ikon lub ukrywa dock (najedź na dolną krawędź, by przywołać). Na pulpicie jest też karteczka szybkich zadań — przesuwaj ją za uchwyt; pozycja zostaje zapamiętana.
Nie ma tu pozycji Kosz. Usunięte pliki trafiają do kosza systemowego, a ich przywrócenie to zadanie systemu operacyjnego.

## Lista plików

Każdy wiersz pokazuje ikonę, nazwę pliku, czas modyfikacji i inne dane. **⋯ menu** w wierszu oferuje:
### Wiele plików naraz

Zaznacz pole wyboru w wierszu lub kliknij ⌘/ctrl, aby zbudować zaznaczenie; pole w nagłówku zaznacza wszystko, co jest teraz na liście, a pasek nad listą podaje (**Wybrano: {n}**), ile plików jest zaznaczonych, i oferuje **Przenieś do folderu…** oraz **Usuń pliki** dla całego zestawu. Zaznaczenie wielokrotne możesz też przeciągnąć na wiersz folderu w widoku folderów.

## Wyszukiwanie

Pole wyszukiwania u góry filtruje naraz dwie rzeczy:
## Karty szybkiego startu

Karty nad listami tworzą nowy dokument jednym krokiem. Kliknięcie karty tworzy plik danego typu i otwiera jego edytor — możesz od razu pisać albo pozwolić, aby AI przygotował wstęp (każdy edytor ma **przycisk AI** na wstążce oraz **Zapytaj AI** w menu kontekstowym zaznaczenia).

Nowy plik trafia do widoku folderów, w którym się znajdujesz; poza każdym folderem trafia do folderu domyślnego.

Co robi każda karta:
> Wskazówka: Plik ▸ Nowy na pasku menu tworzy te same typy dokumentów (⌘N/Ctrl+N domyślnie tworzy dokument tekstowy); przeciągnięcie pliku do okna otwiera go.

## Zapytaj swoją bazę wiedzy

- Najpierw oznacz pliki gwiazdką (każdy typ, który aplikacja czyta); nagłówek panelu liczy korpus, a pusta baza podpowiada, by coś oznaczyć.
- Odpowiedzi cytują pliki źródłowe; kliknięcie cytatu otwiera plik w jego edytorze.
- Wymaga zalogowania w Genspark. Rozmowa żyje tylko w pamięci — zamknięcie aplikacji ją kończy.
- Wyszukiwanie działa na lokalnym indeksie plików, jak na stronie głównej; zniknięte pliki po cichu wypadają z korpusu.
- Grupy porządkują tylko listę Oznaczone — baza wiedzy zawsze obejmuje wszystkie pliki z gwiazdką.

## Projekty w chmurze (Genspark Projects)

- Przy pierwszym użyciu trzeba zalogować się na konto Genspark (przepływ z kodem urządzenia: GenOffice pokazuje kod, a Ty kończysz logowanie w przeglądarce).
- Lista projektów synchronizuje się z siecią; Otwórz w przeglądarce przenosi tam, gdzie można kontynuować.
- Brak logowania nie wpływa na żadną funkcję lokalną.
