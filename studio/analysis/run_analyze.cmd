@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [x] .venv not found, run install.cmd first
  pause
  exit /b 1
)
".venv\Scripts\python.exe" analyze.py %*
pause
