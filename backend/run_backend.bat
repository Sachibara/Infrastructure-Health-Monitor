@echo off
setlocal
cd /d "%~dp0\.."

where python >nul 2>&1
if errorlevel 1 (
  echo Python was not found in PATH.
  pause
  exit /b 1
)

python -m pip install -r backend\requirements.txt
if errorlevel 1 (
  echo Failed to install Infrastructure Health Monitor dependencies.
  pause
  exit /b 1
)

echo.
echo Starting Infrastructure Health Monitor...
echo Open http://127.0.0.1:8820
echo.
python backend\health_api.py
pause
