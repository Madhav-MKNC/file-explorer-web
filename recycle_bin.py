"""Windows recycling and restore-only access to the current user's Recycle Bin."""

from __future__ import annotations

import ctypes
import os
import struct
from pathlib import Path

import pythoncom
import pywintypes
import win32api
import win32con
import win32security
from win32com.server.exception import COMException
from win32com.server.util import wrap
from win32com.shell import shell, shellcon


class _RecycleOnlySink:
    _com_interfaces_ = [shell.IID_IFileOperationProgressSink]
    _public_methods_ = [
        "StartOperations", "FinishOperations", "PreRenameItem", "PostRenameItem",
        "PreMoveItem", "PostMoveItem", "PreCopyItem", "PostCopyItem", "PreDeleteItem",
        "PostDeleteItem", "PreNewItem", "PostNewItem", "UpdateProgress",
        "ResetTimer", "PauseTimer", "ResumeTimer",
    ]

    def __init__(self):
        self.error = None
        self.recycled = False

    def _ignore(self, *args):
        return None

    StartOperations = FinishOperations = PreRenameItem = PostRenameItem = _ignore
    PreMoveItem = PostMoveItem = PreCopyItem = PostCopyItem = _ignore
    PreNewItem = PostNewItem = UpdateProgress = ResetTimer = PauseTimer = ResumeTimer = _ignore

    def PreDeleteItem(self, flags, item):
        # A Python exception returns a failing COM HRESULT. Returning an integer does not.
        if not flags & shellcon.TSF_DELETE_RECYCLE_IF_POSSIBLE:
            self.error = "Windows cannot recycle this item. Permanent deletion is disabled."
            raise COMException(self.error, hresult=-2147467260)

    def PostDeleteItem(self, flags, item, result, recycled_item):
        if result < 0 or recycled_item is None:
            self.error = "Windows could not move this item to the Recycle Bin."
        else:
            self.recycled = True


def recycle(path: Path) -> None:
    """Recycle or fail. Never retry with a permanent-delete operation."""
    if ctypes.windll.kernel32.GetDriveTypeW(f"{path.drive}\\") != 3:
        raise OSError("This drive does not support safe recycling. Nothing was deleted.")
    pythoncom.CoInitialize()
    operation = sink_object = None
    sink = _RecycleOnlySink()
    try:
        operation = pythoncom.CoCreateInstance(
            shell.CLSID_FileOperation, None, pythoncom.CLSCTX_ALL, shell.IID_IFileOperation,
        )
        operation.SetOperationFlags(
            shellcon.FOF_SILENT | shellcon.FOF_NOCONFIRMATION | shellcon.FOF_NOERRORUI
            | shellcon.FOFX_EARLYFAILURE | 0x00080000 | 0x20000000
        )  # FOFX_RECYCLEONDELETE and FOFX_ADDUNDORECORD (Windows 8+).
        sink_object = wrap(sink, shell.IID_IFileOperationProgressSink)
        item = shell.SHCreateItemFromParsingName(str(path), None, shell.IID_IShellItem)
        operation.DeleteItem(item, sink_object)
        result = operation.PerformOperations()
        if result or operation.GetAnyOperationsAborted() or sink.error or not sink.recycled:
            raise OSError(sink.error or "Recycling was canceled. Permanent deletion is disabled.")
    except pywintypes.com_error as error:
        raise OSError(sink.error or error.strerror or "Windows could not recycle this item.") from error
    finally:
        operation = sink_object = None
        pythoncom.CoUninitialize()


def items(letters: list[str]) -> tuple[list[dict], list[dict]]:
    """Read the current user's native $I records; never enumerate other users' bins."""
    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        sid = win32security.ConvertSidToStringSid(win32security.GetTokenInformation(token, win32security.TokenUser)[0])
    finally:
        token.Close()
    records, errors = [], []
    for letter in letters:
        directory = Path(f"{letter}:/") / "$Recycle.Bin" / sid
        try:
            if not directory.exists():
                continue
            if directory.is_symlink() or directory.is_junction() or directory.parent.is_symlink() or directory.parent.is_junction():
                continue
            for metadata in directory.glob("$I*"):
                try:
                    if metadata.is_symlink() or metadata.is_junction():
                        continue
                    with metadata.open("rb") as stream:
                        raw = stream.read(65_562)
                    if len(raw) < 28:
                        continue
                    version, size, deleted = struct.unpack_from("<QQQ", raw)
                    if version == 1:
                        encoded_path = raw[24:544]
                    elif version == 2:
                        length = struct.unpack_from("<I", raw, 24)[0]
                        if not 1 <= length <= 32_767 or len(raw) < 28 + length * 2:
                            continue
                        encoded_path = raw[28:28 + length * 2]
                    else:
                        continue
                    original = encoded_path.decode("utf-16-le").split("\x00", 1)[0]
                    storage = metadata.with_name("$R" + metadata.name[2:])
                    info = storage.lstat()
                    records.append({
                        "storage": storage, "metadata": metadata, "original_path": original,
                        "name": Path(original).name, "is_dir": bool(info.st_file_attributes & 0x10),
                        "size": size, "deleted": deleted / 10_000_000 - 11_644_473_600,
                    })
                except (OSError, UnicodeError, struct.error) as error:
                    if len(errors) < 100:
                        errors.append({"path": f"{letter}: Recycle Bin", "error": str(error)})
        except OSError as error:
            errors.append({"path": f"{letter}: Recycle Bin", "error": str(error)})
    return records, errors


def restore(record: dict, destination: Path) -> None:
    """Restore without overwriting anything; remove only the now-unused bin metadata."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    # On Windows, rename fails if the destination exists. Never use os.replace here.
    os.rename(record["storage"], destination)
    try:
        record["metadata"].unlink()
    except OSError as error:
        raise OSError(f"Item restored to {destination}, but Recycle Bin metadata cleanup failed: {error}") from error
    ctypes.windll.shell32.SHChangeNotify(shellcon.SHCNE_UPDATEDIR, shellcon.SHCNF_PATHW,
                                        ctypes.c_wchar_p(str(record["storage"].parent)), None)
