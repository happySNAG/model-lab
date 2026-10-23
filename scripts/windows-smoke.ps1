# Cernum · Windows installer smoke test. Run on a Windows PC (PowerShell) from a folder that
# contains the installer, e.g. the USB drive:
#   powershell -ExecutionPolicy Bypass -File windows-smoke.ps1 -Installer .\Cernum-Setup-1.0.0-x64.exe
#
# The product name below must match `productName` in package.json (electron-builder names the install
# directory, the executable, the shortcuts and the userData directory after it). Until this campaign
# the script still looked for `Model Lab`, so it could not pass against any installer since v0.2.0.
# It performs a silent per-user install, checks the shortcuts and executable, launches the app,
# confirms the window and the evidence store appear, closes it, and (optionally) uninstalls.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$product = 'Cernum'
function Step($m) { Write-Host "== $m" -ForegroundColor Cyan }

Step "Installing silently: $Installer"
$p = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "installer exited with $($p.ExitCode)" }

$exe = Join-Path $env:LOCALAPPDATA "Programs\$product\$product.exe"
Step "Checking executable: $exe"
if (-not (Test-Path $exe)) { throw "$product.exe not found" }
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$product.lnk"
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) "$product.lnk"
Step "Start Menu shortcut: $(Test-Path $startMenu)  Desktop shortcut: $(Test-Path $desktop)"
$uninstallKey = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "$product*" }
Step "Uninstall entry present: $($null -ne $uninstallKey)"

Step "Launching $product"
$app = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 12
$window = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
if (-not $window) { throw "$product exited early" }
Step "Main window title: $($window.MainWindowTitle)"
$evidence = Join-Path $env:APPDATA "$product\evidence\store-manifest.json"
Step "Evidence store initialised: $(Test-Path $evidence)"
$log = Join-Path $env:APPDATA "$product\$($product.ToLower()).log"
if (Test-Path $log) { Get-Content $log -Tail 5 }
Stop-Process -Id $app.Id -Force

if ($Uninstall) {
  Step "Uninstalling silently"
  $uninstaller = Join-Path $env:LOCALAPPDATA "Programs\$product\Uninstall $product.exe"
  Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait
  Step "Executable removed: $(-not (Test-Path $exe))   Evidence kept: $(Test-Path $evidence)"
}
Step "Smoke test finished"
