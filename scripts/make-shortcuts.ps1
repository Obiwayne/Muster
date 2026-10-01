# Creates Muster shortcuts (with the app icon) that open the app without a console window:
# one in the project folder, one on the Desktop and one in the Start menu.
#   npm run shortcuts
#
# Each shortcut carries the app's AppUserModelID (the same one the window sets), so Windows treats the
# shortcut, the running window and a taskbar pin as one app: the pin keeps this icon and relaunches
# through the shortcut's hidden launcher.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$icon = Join-Path $root 'desktop\icon.ico'
$appId = 'com.obiwayne.muster'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MusterShortcut {
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out uint c);
    int GetAt(uint i, out PropertyKey k);
    int GetValue(ref PropertyKey k, [Out] PropVariant v);
    int SetValue(ref PropertyKey k, [In] PropVariant v);
    int Commit();
  }
  [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPersistFile {
    int GetClassID(out Guid g);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string f, int mode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string f, bool remember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f);
  }
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Sequential)]
  public class PropVariant { public ushort vt; ushort r1, r2, r3; public IntPtr p; IntPtr p2; }
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}

  public static void SetAppId(string lnk, string appId) {
    var link = new CShellLink();
    ((IPersistFile)link).Load(lnk, 2);
    var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    var v = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(appId) }; // VT_LPWSTR
    var store = (IPropertyStore)link;
    store.SetValue(ref key, v);
    store.Commit();
    ((IPersistFile)link).Save(lnk, true);
    Marshal.FreeCoTaskMem(v.p);
  }
}
'@

$shell = New-Object -ComObject WScript.Shell
$startMenu = [Environment]::GetFolderPath('Programs')
foreach ($dir in @($root, [Environment]::GetFolderPath('Desktop'), $startMenu)) {
  $path = Join-Path $dir 'Muster.lnk'
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $PSScriptRoot 'launch.vbs') + '"'
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = 'Muster: run a crew of Claude Code agents'
  $lnk.Save()
  [MusterShortcut]::SetAppId($path, $appId)
  Write-Output "Created $path"
}
# Ask Explorer to drop cached icons for these shortcuts.
& "$env:WINDIR\System32\ie4uinit.exe" -show 2>$null
