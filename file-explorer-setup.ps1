#requires -Version 5.1
$ErrorActionPreference = 'Stop'

# Run once on the target machine. This does not start the application.
& py -3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else "Python 3.12 or newer is required.")'
if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12 or newer before setup.' }
& py -3 -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }

# Allow locally cloned PowerShell scripts for this user, not the whole machine.
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @($userPath -split ';' | Where-Object { $_ })
if (-not ($entries | Where-Object { $_.TrimEnd('\') -ieq $PSScriptRoot.TrimEnd('\') })) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $PSScriptRoot) -join ';'), 'User')
}
if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $PSScriptRoot.TrimEnd('\') })) {
    $env:Path += ';' + $PSScriptRoot
}
Write-Output 'Setup complete. In PowerShell, use file-explorer-run and file-explorer-stop.'
Write-Output 'Reconnect existing SSH sessions to pick up the PATH change.'
