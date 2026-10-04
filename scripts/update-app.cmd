@echo off
rem Tells the running Muster app to update: it builds when the code changed, then restarts into the same project
rem (same as the Bulletin board's Update button). Does nothing when Muster already runs the latest build.
rem When Muster isn't running, this simply starts it.
cd /d "%~dp0.."
start "" "%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0.." --update
