"""Local Windows file explorer. Run with: python app.py"""

from __future__ import annotations

import codecs
import ctypes
import fnmatch
import hmac
import locale
import mimetypes
import ntpath
import os
import re
import secrets
import shutil
import stat
import tempfile
import threading
import time
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, jsonify, render_template, request, send_file, session
from werkzeug.exceptions import HTTPException

import recycle_bin


PORT = 50006
USERS_ROOT = Path("C:/Users")
TEXT_LIMIT = 2 * 1024 * 1024
SEARCH_LIMIT = 2000
SEARCH_SCAN_LIMIT = 100_000
SEARCH_SECONDS = 10
MUTATION_LOCK = threading.RLock()
INVALID_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
DEVICE_NAME = re.compile(r"^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)", re.I)
TEXT_ENCODINGS = {"utf-8", "utf-8-sig", "utf-16", "utf-32", "cp1252", "latin-1"}
TEXT_ENCODINGS.add(locale.getpreferredencoding(False))

app = Flask(__name__)
app.config.update(
    SECRET_KEY=secrets.token_bytes(32),
    TRUSTED_HOSTS=["localhost", "127.0.0.1", "[::1]"],
    SESSION_COOKIE_NAME="file_explorer_50006",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Strict",
    MAX_FORM_PARTS=20_000,
    MAX_FORM_MEMORY_SIZE=16 * 1024 * 1024,
)


class ExplorerError(Exception):
    def __init__(self, message: str, status: int = 400, **details):
        super().__init__(message)
        self.status = status
        self.details = details


def _drive_letters() -> list[str]:
    if os.name != "nt":
        raise ExplorerError("This application requires Windows.", 503)
    mask = ctypes.windll.kernel32.GetLogicalDrives()
    return [chr(65 + index) for index in range(26) if mask & (1 << index)]


def _roots() -> dict[str, Path]:
    return {letter: USERS_ROOT if letter == "C" else Path(f"{letter}:/")
            for letter in _drive_letters()}


def _inside(path: Path | str, root: Path | str) -> bool:
    try:
        return ntpath.commonpath([ntpath.normcase(str(path)), ntpath.normcase(str(root))]) == ntpath.normcase(str(root))
    except ValueError:
        return False


def _check_scope(path: Path, *, resolved: bool = False) -> None:
    if any(part.casefold() == "$recycle.bin" for part in path.parts):
        raise ExplorerError("Use the restore-only Recycle Bin view. Direct access to its files is disabled.", 403)
    drive = path.drive.upper()
    roots = _roots()
    if drive == "C:":
        if not _inside(path, USERS_ROOT):
            raise ExplorerError("Only C:\\Users is accessible on the C: drive.", 403, code="restricted_path")
        return
    if re.fullmatch(r"[A-Z]:", drive) and drive[0] in roots:
        return
    # A mapped drive can resolve to a UNC path. Raw UNC/device paths are never accepted.
    if resolved and drive.startswith("\\\\"):
        for letter, root in roots.items():
            if letter == "C":
                continue
            try:
                real_root = root.resolve()
                if real_root.drive.startswith("\\\\") and _inside(path, real_root):
                    return
            except OSError:
                pass
    raise ExplorerError("Use an accessible local drive path, not a UNC or device path.", 403, code="restricted_path")


def _valid_name(value) -> str:
    if not isinstance(value, str) or not value or len(value) > 255:
        raise ExplorerError("Enter a name between 1 and 255 characters.")
    if value in {".", ".."} or value.endswith((".", " ")) or INVALID_NAME.search(value) or DEVICE_NAME.match(value):
        raise ExplorerError('Names cannot use Windows reserved names, trailing dots/spaces, or < > : " / \\ | ? * characters.')
    return value


def _path(value, *, exists: bool = True) -> Path:
    if not isinstance(value, str) or not re.match(r"^[A-Za-z]:[\\/]", value):
        raise ExplorerError("An absolute drive path is required.")
    if "\x00" in value:
        raise ExplorerError("Invalid path.")
    # Reject alternate data streams and Windows device aliases before normalization.
    for part in re.split(r"[\\/]", value[3:]):
        if part and part not in {".", ".."}:
            _valid_name(part)
    path = Path(ntpath.normpath(value))
    _check_scope(path)
    try:
        real = path.resolve(strict=False)
        _check_scope(real, resolved=True)
        if exists:
            path.stat()
    except RuntimeError:
        raise ExplorerError("This link contains a filesystem loop.", 403) from None
    return path


