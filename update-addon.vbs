' update-addon.vbs
'
' Downloads the latest GuildRosterLogger.toc/.lua from this repo and copies
' them into your WoW AddOns folder, if they've changed. No Node, no git,
' nothing to install - just double-click install-addon-updater.bat once and
' this keeps your addon current automatically after that.
'
' First run asks (once) where your WoW AddOns folder is and remembers the
' answer in wow-addons-path.txt next to this script. Every run after that -
' including the silent ones Task Scheduler triggers at each logon - is
' completely invisible: no windows, no popups, unless something goes wrong,
' in which case it's logged to update-log.txt instead of interrupting you.

Const RAW_BASE = "https://raw.githubusercontent.com/Joe-Crooms/guild-roster-addon/main/"
Dim files(1)
files(0) = "GuildRosterLogger.toc"
files(1) = "GuildRosterLogger.lua"

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
configPath = scriptDir & "\wow-addons-path.txt"
logPath = scriptDir & "\update-log.txt"

' Only chatty when launched via cscript (i.e. by hand / during install).
' The scheduled task always launches via wscript, which stays silent -
' WScript.Echo there would pop up an unwanted message box on every logon.
isConsole = (InStr(1, LCase(WScript.FullName), "cscript.exe") > 0)

Sub Log(msg)
    If isConsole Then WScript.Echo msg
    On Error Resume Next
    Set f = fso.OpenTextFile(logPath, 8, True) ' 8 = ForAppending
    f.WriteLine Now & "  " & msg
    f.Close
    On Error Goto 0
End Sub

' --- Figure out the destination folder -------------------------------

wowAddons = ""
If fso.FileExists(configPath) Then
    Set f = fso.OpenTextFile(configPath, 1)
    If Not f.AtEndOfStream Then wowAddons = Trim(f.ReadLine)
    f.Close
End If

If wowAddons = "" Or Not fso.FolderExists(wowAddons) Then
    If Not isConsole Then
        ' Silent scheduled run with no valid config - don't pop a dialog
        ' unexpectedly at logon, just note it and give up quietly.
        Log "No valid WoW AddOns path configured (" & wowAddons & "). Run install-addon-updater.bat again to fix this."
        WScript.Quit 1
    End If

    prompt = "Paste the full path to your WoW AddOns folder." & vbCrLf & vbCrLf & _
             "It's the 'Interface\AddOns' folder inside your WoW install, e.g.:" & vbCrLf & _
             "C:\Games\World of Warcraft 3.3.5a\Interface\AddOns"
    wowAddons = InputBox(prompt, "Guild Roster Logger - Setup")
    wowAddons = Trim(wowAddons)

    If wowAddons = "" Then
        Log "Setup cancelled - no path given."
        WScript.Quit 1
    End If
    If Not fso.FolderExists(wowAddons) Then
        MsgBox "That folder doesn't exist:" & vbCrLf & wowAddons & vbCrLf & vbCrLf & _
               "Run install-addon-updater.bat again once you have the right path.", vbExclamation, "Guild Roster Logger"
        Log "Setup failed - folder does not exist: " & wowAddons
        WScript.Quit 1
    End If

    Set f = fso.CreateTextFile(configPath, True)
    f.WriteLine wowAddons
    f.Close
    Log "Saved WoW AddOns path: " & wowAddons
End If

destDir = wowAddons & "\GuildRosterLogger"
If Not fso.FolderExists(destDir) Then fso.CreateFolder(destDir)

' --- Download + compare each file -------------------------------------

updatedAny = False

For i = 0 To UBound(files)
    fileName = files(i)
    url = RAW_BASE & fileName
    destFile = destDir & "\" & fileName

    On Error Resume Next
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "GET", url, False
    http.SetRequestHeader "Cache-Control", "no-cache"
    http.Send()
    If Err.Number <> 0 Then
        Log "Failed to fetch " & fileName & ": " & Err.Description
        Err.Clear
        On Error Goto 0
    Else
        On Error Goto 0
        If http.Status = 200 Then
            newContent = http.ResponseText

            oldContent = ""
            If fso.FileExists(destFile) Then
                Set f = fso.OpenTextFile(destFile, 1)
                oldContent = f.ReadAll
                f.Close
            End If

            ' Normalize line endings before comparing so a CRLF/LF mismatch
            ' alone doesn't look like a "change" every single run.
            If NormalizeLF(newContent) <> NormalizeLF(oldContent) Then
                Set f = fso.CreateTextFile(destFile, True)
                f.Write newContent
                f.Close
                updatedAny = True
                Log "Updated " & fileName
            End If
        Else
            Log "Failed to fetch " & fileName & ": HTTP " & http.Status
        End If
    End If
Next

If updatedAny Then
    Log "Addon updated. Changes apply next time WoW is reloaded (/reload) or relogged."
End If

Function NormalizeLF(s)
    NormalizeLF = Replace(s, vbCrLf, vbLf)
End Function
