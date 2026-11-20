#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$appPath = Join-Path $PSScriptRoot 'app.py'
$statePath = Join-Path $PSScriptRoot '.file-explorer-process.json'
$logPath = Join-Path $PSScriptRoot '.file-explorer.log'

if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.Id)"
    if ($process -and $process.CreationDate.ToFileTimeUtc().ToString() -eq $state.Started) {
        Write-Output "Already running at http://127.0.0.1:50006 (PID $($state.Id))."
        return
    }
}

if (Get-NetTCPConnection -LocalPort 50006 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 50006 is already in use. Stop the existing server before running this script.'
}

$python = & py -3 -c 'import sys; print(sys.executable)'
if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12 or newer, then run file-explorer-setup.ps1.' }
$python = $python.Trim()
$pythonw = Join-Path (Split-Path -Parent $python) 'pythonw.exe'
if (Test-Path -LiteralPath $pythonw) { $python = $pythonw }

# WMI creates the process outside the terminal/SSH process tree.
$code = "import runpy,sys; sys.stdout=sys.stderr=open(sys.argv[2],'a',encoding='utf-8',buffering=1); runpy.run_path(sys.argv[1],run_name='__main__')"
$command = '"{0}" -u -c "{1}" "{2}" "{3}"' -f $python, $code, $appPath, $logPath
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $command
    CurrentDirectory = $PSScriptRoot
    ProcessStartupInformation = $startup
}
if ($result.ReturnValue -ne 0) { throw "Could not start the server. Windows error: $($result.ReturnValue)." }

$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($result.ProcessId)"
if (-not $process) { throw "Server exited. Read $logPath for the error." }
@{ Id = $result.ProcessId; Started = $process.CreationDate.ToFileTimeUtc().ToString() } |
    ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8

for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $listener = Get-NetTCPConnection -LocalPort 50006 -State Listen -ErrorAction SilentlyContinue
    if ($listener | Where-Object { $_.OwningProcess -eq $result.ProcessId }) {
        Write-Output "Running at http://127.0.0.1:50006 (PID $($result.ProcessId))."
        return
    }
    if (-not (Get-Process -Id $result.ProcessId -ErrorAction SilentlyContinue)) {
        throw "Server exited. Read $logPath for the error."
    }
    Start-Sleep -Milliseconds 250
}
throw "Server started but is not listening yet. Read $logPath; use file-explorer-stop to stop it."
