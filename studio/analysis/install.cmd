@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo ============================================================
echo  video-analysis install
echo ============================================================
where py >nul 2>nul
if errorlevel 1 (
  echo [WARN] "py" not found, use "python"
  set "PYEXE=python"
) else (
  set "PYEXE=py -3"
)
if not exist ".venv\Scripts\python.exe" (
  echo [1/3] creating venv ...
  %PYEXE% -m venv .venv
  if errorlevel 1 (
    echo [FAIL] need Python 3.11+
    pause
    exit /b 1
  )
) else (
  echo [1/3] venv exists, skip
)
echo [2/3] pip install ...
".venv\Scripts\python.exe" -m pip install -U pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo [FAIL] pip install failed
  pause
  exit /b 1
)
echo [3/3] done.
echo.
echo next: setx XIAOMI_API_KEY "sk-..."
echo       then run_analyze.cmd "D:\videos\xxx.mp4"
pause
