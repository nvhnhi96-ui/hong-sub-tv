# Hóng Sub: where a window is on screen (physical pixels), for placing the area translations over the game.
# Reads one window handle per line, answers "x,y,w,h,minimized".
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class HsWin {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out R r, int s);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
}
"@
[HsWin]::SetProcessDPIAware() | Out-Null
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $out = 'none'
  try {
    $h = [IntPtr][Int64]$line.Trim()
    if ([HsWin]::IsWindow($h)) {
      $r = New-Object HsWin+R
      if ([HsWin]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -ne 0) { [HsWin]::GetWindowRect($h, [ref]$r) | Out-Null }
      $out = '{0},{1},{2},{3},{4}' -f $r.L, $r.T, ($r.Rt - $r.L), ($r.B - $r.T), [int][HsWin]::IsIconic($h)
    }
  } catch { $out = 'none' }
  [Console]::Out.WriteLine($out); [Console]::Out.Flush()
}
