@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
for /f "tokens=2 delims=:" %%c in ('chcp') do set "OLD_CP=%%c"
chcp 437 >nul
REM 一键导出 Mori 安装包：检查 Node，在 app 下按锁定版本安装依赖并构建 NSIS 安装包，复制到仓库根目录的 release 文件夹。
REM 在资源管理器里双击运行即可。自动化测试时加 --no-open（不打开资源管理器）与 --no-pause（结束时不等待按键）。
REM 退出码：0 成功；1 到 4 为失败的步骤编号；9 为参数错误。输出只用英文。
REM
REM 本文件是 UTF-8，只有 REM 注释含中文。中文 Windows 的控制台默认是 936（GBK）代码页，cmd 按双字节读这些注释
REM 会把一行拆开，把半句注释当命令执行（实测 936 下出错，65001 与 437 下正常）。所以开头先记下仓库根目录
REM （之后 shift 会改变第 0 个参数）与原代码页，再切到单字节的 437 解析全文，结束时恢复原代码页。

set "APP=%ROOT%app"
set "RELEASE=%ROOT%release"
set "NO_OPEN="
set "NO_PAUSE="
set "RC=0"
if defined OLD_CP set "OLD_CP=%OLD_CP: =%"
if defined OLD_CP set "OLD_CP=%OLD_CP:.=%"

:parse_args
if "%~1"=="" goto :check_node
if /i "%~1"=="--no-open" (set "NO_OPEN=1" & shift & goto :parse_args)
if /i "%~1"=="--no-pause" (set "NO_PAUSE=1" & shift & goto :parse_args)
echo Unknown option: %~1
echo Usage: build-installer.cmd [--no-open] [--no-pause]
set "RC=9"
goto :finish

:check_node
REM 第 1 步：Node 不低于 22.19（app\package.json 的 engines），并且有 npm。
REM 每一步先写好失败时的步骤名和提示，命令失败就跳到 :fail。
echo [1/5] Checking Node.js (22.19 or newer is required)...
set "STEP_NUM=1"
set "STEP_NAME=[1/5] Node.js check"
set "HINT=Node.js was not found on PATH. Install Node.js 22.19 or newer, then run this script again."
where node >nul 2>nul
if errorlevel 1 goto :fail
set "NODE_VERSION="
set "NODE_MAJOR=0"
set "NODE_MINOR=0"
for /f "delims=" %%v in ('node --version') do set "NODE_VERSION=%%v"
for /f "tokens=1,2 delims=v." %%a in ("%NODE_VERSION%") do (set "NODE_MAJOR=%%a" & set "NODE_MINOR=%%b")
set "NODE_OK="
if %NODE_MAJOR% GTR 22 set "NODE_OK=1"
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% GEQ 19 set "NODE_OK=1"
set "HINT=Found Node.js %NODE_VERSION%, but 22.19 or newer is required. Install a newer Node.js and run again."
if not defined NODE_OK goto :fail
set "HINT=npm was not found on PATH. Reinstall Node.js with npm included, then run this script again."
where npm >nul 2>nul
if errorlevel 1 goto :fail
echo       Node.js %NODE_VERSION% found.

REM 第 2 步：Electron 与 electron-builder 的工具（NSIS、7zip、winCodeSign）从 npmmirror 下载，与 app\.npmrc 一致。
REM electron-builder 26.17 读取 ELECTRON_BUILDER_BINARIES_MIRROR（app-builder-lib 的 util/electronGet.js），
REM 镜像上的这些文件与它内置的校验和一致。依赖严格按 app\package-lock.json 安装。
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
echo.
echo [2/5] Installing dependencies exactly as locked (npm ci)...
set "STEP_NUM=2"
set "STEP_NAME=[2/5] npm ci"
set "HINT=The app folder was not found next to this script: %APP%"
REM 脚本结束时隐含的 endlocal 会恢复原来的当前目录。
cd /d "%APP%"
if errorlevel 1 goto :fail
set "HINT=See the error above. If app\node_modules is in use, close Mori dev windows and editors, then retry."
call npm ci
if errorlevel 1 goto :fail

REM 第 3 步：npm run dist 已包含 check、electron-vite build 与 electron-builder --win nsis。
echo.
echo [3/5] Building the installer (npm run dist: check, build, electron-builder)...
set "STEP_NUM=3"
set "STEP_NAME=[3/5] npm run dist"
set "HINT=See the error above."
call npm run dist
if errorlevel 1 goto :fail

REM 第 4 步：electron-builder 的 NSIS 安装包默认名为 productName Setup version.exe（app-builder-lib 的 NsisTarget），
REM 两个值取自 app\package.json；electron-builder.yml 若改了 artifactName，这里要同步改。
REM 复制到 release，同名的旧文件被替换，其他版本保留。
echo.
echo [4/5] Copying the installer to release\...
set "STEP_NUM=4"
set "STEP_NAME=[4/5] copy installer"
set "PRODUCT="
set "VERSION="
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').productName"`) do set "PRODUCT=%%v"
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "VERSION=%%v"
set "SETUP_NAME=%PRODUCT% Setup %VERSION%.exe"
set "HINT=electron-builder should have produced app\dist\%SETUP_NAME%, but it is missing."
if not exist "dist\%SETUP_NAME%" goto :fail
set "HINT=Could not write %RELEASE%\%SETUP_NAME%. Close any program using it and retry."
if not exist "%RELEASE%\" mkdir "%RELEASE%"
copy /y "dist\%SETUP_NAME%" "%RELEASE%\%SETUP_NAME%" >nul
if errorlevel 1 goto :fail
for %%f in ("%RELEASE%\%SETUP_NAME%") do set /a "SIZE_MB=%%~zf / 1048576"
echo       Installer: %RELEASE%\%SETUP_NAME% (%SIZE_MB% MB)

REM 第 5 步：在资源管理器中打开 release 并选中安装包；explorer 的退出码不可靠，不检查。
echo.
if defined NO_OPEN goto :skip_open
echo [5/5] Opening release\ in Explorer...
explorer.exe /select,"%RELEASE%\%SETUP_NAME%"
goto :done
:skip_open
echo [5/5] Skipped opening Explorer (--no-open).
:done
echo.
echo Done. Installer: %RELEASE%\%SETUP_NAME%
goto :finish

REM 失败：显示失败的步骤和提示，以步骤编号作为退出码。
:fail
echo.
echo ************************************************************
echo %STEP_NAME% failed.
echo %HINT%
echo ************************************************************
set "RC=%STEP_NUM%"
goto :finish

REM 结束：恢复原代码页；双击运行时停下等待按键，让人看到结果；以 RC 退出。
:finish
if defined OLD_CP chcp %OLD_CP% >nul
echo.
if not defined NO_PAUSE pause
exit /b %RC%
