$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$exe = 'C:/Users/Administrator/Desktop/deeepseek/deepfusion/dist/DeepFusion-win32-x64/DeepFusion.exe'
$wd = 'C:/Users/Administrator/Desktop/deeepseek/deepfusion/dist/DeepFusion-win32-x64'
$sc = $ws.CreateShortcut($desktop + '\DeepFusion.lnk')
$sc.TargetPath = $exe
$sc.WorkingDirectory = $wd
$sc.Description = 'DeepFusion 深融 - DSH x Reasonix 融合 Agent'
$sc.Save()
Write-Output 'OK shortcut saved'
