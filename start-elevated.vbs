' Desked - Elevated Launcher
' Runs Node.js at High Integrity Level via ShellExecute "runas".
' This bypasses Windows UIPI, allowing input injection into elevated
' processes such as Task Manager.
'
' Usage: Double-click this file. UAC will prompt once, then the server
'        starts hidden. Use start-hidden.vbs if you do NOT need this.
'
' Quick Tunnel is the default. The Cloudflare Tunnel token and port are
' read from .env (TUNNEL_TOKEN / PORT); no secrets are hard-coded here.

Dim fso, dir, envPath, token, port, ts, line
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
envPath = fso.BuildPath(dir, ".env")
token = ""
port = "3389"

' Read TUNNEL_TOKEN and PORT from .env (if present)
If fso.FileExists(envPath) Then
  Set ts = fso.OpenTextFile(envPath, 1)
  Do While Not ts.AtEndOfStream
    line = Trim(ts.ReadLine)
    If Left(line, Len("TUNNEL_TOKEN=")) = "TUNNEL_TOKEN=" Then
      token = Trim(Mid(line, Len("TUNNEL_TOKEN=") + 1))
      If Left(token, 1) = """" Then token = Mid(token, 2, Len(token) - 2)
      If Left(token, 1) = "'" Then token = Mid(token, 2, Len(token) - 2)
    ElseIf Left(line, Len("PORT=")) = "PORT=" Then
      port = Trim(Mid(line, Len("PORT=") + 1))
      If port = "" Then port = "3389"
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
'    Quick Tunnel by default; named tunnel when a token is set.
' ----------------------------------------------------------------
Dim tunnelArgs
If Len(token) > 0 Then
  tunnelArgs = "tunnel --no-autoupdate --protocol http2 run --token """ & token & """"
Else
  tunnelArgs = "tunnel --no-autoupdate --url http://localhost:" & port
End If

Set wshShell = CreateObject("WScript.Shell")
wshShell.CurrentDirectory = dir
wshShell.Run "cmd /c .\cloudflared.exe " & tunnelArgs & " > cloudflare.log 2>&1", 0, False
