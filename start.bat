@echo off
rem Local preview: serves this folder at http://localhost:8000 and opens the browser.
rem Close this window to stop the server.
cd /d "%~dp0"
start "" http://localhost:8000/
python -m http.server 8000
