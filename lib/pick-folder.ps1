# 提个醒 · 文件夹选择
# 用 Windows 原生 FolderBrowserDialog 弹文件夹选择框，把选中路径写到 stdout。
# 由 Node 侧 spawn 调用（-STA 必需：FolderBrowserDialog 需要 STA 线程）。
param(
  [string]$InitialDir = ""
)
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = "选择提个醒的音效文件夹（放 wav / mp3 / m4a / aac 音频）"
if ($InitialDir -and (Test-Path $InitialDir)) {
  $f.SelectedPath = $InitialDir
}
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $f.SelectedPath
}
