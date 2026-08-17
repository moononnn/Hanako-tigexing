# 提个醒 - WinRT toast 通知发送脚本
# 首次运行自动注册 AppUserModelID（快捷方式 + 注册表显示名），
# 之后直接发 toast。标题/正文通过环境变量 TXS_TITLE / TXS_MSG 传入，无注入风险。
# 方案源自歇一会插件（验证过的生产方案），改 AUMID 与显示名为「提个醒」。

$ErrorActionPreference = "Stop"

$AUMID = "TiGeXing.App"
$lnk = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\TiGeXing.lnk"
$regPath = "HKCU:\SOFTWARE\Classes\AppUserModelId\$AUMID"

# ── 首次注册：快捷方式 + 注册表显示名（已注册则跳过） ──
if (-not (Test-Path $lnk) -or -not (Test-Path $regPath)) {
    if (-not (Test-Path $lnk)) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class TxsLnk
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    public class ShellLink { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    public interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010B-0000-0000-C000-000000000046")]
    public interface IPersistFile
    {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder ppszFileName);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    public interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint cProps);
        [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        [PreserveSig] int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY
    {
        public Guid fmtid;
        public uint pid;
    }

    // x64 正确的 PROPVARIANT：vt+reserved=8 字节，union=16 字节，总 24 字节
    [StructLayout(LayoutKind.Explicit)]
    public struct PROPVARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(2)] public ushort wReserved1;
        [FieldOffset(4)] public ushort wReserved2;
        [FieldOffset(6)] public ushort wReserved3;
        [FieldOffset(8)] public IntPtr pointer;
        [FieldOffset(8)] public byte byteVal;
        [FieldOffset(8)] public short shortVal;
        [FieldOffset(8)] public int intVal;
        [FieldOffset(8)] public long longVal;
        [FieldOffset(16)] public IntPtr pointer2; // 补齐 union 剩余 8 字节
    }

    public static void SetAppUserModelID(string lnkPath, string appId)
    {
        var link = (IShellLinkW)new ShellLink();
        try
        {
            ((IPersistFile)link).Load(lnkPath, 2);
            var store = (IPropertyStore)link;
            var key = new PROPERTYKEY();
            key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
            key.pid = 5;
            var pv = new PROPVARIANT();
            pv.vt = 31;
            pv.pointer = Marshal.StringToCoTaskMemUni(appId);
            try
            {
                store.SetValue(ref key, ref pv);
                store.Commit();
                ((IPersistFile)link).Save(lnkPath, true);
            }
            finally
            {
                Marshal.FreeCoTaskMem(pv.pointer);
            }
        }
        finally
        {
            Marshal.ReleaseComObject(link);
        }
    }
}
"@

        $pyw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
        if (-not $pyw) { $pyw = Join-Path $env:WINDIR "pyw.exe" }
        $shell = New-Object -ComObject WScript.Shell
        $sc = $shell.CreateShortcut($lnk)
        $sc.TargetPath = $pyw
        $sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,15"
        $sc.Description = "提个醒"
        $sc.Save()
        [TxsLnk]::SetAppUserModelID($lnk, $AUMID)
    }

    # 注册表显示名与图标（新版 Win11 优先读这里，而不是快捷方式文件名）
    if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
    New-ItemProperty -Path $regPath -Name "DisplayName" -Value "提个醒" -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "IconUri" -Value "$PSScriptRoot\app-icon.png" -PropertyType String -Force | Out-Null
}

# ── 发送 toast ──
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$t = [Environment]::GetEnvironmentVariable("TXS_TITLE", "Process")
$m = [Environment]::GetEnvironmentVariable("TXS_MSG", "Process")
$st = [Environment]::GetEnvironmentVariable("TXS_STYLE", "Process")
$t2 = [System.Security.SecurityElement]::Escape([string]$t)
$m2 = [System.Security.SecurityElement]::Escape([string]$m)

# 头像（appLogoOverride）：优先 TXS_ICON（助手头像），回退插件图标，plain 时纯文本
$img = ""
if ($st -ne "plain") {
    $icon = [Environment]::GetEnvironmentVariable("TXS_ICON", "Process")
    if (-not $icon -or -not (Test-Path $icon)) {
        $icon = Join-Path $PSScriptRoot "app-icon.png"
    }
    if (Test-Path $icon) {
        $iconUri = "file:///" + ($icon -replace '\\', '/')
        $img = "<image placement='appLogoOverride' src='$iconUri'/>"
    }
}

# 音效：TXS_SOUND 指定音频文件时，toast 自身静音、由脚本独立播放
# （WinRT toast 的 audio src 只认 ms-appx/ms-winsoundevent，file:// 会被忽略并回退系统默认音，
#   所以自定义音不能靠 toast 播，必须绕开它）；TXS_SOUND=silent 时静音；都不传用系统默认通知音
$audioTag = ""
$playSound = $false
$sd = [Environment]::GetEnvironmentVariable("TXS_SOUND", "Process")
if ($sd -eq "silent") {
    $audioTag = "<audio silent='true'/>"
} elseif ($sd) {
    $sdPath = $sd
    if (Test-Path $sdPath) {
        $sdUri = "file:///" + ($sdPath -replace '\\', '/')
        $audioTag = "<audio silent='true'/>"
        $playSound = $true
    }
}

$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'>$img<text>$t2</text><text>$m2</text></binding></visual>$audioTag</toast>")
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AUMID).Show($toast)

# ── 独立播放自定义音效（toast 不支持 file:// 音频，见上） ──
if ($playSound) {
    try {
        $ext = [System.IO.Path]::GetExtension($sdPath).ToLower()
        if ($ext -eq ".wav") {
            # wav 走 .NET SoundPlayer（最稳，同步播完再退出进程）
            $sp = [System.Media.SoundPlayer]::new($sdPath)
            $sp.PlaySync()
            $sp.Dispose()
        } else {
            # mp3/m4a/aac 走 WinRT MediaPlayer（系统解码器），轮询到播放结束或超时
            [Windows.Media.Playback.MediaPlayer, Windows.Media.Playback, ContentType = WindowsRuntime] | Out-Null
            [Windows.Media.Core.MediaSource, Windows.Media.Core, ContentType = WindowsRuntime] | Out-Null
            $mp = [Windows.Media.Playback.MediaPlayer]::new()
            $mp.Source = [Windows.Media.Core.MediaSource]::CreateFromUri([Uri]$sdUri)
            $mp.Play()
            $deadline = (Get-Date).AddSeconds(15)
            while ((Get-Date) -lt $deadline) {
                $pst = $mp.PlaybackSession.PlaybackState
                $ppos = $mp.PlaybackSession.Position.TotalSeconds
                $pdur = $mp.PlaybackSession.NaturalDuration.TotalSeconds
                # 播完的两种形态：Ended；或 Paused 且已到末尾（WinRT MediaPlayer 实测播完停在 Paused）
                if ($pst -eq [Windows.Media.Playback.MediaPlaybackState]::Ended) { break }
                if ($pst -eq [Windows.Media.Playback.MediaPlaybackState]::Paused -and $pdur -gt 0 -and $ppos -ge ($pdur - 0.15)) { break }
                Start-Sleep -Milliseconds 200
            }
            $mp.Dispose()
        }
    } catch {
        # 播放失败不影响通知本身（静音兜底）
    }
}
