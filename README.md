# Windows File Explorer Web

A local, offline-capable Flask interface for browsing and managing Windows files. The UI uses a Windows Explorer-style command bar, navigation pane, breadcrumbs, details view, and icon view.

## Run

Requires Windows and Python 3.12 or newer. Run these commands from the repository root in PowerShell:

```powershell
py -m pip install -r requirements.txt
py app.py
```

Open **http://127.0.0.1:50006**. Stop the server with `Ctrl+C`.

The server binds only to the local machine. It does not require a login and must not be exposed to a network or placed behind a public proxy. The browser session, request token, same-origin checks, and trusted-host checks protect local file operations from other websites. The Flask debugger is disabled.

## Access rules

- Every mounted drive is browsable, subject to the current Windows account's permissions.
- On `C:`, only `C:\Users` and its descendants are accessible. The UI starts that drive at `C:\Users`, never at `C:\`.
- Paths that resolve through symlinks or junctions into restricted locations are blocked. Raw UNC paths, device paths, alternate data streams, and Windows reserved names are rejected.
- Drive roots and `C:\Users` cannot be renamed, moved, or deleted.
- The app does not elevate permissions or unlock files held by other programs.

## Features

- Back, forward, up, refresh, editable address bar, breadcrumbs, and user-folder shortcuts.
- Details and large-icon views, sorting, multiselect, context menus, and hidden-file visibility.
- Recursive name search, including wildcard patterns. Searches stop after 10 seconds, 100,000 scanned entries, or 2,000 results and flag incomplete results.
- Create folders and empty files, rename, cut/copy/paste, upload files or folders, and drag-and-drop upload.
- Replace or keep both when names conflict. Folder replacement merges contents rather than deleting unrelated destination files.
- Download files directly; download folders or selections as ZIP archives. ZIP generation uses temporary disk space, not an in-memory archive. Unreadable or restricted entries are skipped with an error report inside the ZIP.
- Image, PDF, audio, video, and text previews. Text previews and editing are limited to 2 MB. Unsupported files can be downloaded.
- File properties.
- Delete only to the Windows Recycle Bin. If Windows cannot recycle an item, the operation fails instead of permanently deleting it.
- Restore-only Recycle Bin for the server's Windows account. Restore selected items to their original locations without overwriting existing files. Emptying or deleting from the bin is not supported.
- Replaced files and old text versions are recycled before saving their replacements. Cross-drive moves recycle their source after a successful copy.

File operations change real files. They are not a simulation. Permanent deletion and native program launches are not exposed. Recycle Bin access is limited to items whose original locations pass the drive access rules. Windows may still refuse locked or protected files. Batch operations report individual failures; a merge into an existing folder can be partial if a later file fails.

## Development

There is no JavaScript build step, external CDN, lint configuration, or automated test suite. The frontend uses plain HTML, CSS, and JavaScript. No test or single-test command is configured.

Use the system Python installation; no virtual environment is needed.
