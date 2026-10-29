; Mori 的卸载向导：欢迎页之后问要不要删掉 Mori 的数据（docs/v0/screens/uninstall.md，2026-10-28 U75）。
; electron-builder.yml 的 nsis.include 载入这个文件。它在 electron-builder 的模板之前被包含，所以页面、变量与函数都写在
; 模板插入的宏里：customUnWelcomePage 插在卸载程序的页面列表里（只在编译卸载程序时插入），customUnInstall 插在卸载那一节
; 的开头、删程序之前。electron-builder 编译时把警告当错误（-WX），没用到的变量和函数都不能有。
; 文件用带 BOM 的 UTF-8 保存：没有 BOM 时 NSIS 按系统代码页读，界面文字里的 ’ 会读错。
; ${APP_FILENAME} 是产品名（Mori）；界面测试另打的安装包是 "Mori Uninstall Test"，删的也就是它自己的数据文件夹。

!include nsDialogs.nsh
!include LogicLib.nsh

; 两个数据文件夹按当前用户取（Electron 的数据目录总是按用户的）：为所有用户安装时暂时切到当前用户，
; 同 electron-builder 自己删数据的写法。
!macro moriDataDirs
  ${If} $installMode == "all"
    SetShellVarContext current
  ${EndIf}
  StrCpy $moriRoamingDir "$APPDATA\${APP_FILENAME}"
  StrCpy $moriLocalDir "$LOCALAPPDATA\${APP_FILENAME}"
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
!macroend

; 欢迎页之后加“Your Mori data”一页。
!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.moriDataPage

  ; 勾上时为 "1"、取消时为 "0"；静默运行（装新版本、/S）不经过这一页，保持空串，什么都不删
  Var moriDeleteData
  ; 这一页的勾选框
  Var moriDeleteDataBox
  ; %APPDATA%\Mori（设置、key、会话、记忆……）
  Var moriRoamingDir
  ; %LOCALAPPDATA%\Mori（文件快照）
  Var moriLocalDir

  ; 建这一页：说明、两个文件夹的实际路径、勾选框（按 moriDeleteData 恢复，所以 Back 再回来时勾选照旧）。
  Function un.moriDataPage
    !insertmacro MUI_HEADER_TEXT "Your Mori data" "Choose whether to delete it along with Mori."
    !insertmacro moriDataDirs
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0u 0u 100% 20u \
      "Mori keeps your settings, saved API keys, sessions, memory and file snapshots in these folders:"
    Pop $0
    ${NSD_CreateLabel} 10u 22u 290u 10u "$moriRoamingDir"
    Pop $0
    ${NSD_CreateLabel} 10u 34u 290u 10u "$moriLocalDir"
    Pop $0
    ${NSD_CreateLabel} 0u 50u 100% 20u \
      "Uninstalling keeps them, so installing Mori again picks up where you left off."
    Pop $0
    ${NSD_CreateCheckbox} 0u 78u 100% 12u "Also delete my Mori data"
    Pop $moriDeleteDataBox
    ${If} $moriDeleteData == "1"
      ${NSD_Check} $moriDeleteDataBox
    ${EndIf}
    ${NSD_OnClick} $moriDeleteDataBox un.moriDataToggle
    ${NSD_CreateLabel} 12u 92u 288u 20u "This can’t be undone. Files in your project folders aren’t changed."
    Pop $0
    ; 点下一步就开始卸载，按钮写 Uninstall（同一台电脑上两份安装都在时，之后还有 electron-builder 选哪一份的那页）
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(^UninstallBtn)"
    nsDialogs::Show
  FunctionEnd

  ; 勾选框每次点击时记下勾选（栈上是勾选框的句柄，先弹出）。
  Function un.moriDataToggle
    Pop $moriDeleteData
    ${NSD_GetState} $moriDeleteDataBox $moriDeleteData
  FunctionEnd
!macroend

; 卸载那一节的开头（删程序之前）：勾上时删掉两个数据文件夹，整个文件夹。
!macro customUnInstall
  ${If} $moriDeleteData == "1"
    !insertmacro moriDataDirs
    RMDir /r "$moriRoamingDir"
    RMDir /r "$moriLocalDir"
  ${EndIf}
!macroend
