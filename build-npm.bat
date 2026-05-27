@echo off
setlocal

echo ============================================================
echo  Building renderer bundle and launching via Electron
echo ============================================================
echo.

cd /d "%~dp0"

call npm start

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
