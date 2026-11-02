# Obrazovka domovské stránky: kde žijí vaše soubory

Domů je startovní stránka GenOffice: plocha s vašimi ikonami a dock na dolním okraji okna, seznamy souborů a karty rychlého vytvoření uprostřed.

![Obrazovka domovské stránky](img/home-screen.png)

## Dock

- **Nedávné**: soubory, které jste nedávno otevřeli. Každý řádek nese svůj čas — dnes, včera nebo datum.
- **Oblíbené**: soubory, které jste si označili hvězdičkou. Přejděte na řádek souboru a klikněte na hvězdičku, abyste jej přidali nebo odebrali. **Přesunout do skupiny** v nabídce ⋯ třídí soubory s hvězdičkou do pojmenovaných skupin; zobrazení S hvězdičkou se podle nich filtruje.
- **Ask AI**: panel znalostní báze — ptejte se a dostávejte odpovědi s citacemi z vašich souborů s hvězdičkou (viz níže).
- **Genspark Projects**: po přihlášení k účtu Genspark zobrazí projekty, které jste vytvořili na webu pomocí Genspark AI; kliknutím na projekt pokračujete v úpravách v prohlížeči. K dispozici je vyhledávání, řazení podle času, obnovení a načtení dalších.
- **Složky**: kořeny žijí na ploše. Klikněte pravým tlačítkem na prázdnou plochu pro **Přidat složku na plochu…**; pravé tlačítko na ikonu kořenu jej z plochy sejme (složka na disku se nikdy nedotkne). Kořen se otevře jako vlastní zobrazení — procházení, vytváření podsložek, přejmenování a přesouvání se děje odtud. Soubory přetažené ze správce souborů se připnou jako aliasy.

Dock na dolním okraji je spouštěč ve stylu macOS: ikony se pod ukazatelem zvětší, tečka označuje aktuální zobrazení, tažením změníte pořadí ve skupině, pravé tlačítko otevře nabídku. Nastavení → Dock vypne zvětšování, změní velikost ikon nebo dock skryje ( přejeďte spodním okrajem pro vyvolání). Na ploše je i karta rychlého psaní úkolů — přesouvejte ji za úchyt; pozice se pamatuje.
Zde není žádná položka Koš. Odstraněné soubory putují do systémového koše a jejich obnova je věcí operačního systému.

## Seznam souborů

Každý řádek zobrazuje ikonu, název souboru, čas změny a další údaje. Nabídka **⋯** na řádku obsahuje:
### Více souborů najednou

Zaškrtněte pole u řádku nebo klepněte s ⌘/ctrl, abyste vytvořili výběr; pole v záhlaví vybere vše, co je právě vypsáno, a lišta nad seznamem hlásí (**Vybráno: {n}**), kolik je vybráno, a nabízí **Přesunout do složky…** a **Odstranit soubory** pro celou sadu. Výběr více souborů můžete také přetáhnout na řádek složky v zobrazení složek.

## Vyhledávání

Vyhledávací pole nahoře filtruje najednou dvě věci:
## Karty rychlého startu

Karty nad seznamy vytvoří nový dokument jediným krokem. Kliknutím na kartu se vytvoří soubor daného typu a otevře jeho editor — můžete rovnou psát, nebo nechat AI připravit první návrh (každý editor má na pásku **tlačítko AI** a v kontextové nabídce výběru **Zeptat se AI**).

Nový soubor se uloží do zobrazení složek, ve kterém se nacházíte; mimo každou složku se dostane do výchozí složky.

Co která karta dělá:
> Tip: Soubor ▸ Nový v pruhu nabídek vytvoří stejné typy dokumentů (⌘N/Ctrl+N ve výchozím stavu vytvoří textový dokument); přetažení souboru do okna ho otevře.

## Zeptejte se své znalostní báze

- Nejdřív dejte souborům hvězdičku (jakýkoli typ, který aplikace čte); hlavička panelu počítá korpus a prázdná báze vás vyzve, něco si označit.
- Odpovědi citují zdrojové soubory; kliknutí na citaci otevře soubor v jeho editoru.
- Vyžaduje přihlášení ke Genspark. Konverzace žije jen v paměti — zavření aplikace ji ukončí.
- Hledání běží na lokálním indexu souborů jako na Domově; zmizelé soubory z korpusu tiše vypadnou.
- Skupiny organizují jen seznam S hvězdičkou — znalostní báze vždy zahrnuje všechny soubory s hvězdičkou.

## Projekty v cloudu (Genspark Projects)

- Při prvním použití je nutné přihlásit se k účtu Genspark (postup s kódem zařízení: GenOffice zobrazí kód a vy dokončíte přihlášení v prohlížeči).
- Seznam projektů se synchronizuje s webem; Otevřít v prohlížeči vás přesune tam, kde lze pokračovat.
- Nepřihlášení nijak neomezuje žádnou místní funkci.
