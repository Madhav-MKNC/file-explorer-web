
#requires -Version 5.1
$ErrorActionPreference = 'Stop'

# Run once on the target machine. This does not start the application.
& py -3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)'
if ($LASTEXITCODE -ne 0) {
    throw 'Install Python 3.12 or newer before setup.'
}

& py -3 -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) {
    throw 'Dependency installation failed.'
}

# Add this repository to the current user's PATH.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @($userPath -split ';' | Where-Object { $_ })

if (-not ($entries | Where-Object {
    $_.TrimEnd('\') -ieq $PSScriptRoot.TrimEnd('\')
})) {
    $newPath = (@($entries) + $PSScriptRoot) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
}

Write-Host ''
Write-Host 'Setup completed successfully.' -ForegroundColor Green
Write-Host 'Reconnect SSH or open a new PowerShell session.'
Write-Host 'Use file-explorer-run to start the application.'
Write-Host 'Use file-explorer-stop to stop the application.'
