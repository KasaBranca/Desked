' Desked - Elevated Launcher
' Runs Node.js at High Integrity Level via ShellExecute "runas".
' This bypasses Windows UIPI, allowing input injection into elevated
' processes such as Task Manager.
'
' Usage: Double-click this file. UAC will prompt once, then the server
'        starts hidden. Use start-hidden.vbs if you do NOT need this.
'
' The Cloudflare Tunnel token is read from .env (TUNNEL_TOKEN); it is
' never hard-coded here.

Dim fso, dir, envPath, token, ts, line, prefix
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
envPath = fso.BuildPath(dir, ".env")
token = ""

' Read TUNNEL_TOKEN from .env (if present)
If fso.FileExists(envPath) Then
  Set ts = fso.OpenTextFile(envPath, 1)
  prefix = "TUNNEL_TOKEN="
  Do While Not ts.AtEndOfStream
    line = Trim(ts.ReadLine)
    If Left(line, Len(prefix)) = prefix Then
      token = Trim(Mid(line, Len(prefix) + 1))
      If Left(token, 1) = """" Then token = Mid(token, 2, Len(token) - 2)
      If Left(token, 1) = "'" Then token = Mid(token, 2, Len(token) - 2)
      Exit Do
    End If
  Loop
  ts.Close
End If

' ----------------------------------------------------------------
' 1. Launch Node server ELEVATED (High Integrity Level)
'    ShellExecute with "runas" triggers a UAC prompt and gives the
'    child process a High IL token - bypassing UIPI.
' ----------------------------------------------------------------
Set oShell = CreateObject("Shell.Application")
oShell.ShellExecute "cmd.exe", _
    "/c cd /d """ & dir & """ && node server.js > server.log 2>&1", _
    dir, "runas", 0

' ----------------------------------------------------------------
' 2. Wait briefly so the tunnel starts after the server is ready
' ----------------------------------------------------------------
WScript.Sleep 3000

' ----------------------------------------------------------------
' 3. Launch Cloudflare Tunnel (standard privilege is sufficient)
' ----------------------------------------------------------------
Dim tunnelArgs
If Len(token) > 0 Then
  tunnelArgs = "tunnel --no-autoupdate --protocol http2 run --token """ & token & """"
Else
  tunnelArgs = "tunnel --no-autoupdate --url http://localhost:3389"
End If

Set wshShell = CreateObject("WScript.Shell")
wshShell.CurrentDirectory = dir
wshShell.Run "cmd /c .\cloudflared.exe " & tunnelArgs & " > cloudflare.log 2>&1", 0, False
