# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Requires Windows and Python 3.12+ (`Path.is_junction()` is used). From the repository root in PowerShell:

```powershell
python -m pip install -r requirements.txt
python app.py
```

For background operation, run `file-explorer-setup.ps1` once on the target machine, then use `file-explorer-run` and `file-explorer-stop` from PowerShell. Setup installs dependencies and adds this clone to user PATH. It does not modify the PowerShell execution policy. The run script calls `python app.py --init-config` interactively before starting a hidden, detached WMI process using the same `python.exe`; the stop script validates its recorded PID and creation time. Startup creates missing `configs/.host` (`0.0.0.0`) and `configs/.port` (`50006`) without replacing existing values. The host must be `localhost`, `0.0.0.0`, or a loopback IP address, and the port must be an integer from 1 to 65535. A missing `configs/.key` prompts for a hidden, non-empty single-line key without `/`; leading and trailing whitespace is ignored. Non-interactive startup fails if the key is missing. Each config file contains one plain value without quotes. Restart the server after changing them. Configs, logs, and process state are ignored by Git.

Use the system Python installation, not a virtual environment. The app defaults to binding `0.0.0.0:50006`, browsable at `http://localhost:50006` or the server's IPv4 address, with the debugger disabled. There is no frontend build step, configured linter, test suite, or single-test command. Do not add or run tests unless requested.

## Architecture

- `app.py` owns the Flask app, Windows drive discovery, access policy, browser session authorization, and filesystem operations. `GET /api/drives` supplies allowed roots and shortcuts; listing/search responses supply entries, parents, and safe breadcrumbs.
- `templates/login.html` and `static/login.css` implement the Windows-style key sign-in page. `templates/index.html`, `static/styles.css`, and `static/app.js` implement the Explorer-style UI without a frontend framework or external services. Browser code owns navigation history, selection, sorting, previews, and the cut/copy clipboard. Only view preferences belong in browser storage; the filesystem remains the source of truth.
- `configs/.trusted-hosts` adds exact public IPv4 addresses or hostnames, one per line without schemes or ports. The file is created empty and ignored by Git. Local addresses and the machine hostname are automatically trusted for `0.0.0.0`. Handle routing `SecurityError` before authorization redirects so rejected hosts return HTTP 400, not an internal error.
- Only `/login` and `static/login.css` are public. All other routes require an authenticated, signed, same-site browser session. Login checks the key from `configs/.key` with a constant-time hash comparison, requires a CSRF token, limits failed attempts, and rotates the session on success. `/logout` requires a CSRF-protected POST. Restarting the app invalidates sessions.
- `/api/*` calls use `X-Explorer-Token` from the rendered page. Media previews (`/file`) and downloads (`/download`) require authentication. Normal form POST downloads also accept `csrf_token` and stream archives without browser blob buffering.
- Mutations serialize through `MUTATION_LOCK`. File writes use temporary sibling files and recycle existing files before committing replacements. Transfer/upload conflicts are checked before work begins; retries choose replacement or unique names. Folder replacement merges contents. Batch results contain both completed items and per-path errors.
- Preview content is sandboxed. Text editing has a 2 MB cap. Folder and selection downloads build ZIPs in temporary disk files and include reports for skipped entries.
- `recycle_bin.py` uses pywin32's native `IFileOperation` with a progress sink that cancels non-recycling deletion. It reads the current Windows account's native Recycle Bin metadata and restores without overwriting. `/api/recycle-bin` lists only originally allowed paths; `/api/recycle-bin/restore` accepts opaque item IDs. The frontend treats the bin as a restore-only virtual location.
- Native launch endpoints and permanent deletion are not supported. Delete, replacement writes, and source cleanup after cross-drive moves use `_recycle()`. Direct access to `$Recycle.Bin` is blocked, including resolved links; there is no empty-bin endpoint.

## Access invariants

Every filesystem endpoint must use `_path()` or `_directory()`. Both lexical and resolved paths must stay inside the allowed roots: all mounted drives, but only `C:\Users` on `C:`. Never add a `C:\` breadcrumb or bypass the policy for search, uploads, ZIP traversal, previews, or Recycle Bin restoration. Raw UNC/device paths and alternate data streams are not accepted. Links cannot grant access to restricted targets.

Drive roots and `C:\Users` are protected from destructive operations. Binding to `0.0.0.0` is supported. Keep trusted-host and same-origin checks, key authentication, session/token authorization, and disabled debug mode. Plain HTTP does not encrypt credentials or sessions; use an SSH tunnel or HTTPS for access over untrusted networks. Never include the access key in logs, unauthenticated responses, or commits.
