/**
 * win-focus.js — Windows 前台窗口工具（仅 win32 使用，零原生依赖）
 *
 * 背景：Electron 应用点击「播放」时自身持有前台焦点，Windows 前台锁
 * （foreground lock）会拒绝后台进程激活窗口，导致 mpv 等外部播放器窗口
 * 静默落在主窗口背后（「播放器不出现在前台」）。mpv 自身的 --focus-on-open
 * 只是请求，同样不可靠。
 *
 * 方案：spawn 一个脱离的 PowerShell 辅助进程，用 Win32 P/Invoke 反复尝试
 * 激活目标 pid 的顶层窗口（AttachThreadInput + SetForegroundWindow）——
 * 前台锁只允许「持有前台线程输入队列的线程」成功激活，AttachThreadInput
 * 即建立该关联，绕开锁限制。辅助进程自检到窗口已在前台或超时即退出，
 * 播放主流程不受影响（fire-and-forget）。
 *
 * 仅 win32 生效；其余平台直接跳过（mpv --focus-on 已自带）。
 */

const { spawn } = require('child_process');
const IS_WIN = process.platform === 'win32';

const HELPER = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class FocusWin {',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    "}'@",
    "# 目标 pid 由 Node 侧内插（见 bringToFront）：不能用 $args —— powershell -Command 会把",
    '# 其后的独立参数拼进同一段脚本文本（而非脚本参数），$args 恒为空、pid 被当裸语句执行，',
    '# 实测 $targetPid 永远是 0，激活从未生效过。',
    '$targetPid = __PID__',
    '$deadline = [Environment]::TickCount + 6000',
    'for ($i = 0; $i -lt 40; $i++) {',
    '  $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue',
    '  if ($null -eq $p) { exit 0 }                       # 进程已退出',
    '  $h = $p.MainWindowHandle',
    '  if ($h -eq [IntPtr]::Zero) {                       # 窗口还没创建',
    '    if ([Environment]::TickCount -gt $deadline) { exit 0 }',
    '    Start-Sleep -Milliseconds 150',
    '    continue',
    '  }',
    '  $fg = [FocusWin]::GetForegroundWindow()',
    '  if ($fg -eq $h) { exit 0 }                         # 已在台前',
    '  $fgPid = 0',
    '  [void][FocusWin]::GetWindowThreadProcessId($fg, [ref]$fgPid)',
    '  if ($fgPid -eq $targetPid) { exit 0 }              # 同进程窗口已成前台',
    '  if ([FocusWin]::IsIconic($h)) { [void][FocusWin]::ShowWindow($h, 9) }  # 9=SW_RESTORE',
    '  $cur = [FocusWin]::GetCurrentThreadId()',
    '  $fgTid = 0',
    '  [void][FocusWin]::GetWindowThreadProcessId($fg, [ref]$fgTid)',
    '  if ($cur -ne 0 -and $fgTid -ne 0) {',
    '    [void][FocusWin]::AttachThreadInput($cur, $fgTid, $true)',
    '    [void][FocusWin]::SetForegroundWindow($h)',
    '    [void][FocusWin]::AttachThreadInput($cur, $fgTid, $false)',
    '  } else {',
    '    [void][FocusWin]::SetForegroundWindow($h)',
    '  }',
    '  if ([Environment]::TickCount -gt $deadline) { exit 0 }',
    '  Start-Sleep -Milliseconds 150',
    '}',
    'exit 0',
].join('\n');

/**
 * 把 pid 对应的顶层窗口带到前台（异步 fire-and-forget，不阻塞、不抛异常）。
 *
 * @param {number} pid 目标进程 PID（mpv 子进程）
 */
function bringToFront(pid) {
    if (!IS_WIN) return;
    if (typeof pid !== 'number' || !(pid > 0)) return;
    try {
        // -ExecutionPolicy Bypass：绕过本机执行策略（Add-Type 编译内联 C# 不受其限，
        // 但显式声明更稳）；windowsHide 避免闪黑窗；detached + unref 不挂父进程。
        // pid 必须内插进脚本文本：-Command 形态下独立参数不会进入 $args（见 HELPER 内注释）。
        const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
                HELPER.replace('__PID__', String(Math.floor(pid)))],
            { stdio: 'ignore', windowsHide: true, detached: true }
        );
        child.unref();
    } catch (e) { /* 辅助进程失败不影响播放 */ }
}

module.exports = { bringToFront };
