# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Requires Windows and Python 3.12+ (`Path.is_junction()` is used). From the repository root in PowerShell:

```powershell
python -m pip install -r requirements.txt
python app.py
```

For background operation, run `file-explorer-setup.ps1` once on the target machine, then use `file-explorer-run` and `file-explorer-stop` from PowerShell. Setup installs dependencies and adds this clone to user PATH. It does not modify the PowerShell execution policy. The run script starts a detached WMI process using `configs/.host` and `configs/.port`; the stop script validates its recorded PID and creation time. The host must be `localhost` or a loopback IP address, and the port must be an integer from 1 to 65535. Each config file contains one plain value without quotes. Restart the server after changing them. Logs and process state are ignored by Git.

Use the system Python installation, not a virtual environment. The app defaults to `http://localhost:50006` using the two files in `configs`, with the debugger disabled. There is no frontend build step, configured linter, test suite, or single-test command. Do not add or run tests unless requested.

## Architecture

- `app.py` owns the Flask app, Windows drive discovery, access policy, browser session authorization, and filesystem operations. `GET /api/drives` supplies allowed roots and shortcuts; listing/search responses supply entries, parents, and safe breadcrumbs.
- `templates/index.html`, `static/styles.css`, and `static/app.js` implement the Explorer-style UI without a frontend framework or external services. Browser code owns navigation history, selection, sorting, previews, and the cut/copy clipboard. Only view preferences belong in browser storage; the filesystem remains the source of truth.
- `/api/*` calls use `X-Explorer-Token` from the rendered page. Media previews (`/file`) and downloads (`/download`) use the signed, same-site browser session. Normal form POST downloads also accept `csrf_token` and stream archives without browser blob buffering.
- Mutations serialize through `MUTATION_LOCK`. File writes use temporary sibling files and recycle existing files before committing replacements. Transfer/upload conflicts are checked before work begins; retries choose replacement or unique names. Folder replacement merges contents. Batch results contain both completed items and per-path errors.
- Preview content is sandboxed. Text editing has a 2 MB cap. Folder and selection downloads build ZIPs in temporary disk files and include reports for skipped entries.
- `recycle_bin.py` uses pywin32's native `IFileOperation` with a progress sink that cancels non-recycling deletion. It reads the current Windows account's native Recycle Bin metadata and restores without overwriting. `/api/recycle-bin` lists only originally allowed paths; `/api/recycle-bin/restore` accepts opaque item IDs. The frontend treats the bin as a restore-only virtual location.
- Native launch endpoints and permanent deletion are not supported. Delete, replacement writes, and source cleanup after cross-drive moves use `_recycle()`. Direct access to `$Recycle.Bin` is blocked, including resolved links; there is no empty-bin endpoint.

## Access invariants

Every filesystem endpoint must use `_path()` or `_directory()`. Both lexical and resolved paths must stay inside the allowed roots: all mounted drives, but only `C:\Users` on `C:`. Never add a `C:\` breadcrumb or bypass the policy for search, uploads, ZIP traversal, previews, or Recycle Bin restoration. Raw UNC/device paths and alternate data streams are not accepted. Links cannot grant access to restricted targets.

Drive roots and `C:\Users` are protected from destructive operations. Keep loopback-only binding, trusted-host and same-origin checks, session/token authorization, and disabled debug mode. The service has no network login and is intended only for the local Windows user.
