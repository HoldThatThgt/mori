# 卸载向导的界面测试驱动（docs/v0/screens/uninstall.md“界面测试怎样碰到卸载向导”）：用 Win32 消息找到卸载向导的窗口，
# 读欢迎页和它之后那一页的文字、勾选框与按钮；带 -Check 时勾上、点 < Back 回到欢迎页再点 Next > 回来；之后点 Uninstall，
# 等到 Finish 页点 Finish。结果以一行 JSON 写到标准输出，由 tests/ui/uninstall.mjs 判断；等不到窗口或控件时 error 写原因。
# 不用 UI Automation：这台机器上它把 NSIS 的每个控件都当成没有 Invoke、Toggle 的 Pane（2026-10-28 实测）。
# 点按钮照按钮自己发给对话框的通知发 WM_COMMAND（BN_CLICKED）：BM_CLICK 在对话框不是活动窗口时不起作用（同日实测）；
# 勾选照自动勾选框被点时的样子先 BM_SETCHECK、再给页面发 BN_CLICKED（nsDialogs 的 OnClick 认这个通知）。
# 文件用带 BOM 的 UTF-8 保存（Windows PowerShell 5.1 没有 BOM 时按系统代码页读）。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File uninstall-ui.ps1 -Product "Mori Uninstall Test" [-Check]
param(
  [Parameter(Mandatory = $true)][string]$Product,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class MoriWizard {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr param);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  public static string Text(IntPtr hwnd) {
    int n = (int)SendMessage(hwnd, 0x000E, IntPtr.Zero, IntPtr.Zero);
    var s = new StringBuilder(n + 1);
    SendMessage(hwnd, 0x000D, (IntPtr)(n + 1), s);
    return s.ToString();
  }
  public static string Class(IntPtr hwnd) { var s = new StringBuilder(256); GetClassName(hwnd, s, 256); return s.ToString(); }
  public static List<IntPtr> Children(IntPtr parent) {
    var list = new List<IntPtr>();
    EnumChildWindows(parent, (h, p) => { if (IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
}
'@
$W = [MoriWizard]

# 每 200 毫秒调一次 Probe，返回第一个非空值；Ms 毫秒内都是空时抛错
function Wait-For([scriptblock]$Probe, [int]$Ms, [string]$What) {
  $deadline = [DateTime]::Now.AddMilliseconds($Ms)
  while ([DateTime]::Now -lt $deadline) {
    $value = & $Probe
    if ($null -ne $value) { return $value }
    Start-Sleep -Milliseconds 200
  }
  throw "Timed out waiting for $What"
}

# 卸载向导的窗口：标题是“<产品名> Uninstall”（NSIS 的 $(^UninstallCaption)）；没有时为空
function Find-Wizard {
  $hwnd = $W::FindWindow('#32770', "$Product Uninstall")
  if ($hwnd -ne [IntPtr]::Zero) { return $hwnd }
  return $null
}

# 控件的文字，去掉快捷键的 &
function Get-Label($Hwnd) { return ($W::Text($Hwnd) -replace '&', '') }

# 向导底部的按钮（直接在窗口上），按 NSIS 的控件 ID：1 下一步（Next > / Uninstall / Finish）、2 Cancel、3 < Back
function Find-Button($Window, [int]$Id) {
  foreach ($hwnd in $W::Children($Window)) {
    if ($W::GetParent($hwnd) -eq $Window -and $W::GetDlgCtrlID($hwnd) -eq $Id) { return $hwnd }
  }
  return $null
}

# 点向导底部的按钮：按钮被点时发给对话框的 WM_COMMAND（BN_CLICKED 为 0，wParam 就是控件 ID）
function Click-Button($Window, [int]$Id) {
  [void]$W::SendMessage($Window, 0x0111, [IntPtr]$Id, (Find-Button $Window $Id))
}

# 当前页上的勾选框（页面里 Button 类的控件；欢迎页没有，返回空）
function Find-Box($Window) {
  foreach ($hwnd in $W::Children($Window)) {
    if ($W::GetParent($hwnd) -ne $Window -and $W::Class($hwnd) -eq 'Button') { return $hwnd }
  }
  return $null
}

# 勾选框的勾选：On / Off（BM_GETCHECK）
function Get-Toggle($Box) {
  if ([int]$W::SendMessage($Box, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero) -eq 1) { return 'On' }
  return 'Off'
}

# 勾上：BM_SETCHECK，再给页面发 BN_CLICKED（自动勾选框被点时先改勾选、再发这个通知）
function Check-Box($Box) {
  [void]$W::SendMessage($Box, 0x00F1, [IntPtr]1, [IntPtr]::Zero)
  [void]$W::SendMessage($W::GetParent($Box), 0x0111, [IntPtr]$W::GetDlgCtrlID($Box), $Box)
}

# 读欢迎页之后那一页：页头与页上的全部文字、勾选框的文字与勾选、三个按钮的文字
function Read-DataPage($Window, $Box) {
  $texts = @($W::Children($Window) | Where-Object { $W::Class($_) -eq 'Static' } | ForEach-Object { Get-Label $_ })
  return [ordered]@{
    texts = @($texts | Where-Object { $_ -ne '' })
    box = Get-Label $Box
    state = Get-Toggle $Box
    next = Get-Label (Find-Button $Window 1)
    back = Get-Label (Find-Button $Window 3)
    cancel = Get-Label (Find-Button $Window 2)
  }
}

# 勾上，点 < Back 回到欢迎页（页上没有勾选框了），再点 Next > 回来，读勾选
function Test-Back($Window, $Box) {
  Check-Box $Box
  $checked = Get-Toggle $Box
  Click-Button $Window 3
  Wait-For { if ($null -eq (Find-Box $Window)) { $true } } 10000 'the welcome page' | Out-Null
  Click-Button $Window 1
  $again = Wait-For { Find-Box $Window } 10000 'the Your Mori data page again'
  return [ordered]@{ checked = $checked; afterBack = Get-Toggle $again }
}

# 点 Uninstall 之后等到 Finish 页（下一步的按钮写 Finish），返回按钮的文字；窗口先关掉时抛错。按句柄查窗口还在不在：
# NSIS 换页时会在标题后面加上这一页的说明（例如“: Uninstalling”），按标题找不到
function Wait-Finish($Window) {
  return Wait-For {
    if (-not $W::IsWindow($Window)) { throw 'The wizard closed before the Finish page' }
    $button = Find-Button $Window 1
    if ($button -and (Get-Label $button) -eq 'Finish') { 'Finish' }
  } 120000 'the Finish page'
}

$result = [ordered]@{ welcome = $null; page = $null; back = $null; finish = $null; error = $null }
try {
  $window = Wait-For { Find-Wizard } 30000 'the uninstall wizard'
  $next = Wait-For { Find-Button $window 1 } 10000 'the Next button'
  $boxes = if ($null -eq (Find-Box $window)) { 0 } else { 1 }
  $result.welcome = [ordered]@{ next = Get-Label $next; boxes = $boxes }
  Click-Button $window 1
  $box = Wait-For { Find-Box $window } 10000 'the Your Mori data page'
  $result.page = Read-DataPage $window $box
  if ($Check) { $result.back = Test-Back $window $box }
  Click-Button $window 1
  $result.finish = Wait-Finish $window
  Click-Button $window 1
} catch {
  $result.error = $_.Exception.Message
}
$result | ConvertTo-Json -Depth 5 -Compress
