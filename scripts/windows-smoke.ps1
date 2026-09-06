# Model Lab · Windows installer smoke test. Run on a Windows PC (PowerShell) from a folder that
# contains the installer, e.g. the USB drive:
#   powershell -ExecutionPolicy Bypass -File windows-smoke.ps1 -Installer .\Model-Lab-Setup-1.0.0-x64.exe
# It performs a silent per-user install, checks the shortcuts and executable, launches the app,
# confirms the window and the evidence store appear, closes it, and (optionally) uninstalls.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "== $m" -ForegroundColor Cyan }

Step "Installing silently: $Installer"
$p = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "installer exited with $($p.ExitCode)" }

$exe = Join-Path $env:LOCALAPPDATA 'Programs\Model Lab\Model Lab.exe'
Step "Checking executable: $exe"
if (-not (Test-Path $exe)) { throw "Model Lab.exe not found" }
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Model Lab.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Model Lab.lnk'
Step "Start Menu shortcut: $(Test-Path $startMenu)  Desktop shortcut: $(Test-Path $desktop)"
$uninstallKey = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like 'Model Lab*' }
Step "Uninstall entry present: $($null -ne $uninstallKey)"

Step "Launching Model Lab"
$app = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 12
$window = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
if (-not $window) { throw "Model Lab exited early" }
Step "Main window title: $($window.MainWindowTitle)"
$evidence = Join-Path $env:APPDATA 'Model Lab\evidence\store-manifest.json'
Step "Evidence store initialised: $(Test-Path $evidence)"
$log = Join-Path $env:APPDATA 'Model Lab\model-lab.log'
if (Test-Path $log) { Get-Content $log -Tail 5 }
Stop-Process -Id $app.Id -Force

if ($Uninstall) {
  Step "Uninstalling silently"
  $uninstaller = Join-Path $env:LOCALAPPDATA 'Programs\Model Lab\Uninstall Model Lab.exe'
  Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait
  Step "Executable removed: $(-not (Test-Path $exe))   Evidence kept: $(Test-Path $evidence)"
}
Step "Smoke test finished"
