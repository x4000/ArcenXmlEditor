@echo off
setlocal EnableDelayedExpansion

REM ===================================================================
REM  build-mac.bat — cross-build a macOS distributable from Windows.
REM
REM  Output: dist\ArcenXmlEd-mac.tar.gz
REM    Contains: ArcenXmlEd.app/ (full bundle with launcher and helper
REM              binaries / .dylibs at mode 0755)
REM
REM  Pipeline:
REM    1. Bundle the renderer (esbuild).
REM    2. @electron/packager assembles the .app bundle from a downloaded
REM       Electron macOS runtime. We use @electron/packager instead of
REM       electron-builder because electron-builder 25.x explicitly
REM       refuses to build for macOS from non-macOS hosts ("Build for
REM       macOS is supported only on macOS"). @electron/packager has
REM       no such restriction.
REM    3. pack-app-bundle.js walks the .app, sniffs Mach-O magic on
REM       every file, and writes the tar.gz with 0755 on every binary
REM       / .dylib / Contents/MacOS/<helper>.
REM
REM  After download, the user must bypass Gatekeeper on first launch
REM  since the build is unsigned (right-click → Open, or
REM  `xattr -dr com.apple.quarantine ArcenXmlEd.app`). Signing requires
REM  a macOS host with Xcode + Apple Developer cert — not something we
REM  can do from Windows.
REM
REM  Defaults to x64 (broadest Mac install base). Pass arm64 for an
REM  Apple Silicon native build:
REM    build-mac.bat arm64
REM ===================================================================

set "ARCH=%~1"
if "%ARCH%"=="" set "ARCH=x64"
if not "%ARCH%"=="x64" if not "%ARCH%"=="arm64" (
    echo Unknown arch: %ARCH%   ^(use x64 or arm64^)
    set ERRORLEVEL=1
    goto :end
)

echo ============================================================
echo  Building ArcenXmlEd for macOS-%ARCH% (cross-build from Windows)
echo ============================================================
echo.

cd /d "%~dp0"

echo [1/3] Bundling renderer...
call node build.js
if errorlevel 1 (
    echo Renderer build FAILED.
    goto :end
)

echo [2/3] Assembling .app with @electron/packager...
call node build-mac-app.js --arch %ARCH%
if errorlevel 1 (
    echo .app assembly FAILED.
    goto :end
)

echo [3/3] Packing .app into tar.gz with exec bits...
REM @electron/packager outputs to dist\ArcenXmlEd-darwin-<arch>\ArcenXmlEd.app
set "APPDIR=dist\ArcenXmlEd-darwin-%ARCH%\ArcenXmlEd.app"
if not exist "%APPDIR%" (
    echo Expected .app not found: %APPDIR%
    set ERRORLEVEL=1
    goto :end
)

set "OUT_TGZ=dist\ArcenXmlEd-mac-%ARCH%.tar.gz"
call node pack-app-bundle.js --root "%APPDIR%" --out "%OUT_TGZ%"
if errorlevel 1 (
    echo Tar packing FAILED.
    goto :end
)

echo.
echo ============================================================
echo  Build SUCCEEDED.
echo    .app:          %APPDIR%
echo    Distributable: %OUT_TGZ%
echo.
echo  User instructions:
echo    tar -xzf ArcenXmlEd-mac-%ARCH%.tar.gz
echo    xattr -dr com.apple.quarantine ArcenXmlEd.app
echo    open ArcenXmlEd.app
echo ============================================================

:end
echo.
pause
endlocal
