# The Home screen: where your files live

Home is GenOffice's start page: the desktop with your icons and the dock at the bottom edge, file lists and quick-create cards in the middle.

![The Home screen](img/home-screen.png)

## The dock

The dock along the window's bottom edge is the launcher, macOS-style: icons magnify as the pointer passes over them, a dot marks the view you are in, and you can drag the icons to reorder them (within their group) or right-click one for its menu. Settings → Dock turns the magnification off, changes the icon size and strength, or slides the dock away until you hover the bottom edge.

- **Desktop, Recent, Starred**: switch between the surfaces. Double-click a file anywhere to open it.
- **Genspark Projects** (after signing in to your Genspark account): shows the projects you created with Genspark AI on the web; click one to continue editing in the browser. Search, sort by time, refresh and load-more are supported.
- **Settings, Templates, Plugins**: the launchers — the settings window, the template gallery, the plugins pane.
- **Ask AI**: opens the knowledge-base panel — ask questions and get answers cited from your starred files (see below).

The desktop itself carries your icons: app tiles, the files you opened recently, folder roots, and the todo quick-capture card (drag the card by its handle; the placement persists). Right-click the empty desktop for **New**, sort and view options, refresh, **Add folder to desktop…**, wallpaper and properties; right-click a folder root to take it off the desktop (the folder itself is never touched). Folders open as their own view — browse, create subfolders, rename and move from there. Dragging files in from the file manager pins them as aliases.

There is no Trash entry here. Deleted files go to the system trash, and restoring one is the OS's business.

## The file list

Each row shows an icon, the file name, modification time and more. The row's **⋯ menu** offers:

- **Open**, and **Reveal in folder** to locate the file in your file manager.
- **Copy path**.
- **Move to folder…**: opens a folder picker and actually moves the file, offering skip / overwrite / rename when the destination already has a file of that name.
- **Rename**: inline, extension preserved automatically.
- **Star / Unstar** — stars persist across restarts, and follow a file when you rename it.
- **Duplicate**: creates a copy in the same folder.
- **Delete**: moves the file to the system trash — not a permanent delete.
- **Remove from list**, in the top-level Recent view, to drop an entry without touching the file.

### Several files at once

Tick the checkbox on a row, or ⌘/ctrl-click, to build a selection; the header checkbox selects everything currently listed, and a bar above the list reports how many are selected with **Move to folder…** and **Delete files** for the whole set. You can also drag a multi-selection onto a folder row in the folder view.

## Search

The search box at the top matches two things at once:

- **File names**: quick filtering by name.
- **File contents**: GenOffice indexes your files in the background (text inside docx/xlsx/pptx/pdf/md/html), so searching body text finds files too. Scope and toggles live in the search settings.

## Quick start cards

The cards above the lists create a new document in one step. Clicking a card creates a file of that type and opens its editor — start writing right away, or let the AI draft for you (every editor has an **AI button** in its ribbon, and **Ask AI** in the selection context menu).

The new file lands in the folder view you are in; outside any folder it goes to the default folder.

What each card does:

- **AI Docs** (.docx): a blank text document in the Docs editor. The file is only written to disk on **first save**; new documents open with the AI panel expanded (turn that off under Settings → "Open the AI panel in new documents").
- **AI Sheets** (.xlsx): a blank spreadsheet in the Sheets editor. Until you save, no file exists on disk — the name is reserved for the first save; after the first AI generation the file can also be renamed automatically from its content.
- **AI Slides** (.pptx): a blank presentation in the Slides editor.
- **AI Markdown** (.md): a blank Markdown document in the Markdown editor.
- **AI HTML** (.html): a blank web page in the HTML editor.
- **AI PDF** (.pdf): different from the rest — it **immediately** creates a real blank single-page PDF in the target folder and opens it as a regular file (the PDF editor works on real files). Good for annotating, redacting or adding text; the file can be renamed automatically from its content on first save.
- **Open local files**: a system file picker for Word (.docx/.doc), Excel (.xlsx/.xlsm/.xls/.csv/.tsv), PowerPoint (.pptx/.ppt), PDF, Markdown (.md/.markdown) and web pages (.html/.htm). Multi-select works; each file gets its own tab. Plain-text files (.txt, .json) open here too — they land in the Markdown editor's source view.

> Tip: File ▸ New in the menu bar creates the same document types (⌘N/Ctrl+N defaults to a text document); dragging a file into the window opens it.

## Ask your knowledge base

- Star files first (any type the app reads); the panel header counts the corpus, and an empty knowledge base tells you to go star something.
- Answers cite the files they came from; click a citation to open the file in its editor.
- Requires signing in to Genspark. The conversation lives in memory only — closing the app ends it.
- Search runs on the local file index, like Home search; files that have disappeared quietly drop out of the corpus.
- Groups organise the Starred list only — the knowledge base always spans every starred file.

## Cloud projects (Genspark Projects)

- First use requires signing in to your Genspark account (device-code flow: GenOffice shows a code, you finish logging in in the browser).
- The project list syncs with the web; Open in browser jumps there to continue.
- Not signing in affects none of the local features.
