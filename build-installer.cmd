@echo off
setlocal EnableExtensions
set "SELF=%~f0"
set "ROOT=%~dp0"
for /f "tokens=2 delims=:" %%c in ('chcp') do set "OLD_CP=%%c"
chcp 437 >nul
REM 一键导出 Mori 安装包：检查 Node，在 app 下按锁定版本安装依赖并构建 NSIS 安装包，复制到仓库根目录的 release 文件夹。
REM 在资源管理器里双击运行即可。自动化测试时加 --no-open（不打开资源管理器）与 --no-pause（结束时不等待按键）。
REM 退出码：0 成功；1 到 4 为失败的步骤编号；9 为参数错误。
REM
REM 本文件是 UTF-8。cmd 在 65001 代码页下解析含中文的批处理行会错位，所以开头先记下脚本路径、仓库根目录
REM 与原代码页（之后 shift 会改变第 0 个参数），再切到单字节的 437 解析全文，结束时恢复原代码页。
REM 中文提示放在文件末尾，失败时临时切到 65001，用 findstr 按前缀取出显示。

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
REM 每一步先写好失败时的步骤名、英文提示和中文提示的前缀，命令失败就跳到 :fail。
echo [1/5] Checking Node.js (22.19 or newer is required)...
set "STEP_NUM=1"
set "STEP_EN=[1/5] Node.js check"
set "HINT_ID=node-missing"
set "HINT_EN=Node.js was not found on PATH. Install Node.js 22.19 or newer, then run this script again."
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
set "HINT_ID=node-old"
set "HINT_EN=Found Node.js %NODE_VERSION%, but 22.19 or newer is required. Install a newer Node.js and run again."
if not defined NODE_OK goto :fail
set "HINT_ID=npm-missing"
set "HINT_EN=npm was not found on PATH. Reinstall Node.js with npm included, then run this script again."
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
set "STEP_EN=[2/5] npm ci"
set "HINT_ID=no-app"
set "HINT_EN=The app folder was not found next to this script: %APP%"
REM 脚本结束时隐含的 endlocal 会恢复原来的当前目录。
cd /d "%APP%"
if errorlevel 1 goto :fail
set "HINT_ID=npm-ci"
set "HINT_EN=See the error above. If app\node_modules is in use, close Mori dev windows and editors, then retry."
call npm ci
if errorlevel 1 goto :fail

REM 第 3 步：npm run dist 已包含 check、electron-vite build 与 electron-builder --win nsis。
echo.
echo [3/5] Building the installer (npm run dist: check, build, electron-builder)...
set "STEP_NUM=3"
set "STEP_EN=[3/5] npm run dist"
set "HINT_ID=npm-dist"
set "HINT_EN=See the error above."
call npm run dist
if errorlevel 1 goto :fail

REM 第 4 步：electron-builder 的 NSIS 安装包默认名为 productName Setup version.exe（app-builder-lib 的 NsisTarget），
REM 两个值取自 app\package.json；electron-builder.yml 若改了 artifactName，这里要同步改。
REM 复制到 release，同名的旧文件被替换，其他版本保留。
echo.
echo [4/5] Copying the installer to release\...
set "STEP_NUM=4"
set "STEP_EN=[4/5] copy installer"
set "PRODUCT="
set "VERSION="
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').productName"`) do set "PRODUCT=%%v"
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "VERSION=%%v"
set "SETUP_NAME=%PRODUCT% Setup %VERSION%.exe"
set "HINT_ID=no-setup"
set "HINT_EN=electron-builder should have produced app\dist\%SETUP_NAME%, but it is missing."
if not exist "dist\%SETUP_NAME%" goto :fail
set "HINT_ID=copy"
set "HINT_EN=Could not write %RELEASE%\%SETUP_NAME%. Close any program using it and retry."
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

REM 失败：先显示英文，再临时切到 65001 显示文件末尾对应前缀的中文（步骤名在前，提示在后）。
:fail
echo.
echo ************************************************************
echo %STEP_EN% failed.
echo %HINT_EN%
chcp 65001 >nul
for /f "tokens=1,* delims= " %%a in ('findstr /b /c:"::zh-step%STEP_NUM% " /c:"::zh-%HINT_ID% " "%SELF%"') do echo %%b
chcp 437 >nul
echo ************************************************************
set "RC=%STEP_NUM%"
goto :finish

REM 结束：恢复原代码页；双击运行时停下等待按键，让人看到结果；以 RC 退出。
:finish
if defined OLD_CP chcp %OLD_CP% >nul
echo.
if not defined NO_PAUSE pause
exit /b %RC%

REM 以下是中文提示，只由 :fail 用 findstr 按前缀取出，cmd 不会执行到这里。
::zh-step1 [1/5] 检查 Node.js 失败。
::zh-step2 [2/5] 安装依赖（npm ci）失败。
::zh-step3 [3/5] 构建安装包（npm run dist）失败。
::zh-step4 [4/5] 复制安装包失败。
::zh-node-missing 在 PATH 中找不到 Node.js。请安装 Node.js 22.19 或更新版本后重新运行。
::zh-node-old 当前 Node.js 版本过低（见上一行），需要 22.19 或更新版本。请升级后重新运行。
::zh-npm-missing 在 PATH 中找不到 npm。请重新安装带 npm 的 Node.js 后重新运行。
::zh-no-app 脚本旁边找不到 app 文件夹（路径见上一行）。
::zh-npm-ci 请查看上面的错误。如果 app\node_modules 被占用，先关掉开发中的 Mori 窗口和编辑器再重试。
::zh-npm-dist 请查看上面的错误输出。
::zh-no-setup electron-builder 没有生成预期的安装包（文件名见上一行）。
::zh-copy 无法写入 release 文件夹里的安装包。请关闭正在使用它的程序后重试。
