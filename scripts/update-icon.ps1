$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$sc = $ws.CreateShortcut($desktop + '\DeepFusion.lnk')
$sc.IconLocation = 'C:/Users/Administrator/Desktop/deeepseek/deepfusion/electron/anime-icon.ico,0'
$sc.Save()
Write-Output 'OK shortcut icon updated'
