@echo off
setlocal EnableDelayedExpansion

REM ===================================================================
REM  build-win-zip.bat — build a Windows distributable as a single zip.
REM
REM  Output: dist\ArcenXmlEd-win.zip
REM    Contains: ArcenXmlEd-win\  (full unpacked Electron app)
REM      ArcenXmlEd.exe           — launcher
REM      *.dll                    — runtime libraries
REM      resources\app.asar       — packaged renderer + main
REM      locales\, *.pak, etc.    — Electron / Chromium support files
REM
REM  Pipeline:
REM    1. Bundle the renderer (esbuild).
REM    2. electron-builder --win dir → dist\win-unpacked\
REM    3. Rename win-unpacked → ArcenXmlEd-win (so the zip's top-level
REM       directory has a sensible name when the user extracts).
REM    4. Zip via System.IO.Compression.ZipFile (PowerShell). Faster
REM       than Compress-Archive on large trees (Compress-Archive's
REM       cmdlet wrapper does per-file PowerShell overhead; the .NET
REM       API streams the whole directory in one call).
REM    5. Rename ArcenXmlEd-win back to win-unpacked, in case another
REM       build script (build-win.bat) expects the original path.
REM
REM  This script does NOT touch ArcenXmlEdContents\ or the
REM  ArcenXmlEd.lnk shortcut — that's build-win.bat's job, for in-place
REM  dev testing. This one is for shipping a release artifact.
REM ===================================================================

echo ============================================================
echo  Building ArcenXmlEd for Windows (distributable zip)
echo ============================================================
echo.

cd /d "%~dp0"

echo [1/4] Bundling renderer...
call node build.js
if errorlevel 1 (
    echo Renderer build FAILED.
    goto :end
)

echo [2/4] Running electron-builder --win dir...
call npx electron-builder --win dir -c.compression=store -c.npmRebuild=false
if errorlevel 1 (
    echo electron-builder FAILED.
    goto :end
)

set "UNPACKED=dist\win-unpacked"
set "STAGED=dist\ArcenXmlEd-win"
set "OUT_ZIP=dist\ArcenXmlEd-win.zip"

if not exist "%UNPACKED%" (
    echo Expected directory not found: %UNPACKED%
    set ERRORLEVEL=1
    goto :end
)

echo [3/4] Renaming %UNPACKED% to %STAGED% for zip top-level...
REM Clean any leftover staged dir from a previous run before renaming —
REM Move-Item refuses to overwrite a dir, and a half-finished previous
REM run could leave one behind.
if exist "%STAGED%" rmdir /S /Q "%STAGED%"
if exist "%OUT_ZIP%" del /F /Q "%OUT_ZIP%"
move "%UNPACKED%" "%STAGED%" >nul
if errorlevel 1 (
    echo Rename FAILED.
    goto :end
)

echo [4/4] Zipping to %OUT_ZIP%...
REM ZipFile.CreateFromDirectory(sourceDir, destZip, compressionLevel, includeBaseDir)
REM includeBaseDir=$true puts the source folder name as the zip's
REM top-level entry — exactly what we want for a clean extraction.
REM Optimal = max compression; the alternative Fastest cuts size by
REM maybe 5%% but takes a quarter of the time. We pay the time once
REM at build, the user pays the size on every download — easy call.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Add-Type -AssemblyName System.IO.Compression.FileSystem;" ^
    "[System.IO.Compression.ZipFile]::CreateFromDirectory(" ^
    "  (Resolve-Path '%STAGED%').Path," ^
    "  (Join-Path (Resolve-Path 'dist').Path 'ArcenXmlEd-win.zip')," ^
    "  [System.IO.Compression.CompressionLevel]::Optimal," ^
    "  $true)"
set ZIP_ERR=%ERRORLEVEL%

REM Always rename back, even if the zip step failed — leaves the dist/
REM tree in the same shape build-win.bat expects (so a subsequent run
REM of build-win.bat doesn't have to figure out the staged name).
move "%STAGED%" "%UNPACKED%" >nul

if not %ZIP_ERR% EQU 0 (
    echo Zip step FAILED with exit code %ZIP_ERR%.
    set ERRORLEVEL=%ZIP_ERR%
    goto :end
)

REM Report size for the operator. PowerShell trick: get-item, then format.
for /f "delims=" %%S in ('powershell -NoProfile -Command "'{0:N1} MB' -f ((Get-Item '%OUT_ZIP%').Length / 1MB)"') do set "ZIP_SIZE=%%S"

echo.
echo ============================================================
echo  Build SUCCEEDED.
echo    Unpacked:      %UNPACKED%
echo    Distributable: %OUT_ZIP%  (!ZIP_SIZE!)
echo.
echo  User instructions:
echo    Extract ArcenXmlEd-win.zip anywhere.
echo    Run ArcenXmlEd-win\ArcenXmlEd.exe.
echo ============================================================

:end
echo.
pause
endlocal
