@echo off
cd /d "%~dp0"
powershell -WindowStyle Hidden -Command "Start-Process python -ArgumentList 'scripts/server.py' -WindowStyle Hidden"
exit
