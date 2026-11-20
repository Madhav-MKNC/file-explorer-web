#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$statePath = Join-Path $PSScriptRoot '.file-explorer-process.json'

if (-not (Test-Path -LiteralPath $statePath)) {
    Write-Output 'No server started by file-explorer-run is recorded.'
    return
}

$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.Id)"
if ($process -and $process.CreationDate.ToFileTimeUtc().ToString() -eq $state.Started) {
    Stop-Process -Id $state.Id -Force
    Write-Output 'File Explorer stopped.'
} else {
    Write-Output 'File Explorer is not running.'
}
Remove-Item -LiteralPath $statePath -Force
