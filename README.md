
# Windows File Explorer Web

A local, offline-capable Flask interface for browsing and managing Windows files. The UI uses a Windows Explorer-style command bar, navigation pane, breadcrumbs, details view, and icon view.

## Run

Requires Windows and Python 3.12 or newer. Run these commands from the repository root in PowerShell:

```powershell
python -m pip install -r requirements.txt
python app.py
```

Open **http://localhost:5000** by default. Stop the server with `Ctrl+C`.

The app creates the `configs` folder and missing configuration files on startup:

- `.host`: the bind address, default `localhost`. Use `localhost` or a loopback IP address such as `127.0.0.1` or `::1`.
- `.port`: the port number, default `5000`. Use an integer from `1` to `65535`. Existing values are preserved.
- `.key`: the single access key. If missing, startup prompts for a key in the terminal before running the server. Input is hidden. The key must be a non-empty single line without `/`; leading and trailing whitespace is ignored when creating the key and signing in. No username or separate password is used.

Each file contains one plain value without quotes. Both `python app.py` and `file-explorer-run` initialize and read these files. Non-interactive startup requires an existing valid `.key`; run `python app.py --init-config` interactively to create it without starting the server. Restart the server after changing any config file. Open `http://<host>:<port>` using the configured values; IPv6 addresses need brackets, for example `http://[::1]:5000`.

The Windows-style sign-in page accepts only the access key. All explorer pages, app assets, APIs, previews, and downloads require an authenticated browser session. Only the login page and its stylesheet are public. Five failed sign-in attempts within one minute temporarily block further attempts. Use **Sign out** to clear the session. Restarting the app also invalidates all sessions.

Configuration files are ignored by Git. The key is stored as plaintext in `.key`; keep that file private and use a strong, unique key.

The server rejects non-loopback bind addresses and must not be exposed to a network or placed behind a public proxy. Authentication, request tokens, same-origin checks, and trusted-host checks protect file operations from other websites. The Flask debugger is disabled.

## Background start and stop

After cloning on the target Windows machine, run setup once in PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\file-explorer-setup.ps1
```

Setup installs the Python dependencies and adds this repository to the current user's PATH. It does not start the app. It does not modify the PowerShell execution policy. Reconnect SSH or open a new PowerShell session after setup.

```powershell
file-explorer-run
file-explorer-stop
```

Start uses Windows WMI to create a hidden process outside the terminal's process tree. It stays running after closing the terminal or disconnecting SSH. Stop targets only the recorded process and checks its creation time to avoid stopping a reused PID. Logs are in `.file-explorer.log`. There is no automatic start after a reboot. Keep the clone in its setup location and use the same Windows account for both commands.

The app remains localhost-only. From another device, use an SSH tunnel rather than exposing the server:

```sh
ssh -L 5000:localhost:5000 user@windows-host
```

Use the configured host and port for the tunnel destination if they differ from the defaults. Open `http://localhost:5000` on that device while the tunnel is connected, then sign in with the access key. Disconnecting the tunnel does not stop the server.

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