def _directory(value) -> Path:
    path = _path(value)
    if not path.is_dir():
        raise ExplorerError("The selected path is not a folder.")
    return path


def _exists(path: Path) -> bool:
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


def _is_link(path: Path) -> bool:
    return path.is_symlink() or path.is_junction()


def _protected(path: Path) -> bool:
    real = path.resolve(strict=False)
    for root in _roots().values():
        if ntpath.normcase(str(path)) == ntpath.normcase(str(root)):
            return True
        try:
            if ntpath.normcase(str(real)) == ntpath.normcase(str(root.resolve(strict=False))):
                return True
        except OSError:
            pass
    return False


def _mutable(path: Path) -> None:
    if _protected(path):
        raise ExplorerError("Drive roots and C:\\Users cannot be renamed, moved, or deleted.", 403)


def _readonly(info) -> bool:
    return bool(getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_READONLY)


def _entry(path: Path) -> dict:
    info = path.lstat()
    attrs = getattr(info, "st_file_attributes", 0)
    is_link = _is_link(path)
    is_dir = stat.S_ISDIR(info.st_mode) or bool(attrs & stat.FILE_ATTRIBUTE_DIRECTORY)
    accessible, error = True, None
    try:
        _path(str(path))
        info = path.stat()
        is_dir = stat.S_ISDIR(info.st_mode)
    except (ExplorerError, OSError, RuntimeError) as exc:
        accessible, error = False, str(exc)
    extension = "" if is_dir else path.suffix.lower()
    file_types = {".exe": "Application", ".lnk": "Shortcut", ".pdf": "PDF document",
                  ".txt": "Text document", ".zip": "ZIP archive", ".html": "HTML document"}
    result = {
        "name": path.name or f"{path.drive} drive",
        "path": str(path),
        "parent": str(path.parent),
        "is_dir": is_dir,
        "is_link": is_link,
        "accessible": accessible,
        "hidden": bool(attrs & (stat.FILE_ATTRIBUTE_HIDDEN | stat.FILE_ATTRIBUTE_SYSTEM)),
        "size": None if is_dir else info.st_size,
        "modified": info.st_mtime,
        "created": getattr(info, "st_birthtime", info.st_ctime),
        "type": "File folder" if is_dir else file_types.get(extension, f"{extension[1:].upper()} file" if extension else "File"),
        "extension": extension,
    }
    if error:
        result["error"] = error
    return result


def _location(path: Path) -> dict:
    root = _roots()[path.drive[0].upper()]
    name = "Users (C:)" if path.drive.upper() == "C:" else path.drive
    breadcrumbs = [{"name": name, "path": str(root)}]
    current = root
    for part in path.relative_to(root).parts:
        current /= part
        breadcrumbs.append({"name": part, "path": str(current)})
    return {"path": str(path), "parent": None if path == root else str(path.parent), "breadcrumbs": breadcrumbs}


def _json_body() -> dict:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ExplorerError("A JSON object is required.")
    return data


def _path_list(values) -> list[str]:
    if not isinstance(values, list) or not 1 <= len(values) <= 10_000 or not all(isinstance(value, str) for value in values):
        raise ExplorerError("Select between 1 and 10,000 paths.")
    return list(dict.fromkeys(values))


def _reduce_selection(paths: list[Path]) -> list[Path]:
    paths = sorted(paths, key=lambda path: len(path.parts))
    kept = []
    for path in paths:
        if not any(parent.is_dir() and _inside(path, parent) for parent in kept):
            kept.append(path)
    return kept


def _conflict_mode(value) -> str:
    if value not in {"error", "replace", "keep_both"}:
        raise ExplorerError("Invalid conflict option.")
    return value


def _unique_path(path: Path, reserved: set[str] | None = None, *, is_dir: bool = False) -> Path:
    reserved = reserved or set()
    stem, suffix = (path.name, "") if is_dir else (path.stem, path.suffix)
    candidate = path
    number = 2
    while _exists(candidate) or ntpath.normcase(str(candidate)) in reserved:
        candidate = path.with_name(f"{stem} ({number}){suffix}")
        number += 1
        if number > 10_000:
            raise ExplorerError("Too many files have this name.")
    _valid_name(candidate.name)
    return _path(str(candidate), exists=False)


