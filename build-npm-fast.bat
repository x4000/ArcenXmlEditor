@echo off
setlocal

echo ============================================================
echo  Launching via Electron (no rebuild)
echo ============================================================
echo.

cd /d "%~dp0"

call npx electron .

set EXITCODE=%ERRORLEVEL%

echo.
echo ============================================================
if %EXITCODE% EQU 0 (
    echo  Session ended cleanly.
) else (
    echo  Exited with code %EXITCODE%.
)
echo ============================================================
echo.

if %EXITCODE% NEQ 0 pause
endlocal
