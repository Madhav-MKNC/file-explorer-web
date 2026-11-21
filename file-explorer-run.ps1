#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$appPath = Join-Path $PSScriptRoot 'app.py'
$statePath = Join-Path $PSScriptRoot '.file-explorer-process.json'
$logPath = Join-Path $PSScriptRoot '.file-explorer.log'
$configsPath = Join-Path $PSScriptRoot 'configs'
$python = & python -c 'import sys; print(sys.executable)'
if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12 or newer, then run file-explorer-setup.ps1.' }
$python = $python.Trim()

# Initialize missing config files and prompt for the key before detaching.
& $python $appPath --init-config
if ($LASTEXITCODE -ne 0) { throw 'Configuration setup failed. Fix the error above before starting the server.' }

$serverHost = ([string](Get-Content -LiteralPath (Join-Path $configsPath '.host') -Raw -Encoding UTF8)).Trim().ToLowerInvariant()
$portText = ([string](Get-Content -LiteralPath (Join-Path $configsPath '.port') -Raw -Encoding UTF8)).Trim()

if ($serverHost -ne 'localhost') {
    $address = $null
    if (-not [System.Net.IPAddress]::TryParse($serverHost, [ref]$address) -or
        (-not [System.Net.IPAddress]::IsLoopback($address) -and $serverHost -ne '0.0.0.0')) {
        throw 'configs/.host must contain localhost, 0.0.0.0, or a loopback IP address.'
    }
    $serverHost = $address.ToString()
}
[int]$port = 0
if ($portText -notmatch '\A[0-9]{1,5}\z' -or -not [int]::TryParse($portText, [ref]$port) -or
    $port -lt 1 -or $port -gt 65535) {
    throw 'configs/.port must contain a port number from 1 to 65535.'
}
$urlHost = $serverHost
if ($urlHost -eq '0.0.0.0') { $urlHost = 'localhost' }
if ($urlHost.Contains(':')) { $urlHost = "[$urlHost]" }
$serverUrl = 'http://{0}:{1}' -f $urlHost, $port

if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.Id)"
    if ($process -and $process.CreationDate.ToFileTimeUtc().ToString() -eq $state.Started) {
        if ($state.Url) {
            Write-Output "Already running at $($state.Url) (PID $($state.Id))."
        } else {
            Write-Output "Already running (PID $($state.Id))."
        }
        return
    }
}

if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $port is already in use. Stop the existing server before running this script."
}

# Keep the same Python executable as foreground startup so firewall rules match.
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
@{ Id = $result.ProcessId; Started = $process.CreationDate.ToFileTimeUtc().ToString(); Url = $serverUrl } |
    ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8

for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listener | Where-Object { $_.OwningProcess -eq $result.ProcessId }) {
        Write-Output "Running at $serverUrl (PID $($result.ProcessId))."
        return
    }
    if (-not (Get-Process -Id $result.ProcessId -ErrorAction SilentlyContinue)) {
        throw "Server exited. Read $logPath for the error."
    }
    Start-Sleep -Milliseconds 250
}
throw "Server started but is not listening yet. Read $logPath; use file-explorer-stop to stop it."
