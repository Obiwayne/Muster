@echo off
rem Starts the Muster desktop app. Rebuilds first when the sources are newer than the build.
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe call npm install
node scripts\needs-build.mjs && call npm run build
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
