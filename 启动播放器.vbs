' ============================================================
'  Neko Music 启动器
' ============================================================
'  为什么用 .vbs 而不是 .bat ？
'
'  .bat 一定会开一个黑色的命令行窗口，而 electron.exe 是图形程序，
'  它会继承这个窗口。于是 bat 自己退出之后，黑窗口还被 electron
'  拽着不放 —— 就成了关不掉的额外日志窗口。
'
'  .vbs 由 wscript 执行，wscript 天生没有控制台，它启动的程序
'  也就干干净净，一个多余的黑窗口都不会有。
'
'  顺便一提：electron.exe 自带浏览器内核（运行时），
'  所以你的电脑装没装 Node.js 都能跑。
' ============================================================

Option Explicit

Dim fso, sh, root, exePath, appPath
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

' 取本脚本所在的文件夹（放到哪一级目录都能正确找到自己）
root = fso.GetParentFolderName(WScript.ScriptFullName)

exePath = root & "\node_modules\electron\dist\electron.exe"
appPath = root & "\."     ' 结尾这个点很关键，别随手删掉

If Not fso.FileExists(exePath) Then
  MsgBox "运行依赖还没装好，暂时启动不了。" & vbCrLf & vbCrLf & _
         "请在项目文件夹里打开终端，运行：" & vbCrLf & _
         "        npm install" & vbCrLf & vbCrLf & _
         "（需要先安装 Node.js：https://nodejs.org）", _
         vbCritical, "Neko Music"
  WScript.Quit 1
End If

sh.CurrentDirectory = root

' Run 的三个参数：要执行的命令、窗口样式(1=正常)、是否等它结束(False=不等)
sh.Run """" & exePath & """ """ & appPath & """", 1, False
