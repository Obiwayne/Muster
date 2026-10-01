# Creates Muster shortcuts (with the app icon) that open the app without a console window:
# one in the project folder, one on the Desktop and one in the Start menu.
#   npm run shortcuts
$root = Split-Path -Parent $PSScriptRoot
$icon = Join-Path $root 'desktop\icon.ico'
$shell = New-Object -ComObject WScript.Shell
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) ''
foreach ($dir in @($root, [Environment]::GetFolderPath('Desktop'), $startMenu)) {
  $lnk = $shell.CreateShortcut((Join-Path $dir 'Muster.lnk'))
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $PSScriptRoot 'launch.vbs') + '"'
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = 'Muster: run a crew of Claude Code agents'
  $lnk.Save()
  Write-Output "Created $(Join-Path $dir 'Muster.lnk')"
}
