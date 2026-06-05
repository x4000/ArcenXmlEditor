@echo off
setlocal

echo ============================================================
echo  Building ArcenXmlEd for Windows (dir target, fast settings)
echo ============================================================
echo.

cd /d "%~dp0"

call node build.js
call npx electron-builder --win dir -c.compression=store -c.npmRebuild=false

set EXITCODE=%ERRORLEVEL%

if %EXITCODE% EQU 0 (
    echo.
    echo Preserving user config before wipe ...
    if exist "%~dp0ArcenXmlEdContents\_editor_config.json" (
        copy /Y "%~dp0ArcenXmlEdContents\_editor_config.json" "%~dp0_editor_config.json.bak" >nul
    )

    echo Clearing old ArcenXmlEdContents ...
    if exist "%~dp0ArcenXmlEdContents" rmdir /S /Q "%~dp0ArcenXmlEdContents"
    mkdir "%~dp0ArcenXmlEdContents"

    echo Copying built files to ArcenXmlEdContents ...
    xcopy /E /Y /I /Q "%~dp0dist\win-unpacked\*" "%~dp0ArcenXmlEdContents\" >nul
    set EXITCODE=%ERRORLEVEL%

    if exist "%~dp0_editor_config.json.bak" (
        echo Restoring user config ...
        move /Y "%~dp0_editor_config.json.bak" "%~dp0ArcenXmlEdContents\_editor_config.json" >nul
    )
)

if %EXITCODE% EQU 0 (
    echo Creating ArcenXmlEd.lnk shortcut at repo root ...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$w = New-Object -ComObject WScript.Shell;" ^
        "$s = $w.CreateShortcut('%~dp0ArcenXmlEd.lnk');" ^
        "$s.TargetPath = '%~dp0ArcenXmlEdContents\ArcenXmlEd.exe';" ^
        "$s.WorkingDirectory = '%~dp0ArcenXmlEdContents';" ^
        "$s.IconLocation = '%~dp0ArcenXmlEdContents\ArcenXmlEd.exe,0';" ^
        "$s.Save()"
    set EXITCODE=%ERRORLEVEL%
)

echo.
echo ============================================================
if %EXITCODE% EQU 0 (
    echo  Build SUCCEEDED.
    echo  Shortcut: %~dp0ArcenXmlEd.lnk
    echo  Exe:      %~dp0ArcenXmlEdContents\ArcenXmlEd.exe
) else (
    echo  Build FAILED with exit code %EXITCODE%.
)
echo ============================================================
echo.

pause
endlocal