def _conflicts(paths: list[Path]) -> None:
    if paths:
        raise ExplorerError("These names already exist. Replace them, keep both, or cancel.", 409,
                            code="conflict", conflicts=[{"name": path.name, "path": str(path)} for path in paths])


def _recycle(path: Path) -> None:
    path = _path(str(path))
    _mutable(path)
    recycle_bin.recycle(path)


def _write_atomic(destination: Path, writer, *, source: Path | None = None) -> None:
    _path(str(destination), exists=False)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".explorer-", dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            writer(stream)
        if source:
            shutil.copystat(source, temporary)
        _path(str(destination), exists=False)
        if _exists(destination):
            _recycle(destination)
        os.rename(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()


def _copy(source: Path, destination: Path, ancestors: set[str] | None = None) -> None:
    source = _path(str(source))
    destination = _path(str(destination), exists=False)
    if not source.is_dir():
        if _exists(destination) and destination.is_dir():
            raise ExplorerError("A folder occupies the destination file name.")
        def write(stream):
            with _path(str(source)).open("rb") as incoming:
                shutil.copyfileobj(incoming, stream, 1024 * 1024)
        _write_atomic(destination, write, source=source)
        return
    if _exists(destination) and not destination.is_dir():
        raise ExplorerError("A file occupies the destination folder name.")
    ancestors = set(ancestors or ())
    real = ntpath.normcase(str(source.resolve()))
    if real in ancestors:
        raise ExplorerError(f"A filesystem link loop was found at {source}.")
    ancestors.add(real)
    destination.mkdir(exist_ok=True)
    for child in source.iterdir():
        _copy(child, destination / child.name, ancestors)
    shutil.copystat(source, destination)


@app.before_request
def authorize():
    if request.endpoint in {"index", "static"}:
        return None
    if not session.get("csrf_token"):
        raise ExplorerError("Open the explorer page first, then retry.", 401)
    origin = request.headers.get("Origin")
    if origin:
        parsed = urlsplit(origin)
        if parsed.scheme != request.scheme or parsed.netloc != request.host:
            raise ExplorerError("Cross-origin requests are not allowed.", 403)
    if request.headers.get("Sec-Fetch-Site") == "cross-site":
        raise ExplorerError("Cross-site requests are not allowed.", 403)
    if request.path.startswith("/api/") or request.method != "GET":
        token = request.headers.get("X-Explorer-Token")
        if not token and request.endpoint == "download":
            token = request.form.get("csrf_token")
        if not isinstance(token, str) or not hmac.compare_digest(token, session["csrf_token"]):
            raise ExplorerError("The session expired. Refresh the page and retry.", 403)
    return None


@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    if request.endpoint == "preview_file":
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'"
    else:
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' blob:; "
            "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        )
    return response


@app.errorhandler(ExplorerError)
def explorer_error(error):
    return jsonify(error=str(error), **error.details), error.status


@app.errorhandler(OSError)
def filesystem_error(error):
    status = 403 if isinstance(error, PermissionError) else 404 if isinstance(error, FileNotFoundError) else 400
    return jsonify(error=str(error)), status


@app.errorhandler(HTTPException)
def http_error(error):
    return jsonify(error=error.description), error.code


@app.get("/")
def index():
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(32)
    return render_template("index.html", csrf_token=session["csrf_token"])


@app.get("/api/drives")
def drives():
    results = []
    kinds = {2: "Removable drive", 3: "Local disk", 4: "Network drive", 5: "Optical drive", 6: "RAM disk"}
    for letter, root in _roots().items():
        drive_root = f"{letter}:\\"
        label_buffer = ctypes.create_unicode_buffer(261)
        ctypes.windll.kernel32.GetVolumeInformationW(drive_root, label_buffer, len(label_buffer), None, None, None, None, 0)
        kind = kinds.get(ctypes.windll.kernel32.GetDriveTypeW(drive_root), "Drive")
        total, free, accessible = None, None, False
        try:
            _directory(str(root))
            with os.scandir(root):
                pass
            usage = shutil.disk_usage(drive_root)
            total, free, accessible = usage.total, usage.free, True
        except (ExplorerError, OSError):
            pass
        name = "Users (C:)" if letter == "C" else f"{label_buffer.value or kind} ({letter}:)"
        results.append({"name": name, "letter": letter, "path": str(root), "kind": kind,
                        "total": total, "free": free, "accessible": accessible})
    home = Path.home()
    shortcuts = []
    for name, path in [("Home", home), ("Desktop", home / "Desktop"), ("Downloads", home / "Downloads"),
                       ("Documents", home / "Documents"), ("Pictures", home / "Pictures"),
                       ("Music", home / "Music"), ("Videos", home / "Videos")]:
        try:
            _directory(str(path))
            shortcuts.append({"name": name, "path": str(path)})
        except (ExplorerError, OSError):
            pass
    return jsonify(drives=results, shortcuts=shortcuts, home=str(home))


@app.get("/api/list")
def list_directory():
    directory = _directory(request.args.get("path"))
    show_hidden = request.args.get("hidden") == "1"
    items = []
    with os.scandir(directory) as children:
        for child in children:
            try:
                item = _entry(Path(child.path))
                if show_hidden or not item["hidden"]:
                    items.append(item)
            except OSError:
                continue  # A file can disappear while its folder is being listed.
    items.sort(key=lambda item: (not item["is_dir"], item["name"].casefold()))
    return jsonify(**_location(directory), items=items)


@app.get("/api/search")
def search():
    query = request.args.get("q", "").strip()
    if not query or len(query) > 255:
        raise ExplorerError("Enter a search term between 1 and 255 characters.")
    path_value = request.args.get("path")
    if path_value:
        root = _directory(path_value)
        location = _location(root)
        pending = [root]
    else:
        location = {"path": None, "parent": None, "breadcrumbs": []}
        pending = []
        for root in _roots().values():
            try:
                pending.append(_directory(str(root)))
            except (ExplorerError, OSError):
                pass
    show_hidden = request.args.get("hidden") == "1"
    items, errors, visited = [], [], set()
    scanned, skipped = 0, 0
    deadline = time.monotonic() + SEARCH_SECONDS
    truncated = False
    folded_query = query.casefold()
    wildcard = "*" in query or "?" in query
    while pending:
        if time.monotonic() >= deadline or scanned >= SEARCH_SCAN_LIMIT or len(items) >= SEARCH_LIMIT:
            truncated = True
            break
        directory = pending.pop()
        try:
            directory = _directory(str(directory))
            real = ntpath.normcase(str(directory.resolve()))
            if real in visited:
                continue
            visited.add(real)
            with os.scandir(directory) as children:
                for child in children:
                    if time.monotonic() >= deadline or scanned >= SEARCH_SCAN_LIMIT or len(items) >= SEARCH_LIMIT:
                        truncated = True
                        break
                    scanned += 1
                    try:
                        item = _entry(Path(child.path))
                    except OSError as exc:
                        skipped += 1
                        if len(errors) < 100:
                            errors.append({"path": child.path, "error": str(exc)})
                        continue
                    if item["hidden"] and not show_hidden:
                        continue
                    name = item["name"].casefold()
                    if (fnmatch.fnmatchcase(name, folded_query) if wildcard else folded_query in name):
                        items.append(item)
                    if item["is_dir"] and item["accessible"]:
                        pending.append(Path(item["path"]))
                    elif not item["accessible"]:
                        skipped += 1
                        if len(errors) < 100:
                            errors.append({"path": item["path"], "error": item.get("error", "Inaccessible path")})
        except (ExplorerError, OSError) as exc:
            skipped += 1
            if len(errors) < 100:
                errors.append({"path": str(directory), "error": str(exc)})
        if truncated:
            break
    return jsonify(**location, items=items, truncated=truncated, scanned=scanned, skipped=skipped, errors=errors)


@app.get("/api/properties")
def properties():
    path = _path(request.args.get("path"))
    return jsonify(**_entry(path), readonly=_readonly(path.stat()), protected=_protected(path))


@app.post("/api/create")
def create():
    data = _json_body()
    name = _valid_name(data.get("name"))
    if data.get("kind") not in {"file", "folder"}:
        raise ExplorerError("Choose file or folder.")
    with MUTATION_LOCK:
        directory = _directory(data.get("path"))
        target = _path(str(directory / name), exists=False)
        _conflicts([target] if _exists(target) else [])
        if data["kind"] == "folder":
            target.mkdir()
        else:
            with target.open("xb"):
                pass
    return jsonify(item=_entry(target)), 201


@app.post("/api/rename")
def rename():
    data = _json_body()
    name = _valid_name(data.get("name"))
    with MUTATION_LOCK:
        source = _path(data.get("path"))
        _mutable(source)
        target = _path(str(source.with_name(name)), exists=False)
        same_name = ntpath.normcase(str(source)) == ntpath.normcase(str(target))
        _conflicts([target] if _exists(target) and not same_name else [])
        source.rename(target)
    return jsonify(item=_entry(target))


@app.post("/api/delete")
def delete():
    data = _json_body()
    values = _path_list(data.get("paths"))
    if data.get("permanent", False) is not False:
        raise ExplorerError("Permanent deletion is disabled.", 403)
    completed, errors = [], []
    with MUTATION_LOCK:
        valid = []
        for value in values:
            try:
                path = _path(value)
                _mutable(path)
                valid.append(path)
            except (ExplorerError, OSError) as exc:
                errors.append({"path": value, "error": str(exc)})
        for path in _reduce_selection(valid):
            try:
                _recycle(path)
                completed.append(str(path))
            except (ExplorerError, OSError) as exc:
                errors.append({"path": str(path), "error": str(exc)})
    return jsonify(completed=completed, errors=errors, recycled=True)


def _recycled_items() -> tuple[list[dict], list[dict]]:
    records, errors = recycle_bin.items(_drive_letters())
    allowed = []
    for record in records:
        try:
            _path(record["original_path"], exists=False)
            allowed.append(record)
        except (ExplorerError, OSError):
            continue
    return allowed, errors


def _recycle_id(record: dict) -> str:
    return hmac.new(app.config["SECRET_KEY"], str(record["metadata"]).casefold().encode(), "sha256").hexdigest()


@app.get("/api/recycle-bin")
def list_recycle_bin():
    with MUTATION_LOCK:
        records, errors = _recycled_items()
        items = []
        for record in records:
            original = Path(record["original_path"])
            items.append({
                "name": record["name"], "path": _recycle_id(record), "parent": str(original.parent),
                "original_path": str(original), "is_dir": record["is_dir"], "is_link": False,
                "accessible": True, "hidden": False, "size": record["size"],
                "modified": record["deleted"], "created": None, "deleted": record["deleted"],
                "type": "File folder" if record["is_dir"] else "Recycled file",
                "extension": original.suffix.lower(),
            })
    return jsonify(path="recycle-bin", parent=None, breadcrumbs=[{"name": "Recycle Bin", "path": "recycle-bin"}],
                   items=items, errors=errors)


@app.post("/api/recycle-bin/restore")
def restore_recycled_items():
    ids = _path_list(_json_body().get("ids"))
    completed, errors = [], []
    with MUTATION_LOCK:
        records, _ = _recycled_items()
        by_id = {_recycle_id(record): record for record in records}
        for item_id in ids:
            record = by_id.get(item_id)
            try:
                if not record:
                    raise ExplorerError("This item is no longer in the Recycle Bin. Refresh and retry.", 404)
                destination = _path(record["original_path"], exists=False)
                if _exists(destination):
                    raise ExplorerError("The original path already exists. Nothing was replaced; the item remains in the Recycle Bin.", 409)
                recycle_bin.restore(record, destination)
                completed.append(item_id)
            except (ExplorerError, OSError) as error:
                errors.append({"path": record["original_path"] if record else item_id, "error": str(error)})
    return jsonify(completed=completed, errors=errors)


@app.post("/api/transfer")
def transfer():
    data = _json_body()
    mode = data.get("mode")
    if mode not in {"copy", "move"}:
        raise ExplorerError("Choose copy or move.")
    conflict = _conflict_mode(data.get("conflict", "error"))
    completed, errors = [], []
    with MUTATION_LOCK:
        destination = _directory(data.get("destination"))
        sources = _reduce_selection([_path(value) for value in _path_list(data.get("paths"))])
        jobs, collisions, reserved = [], [], set()
        for source in sources:
            _mutable(source)
            target = _path(str(destination / source.name), exists=False)
            same = ntpath.normcase(str(source)) == ntpath.normcase(str(target))
            if same and mode == "move":
                completed.append({"source": str(source), "path": str(source)})
                continue
            if source.is_dir() and _inside(destination.resolve(), source.resolve()):
                raise ExplorerError("A folder cannot be copied or moved inside itself.")
            if conflict == "keep_both":
                target = _unique_path(target, reserved, is_dir=source.is_dir())
            elif _exists(target) or ntpath.normcase(str(target)) in reserved:
                collisions.append(target)
            if source.is_dir() and _inside(target.resolve(strict=False), source.resolve()):
                raise ExplorerError("The destination resolves to the source folder or a folder inside it.")
            if same and conflict == "replace":
                raise ExplorerError("A file cannot replace itself. Choose keep both to duplicate it.")
            if conflict == "replace" and ntpath.normcase(str(target)) in reserved:
                raise ExplorerError("Two selected items have the same destination name. Choose keep both.")
            reserved.add(ntpath.normcase(str(target)))
            jobs.append((source, target))
        if conflict == "error":
            _conflicts(collisions)
        for source, target in jobs:
            fresh = not _exists(target)
            copy_completed = False
            try:
                _path(str(source))
                _path(str(target), exists=False)
                if not fresh and source.is_dir() != target.is_dir():
                    raise ExplorerError("A file and a folder cannot replace each other.")
                if mode == "move" and (fresh or not source.is_dir()):
                    try:
                        if not fresh:
                            _recycle(target)
                        os.rename(source, target)
                    except OSError as exc:
                        if exc.errno != 18 and getattr(exc, "winerror", None) != 17:
                            raise
                        _copy(source, target)
                        copy_completed = True
                        _recycle(source)
                else:
                    _copy(source, target)
                    copy_completed = True
                    if mode == "move":
                        _recycle(source)
                completed.append({"source": str(source), "path": str(target)})
            except (ExplorerError, OSError) as exc:
                # Never remove the source after a failed copy. Existing-folder merges may be partial.
                if fresh and not copy_completed and _exists(target) and _exists(source):
                    try:
                        _recycle(target)
                    except (ExplorerError, OSError):
                        pass
                errors.append({"path": str(source), "error": str(exc)})
    return jsonify(completed=completed, errors=errors)


def _upload_name(filename: str) -> list[str]:
    if not filename or filename.startswith(("/", "\\")):
        raise ExplorerError("Invalid upload path.")
    parts = filename.replace("\\", "/").split("/")
    return [_valid_name(part) for part in parts]


@app.post("/api/upload")
def upload():
    conflict = _conflict_mode(request.form.get("conflict", "error"))
    files = request.files.getlist("files")
    if not files:
        raise ExplorerError("Choose files to upload.")
    completed, errors = [], []
    with MUTATION_LOCK:
        directory = _directory(request.form.get("path"))
        jobs, collisions, reserved = [], [], set()
        for incoming in files:
            target = _path(str(directory.joinpath(*_upload_name(incoming.filename))), exists=False)
            if conflict == "keep_both":
                target = _unique_path(target, reserved)
            elif _exists(target) or ntpath.normcase(str(target)) in reserved:
                collisions.append(target)
            if conflict == "replace" and ntpath.normcase(str(target)) in reserved:
                raise ExplorerError("Two uploaded files have the same destination name. Choose keep both.")
            reserved.add(ntpath.normcase(str(target)))
            jobs.append((incoming, target))
        if conflict == "error":
            _conflicts(collisions)
        for incoming, target in jobs:
            try:
                _path(str(target), exists=False)
                target.parent.mkdir(parents=True, exist_ok=True)
                _directory(str(target.parent))
                if _exists(target) and target.is_dir():
                    raise ExplorerError("A folder occupies this file name.")
                _write_atomic(target, lambda stream, incoming=incoming: shutil.copyfileobj(incoming.stream, stream, 1024 * 1024))
                completed.append(str(target))
            except (ExplorerError, OSError) as exc:
                errors.append({"path": str(target), "error": str(exc)})
    return jsonify(completed=completed, errors=errors)


@app.get("/api/text")
def read_text():
    path = _path(request.args.get("path"))
    if path.is_dir():
        raise ExplorerError("Choose a text file, not a folder.")
    with path.open("rb") as stream:
        raw = stream.read(TEXT_LIMIT + 1)
    if len(raw) > TEXT_LIMIT:
        raise ExplorerError("Text previews and editing are limited to 2 MB.", 413)
    if raw.startswith((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
        encoding = "utf-32"
    elif raw.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        encoding = "utf-16"
    elif raw.startswith(codecs.BOM_UTF8):
        encoding = "utf-8-sig"
    else:
        if b"\x00" in raw:
            raise ExplorerError("This is a binary file. Download it to view it.", 415)
        encoding = "utf-8"
    try:
        text = raw.decode(encoding)
    except UnicodeDecodeError:
        encoding = locale.getpreferredencoding(False)
        try:
            text = raw.decode(encoding)
        except UnicodeDecodeError:
            raise ExplorerError("This file's text encoding is not supported.", 415) from None
    if text and sum(ord(char) < 32 and char not in "\n\r\t\f" for char in text) / len(text) > 0.02:
        raise ExplorerError("This is a binary file. Download it to view it.", 415)
    return jsonify(path=str(path), text=text, encoding=encoding,
                   editable=not _readonly(path.stat()) and os.access(path, os.W_OK))


@app.post("/api/text")
def save_text():
    data = _json_body()
    text, encoding = data.get("text"), data.get("encoding", "utf-8")
    if not isinstance(text, str) or encoding not in TEXT_ENCODINGS:
        raise ExplorerError("Valid text and a supported encoding are required.")
    try:
        raw = text.encode(encoding)
    except UnicodeEncodeError:
        raise ExplorerError("This encoding cannot save these characters. Save as UTF-8 instead.") from None
    if len(raw) > TEXT_LIMIT:
        raise ExplorerError("Text editing is limited to 2 MB.", 413)
    with MUTATION_LOCK:
        path = _path(data.get("path"))
        if path.is_dir() or _readonly(path.stat()):
            raise ExplorerError("This file cannot be edited.", 403)
        _write_atomic(path, lambda stream: stream.write(raw))
    return jsonify(item=_entry(path))


@app.get("/file")
def preview_file():
    path = _path(request.args.get("path"))
    if path.is_dir():
        raise ExplorerError("Choose a file, not a folder.")
    guessed = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    safe = guessed.startswith(("image/", "audio/", "video/")) or guessed == "application/pdf"
    return send_file(path, mimetype=guessed if safe else "application/octet-stream",
                     as_attachment=not safe, download_name=path.name, conditional=True)


def _archive(paths: list[Path]):
    archive = tempfile.TemporaryFile(mode="w+b")
    errors = []
    error_count = 0
    def note(path, error):
        nonlocal error_count
        error_count += 1
        if len(errors) < 1000:
            errors.append(f"{path}: {error}")
    try:
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as zipped:
            def add(path: Path, name: str, ancestors: set[str]):
                try:
                    path = _path(str(path))
                    if path.is_dir():
                        real = ntpath.normcase(str(path.resolve()))
                        if real in ancestors:
                            raise ExplorerError("Filesystem link loop; skipped.")
                        zipped.writestr(name.rstrip("/") + "/", b"")
                        for child in path.iterdir():
                            add(child, f"{name}/{child.name}", ancestors | {real})
                    else:
                        zipped.write(path, name)
                except (ExplorerError, OSError) as exc:
                    note(path, str(exc))
            used = set()
            for path in paths:
                name = path.name or f"Drive {path.drive[0]}"
                original, number = name, 2
                while name.casefold() in used:
                    name = f"{original} ({number})"
                    number += 1
                used.add(name.casefold())
                add(path, name, set())
            if errors:
                report = "__download_errors__.txt"
                while report in zipped.namelist():
                    report = "_" + report
                message = "Some entries could not be included. Restricted paths are never followed.\n\n" + "\n".join(errors)
                if error_count > len(errors):
                    message += f"\n\n{error_count - len(errors)} additional entries were skipped."
                zipped.writestr(report, message)
        size = archive.tell()
        archive.seek(0)
        name = f"{paths[0].name or 'Drive ' + paths[0].drive[0]}.zip" if len(paths) == 1 else "Selected files.zip"
        response = send_file(archive, mimetype="application/zip", as_attachment=True, download_name=name, conditional=False)
        response.content_length = size
        response.call_on_close(archive.close)
        return response
    except BaseException:
        archive.close()
        raise


@app.route("/download", methods=["GET", "POST"])
def download():
    values = request.form if request.method == "POST" else request.args
    if values.get("paths"):
        import json
        try:
            selected = json.loads(values["paths"])
        except (ValueError, TypeError):
            raise ExplorerError("Invalid download selection.") from None
        paths = [_path(value) for value in _path_list(selected)]
    else:
        paths = [_path(values.get("path"))]
    paths = _reduce_selection(paths)
    if len(paths) == 1 and not paths[0].is_dir():
        return send_file(paths[0], as_attachment=True, download_name=paths[0].name, conditional=True)
    return _archive(paths)


if __name__ == "__main__":
    if os.name != "nt":
        raise SystemExit("This application requires Windows.")
    app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True)
