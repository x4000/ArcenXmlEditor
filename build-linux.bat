@echo off
setlocal EnableDelayedExpansion

REM ===================================================================
REM  build-linux.bat — cross-build a Linux distributable from Windows.
REM
REM  Output: dist\ArcenXmlEd-linux.tar.gz
REM    Contains: ArcenXmlEd-linux/  (full unpacked Electron app)
REM      ArcenXmlEd                 — launcher (ELF, marked 0755)
REM      chrome-sandbox             — sandbox helper (marked 0755)
REM      *.so                       — shared libraries (marked 0755)
REM      resources/, locales/, etc. — app data (0644)
REM
REM  Why NOT AppImage? On a Windows host, electron-builder downloads a
REM  cache of Linux ELF helper binaries (mksquashfs, opj_decompress)
REM  for AppImage assembly, then tries to EXECUTE them — which fails
REM  because Windows can't run Linux ELF binaries natively. Requires
REM  WSL or Docker. The unpacked-directory approach skips that whole
REM  toolchain. End-user experience is the same: extract the tar.gz,
REM  run the launcher, no install step.
REM
REM  Why the explicit tar.gz repack instead of `electron-builder --linux tar.gz`?
REM  Same exec-bit problem as macOS: NTFS doesn't carry the Unix +x bit,
REM  so any Windows-side tarball lands with 0644 on the launcher and
REM  refuses to run on Linux. pack-app-bundle.js sniffs ELF magic bytes
REM  and forces 0755 on every entry that needs it.
REM ===================================================================

echo ============================================================
echo  Building ArcenXmlEd for Linux (cross-build from Windows)
echo ============================================================
echo.

cd /d "%~dp0"

echo [1/3] Bundling renderer...
call node build.js
if errorlevel 1 (
    echo Renderer build FAILED.
    goto :end
)

REM `--linux dir` skips the AppImage assembly step (and its Linux-only
REM toolchain). -c.npmRebuild=false skips the native-rebuild step (no
REM native deps in this project, and the rebuild can be slow / flaky on
REM corporate networks).
echo [2/3] Running electron-builder --linux dir...
call npx electron-builder --linux dir -c.npmRebuild=false
if errorlevel 1 (
    echo electron-builder FAILED.
    goto :end
)

echo [3/3] Packing dist\linux-unpacked\ into tar.gz with exec bits...
set "UNPACKED=dist\linux-unpacked"
if not exist "%UNPACKED%" (
    echo Expected directory not found: %UNPACKED%
    set ERRORLEVEL=1
    goto :end
)

set "OUT_TGZ=dist\ArcenXmlEd-linux.tar.gz"
call node pack-app-bundle.js --root "%UNPACKED%" --top-name "ArcenXmlEd-linux" --out "%OUT_TGZ%"
if errorlevel 1 (
    echo Tar packing FAILED.
    goto :end
)

echo.
echo ============================================================
echo  Build SUCCEEDED.
echo    Unpacked:      %UNPACKED%
echo    Distributable: %OUT_TGZ%
echo.
echo  User instructions:
echo    tar -xzf ArcenXmlEd-linux.tar.gz
echo    cd ArcenXmlEd-linux
echo    ./ArcenXmlEd
echo ============================================================

:end
echo.
pause
endlocal
