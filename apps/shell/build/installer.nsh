; Keeps the genoffice command line (resources\cli, holding genoffice.cmd and the
; extension-less genoffice for Git Bash) on the installing user's PATH for the
; lifetime of the install. The value is read and written unexpanded
; (REG_EXPAND_SZ) so entries such as %USERPROFILE%\bin survive, and Explorer
; is told about the change so terminals opened afterwards see it.
; electron-builder compiles the script twice (the second pass, with
; BUILD_UNINSTALLER, only produces the uninstaller); an unreferenced function
; in either pass is a warning makensis treats as an error, hence the guards.
!include "WinMessages.nsh"
!include "StrFunc.nsh"
!include "nsProcess.nsh"

!macro GenOfficeKillHelper NAME
  ${nsProcess::FindProcess} "${NAME}" $R0
  ${if} $R0 == 0
    ${nsProcess::KillProcess} "${NAME}" $R0
    Sleep 300
  ${endIf}
!macroend

; electron-builder's stock CHECK_APP_RUNNING runs powershell.exe via nsExec
; (CREATE_NEW_CONSOLE + SW_HIDE); Windows Terminal as default host ignores
; SW_HIDE, so every silent update flashed a PowerShell window. nsProcess does
; the same work in-process. Used by both the installer and the uninstaller.
!macro customCheckAppRunning
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    ${if} ${isUpdated}
      ; let the app finish quitting on its own
      Sleep 1000
      Goto genofficeStopApp
    ${endIf}
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK genofficeStopApp
    Quit

    genofficeStopApp:
    DetailPrint "$(appClosing)"
    ${nsProcess::CloseProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    Sleep 300
    StrCpy $R1 0

    genofficeWaitLoop:
      IntOp $R1 $R1 + 1
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        Sleep 1000
        ${nsProcess::KillProcess} "${APP_EXECUTABLE_FILENAME}" $R0
        ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 == 0
          DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
          Sleep 2000
        ${else}
          Goto genofficeAppClosed
        ${endIf}
      ${else}
        Goto genofficeAppClosed
      ${endIf}
      ${if} $R1 > 1
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY genofficeWaitLoop
        Quit
      ${else}
        Goto genofficeWaitLoop
      ${endIf}
    genofficeAppClosed:
  ${endIf}
  ; the stock macro closed every process under $INSTDIR; a killed app can
  ; orphan its helpers, which keep their binaries locked
  !insertmacro GenOfficeKillHelper "xlsx-sidecar.exe"
  !insertmacro GenOfficeKillHelper "win-ocr.exe"
  ${nsProcess::Unload}
!macroend

!define GENOFFICE_PATH_MAX 7900

; Scope templates to our ProgIDs (electron-builder uses fileAssociations.name).
; A shared .ext\ShellNew would overwrite Office/WPS templates. OOXML files
; must be copied from valid packages, never created with NullFile.
!macro GenOfficeRegisterShellNew EXT PROGID
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}\ShellNew" "FileName" "$INSTDIR\resources\shell-new\blank.${EXT}"
!macroend

!macro GenOfficeUnregisterShellNew EXT PROGID
  ; Only remove our own registration, including when uninstalling for an update.
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}\ShellNew" "FileName"
  ${If} $0 == "$INSTDIR\resources\shell-new\blank.${EXT}"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}\ShellNew"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}"
  ${EndIf}
!macroend

; "用 GenOffice 打开" — an explicit verb on the file's classic context menu,
; registered under SystemFileAssociations so it never touches the user's
; default program: it only adds a choice. The label is fixed at install time;
; 2052 is zh-CN, everything else gets English.
!macro GenOfficeRegisterOpenVerb EXT
  StrCmp $LANGUAGE 2052 0 +3
    StrCpy $0 "用 GenOffice 打开"
    Goto +2
  StrCpy $0 "Open with GenOffice"
  WriteRegStr SHELL_CONTEXT "Software\Classes\SystemFileAssociations\.${EXT}\shell\GenOffice" "" $0
  WriteRegStr SHELL_CONTEXT "Software\Classes\SystemFileAssociations\.${EXT}\shell\GenOffice" "Icon" "$INSTDIR\GenOffice.exe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\SystemFileAssociations\.${EXT}\shell\GenOffice\command" "" '"$INSTDIR\GenOffice.exe" "%1"'
!macroend

!macro GenOfficeUnregisterOpenVerb EXT
  ; we only ever wrote this verb ourselves — nothing to preserve
  DeleteRegKey SHELL_CONTEXT "Software\Classes\SystemFileAssociations\.${EXT}\shell\GenOffice"
!macroend

!macro GenOfficeRegisterOpenVerbs
  !insertmacro GenOfficeRegisterOpenVerb "docx"
  !insertmacro GenOfficeRegisterOpenVerb "xlsx"
  !insertmacro GenOfficeRegisterOpenVerb "xlsm"
  !insertmacro GenOfficeRegisterOpenVerb "pptx"
  !insertmacro GenOfficeRegisterOpenVerb "xls"
  !insertmacro GenOfficeRegisterOpenVerb "csv"
  !insertmacro GenOfficeRegisterOpenVerb "tsv"
  !insertmacro GenOfficeRegisterOpenVerb "ods"
  !insertmacro GenOfficeRegisterOpenVerb "ots"
  !insertmacro GenOfficeRegisterOpenVerb "odt"
  !insertmacro GenOfficeRegisterOpenVerb "ott"
  !insertmacro GenOfficeRegisterOpenVerb "odp"
  !insertmacro GenOfficeRegisterOpenVerb "otp"
  !insertmacro GenOfficeRegisterOpenVerb "pdf"
  !insertmacro GenOfficeRegisterOpenVerb "md"
  !insertmacro GenOfficeRegisterOpenVerb "markdown"
  !insertmacro GenOfficeRegisterOpenVerb "txt"
  !insertmacro GenOfficeRegisterOpenVerb "json"
  !insertmacro GenOfficeRegisterOpenVerb "log"
  !insertmacro GenOfficeRegisterOpenVerb "yaml"
  !insertmacro GenOfficeRegisterOpenVerb "yml"
  !insertmacro GenOfficeRegisterOpenVerb "xml"
  !insertmacro GenOfficeRegisterOpenVerb "ini"
  !insertmacro GenOfficeRegisterOpenVerb "toml"
  !insertmacro GenOfficeRegisterOpenVerb "py"
  !insertmacro GenOfficeRegisterOpenVerb "ts"
  !insertmacro GenOfficeRegisterOpenVerb "tsx"
  !insertmacro GenOfficeRegisterOpenVerb "js"
  !insertmacro GenOfficeRegisterOpenVerb "jsx"
  !insertmacro GenOfficeRegisterOpenVerb "css"
  !insertmacro GenOfficeRegisterOpenVerb "sql"
  !insertmacro GenOfficeRegisterOpenVerb "sh"
  !insertmacro GenOfficeRegisterOpenVerb "bat"
  !insertmacro GenOfficeRegisterOpenVerb "html"
  !insertmacro GenOfficeRegisterOpenVerb "htm"
  !insertmacro GenOfficeRegisterOpenVerb "png"
  !insertmacro GenOfficeRegisterOpenVerb "jpg"
  !insertmacro GenOfficeRegisterOpenVerb "jpeg"
  !insertmacro GenOfficeRegisterOpenVerb "webp"
  !insertmacro GenOfficeRegisterOpenVerb "gif"
  !insertmacro GenOfficeRegisterOpenVerb "svg"
  !insertmacro GenOfficeRegisterOpenVerb "bmp"
  !insertmacro GenOfficeRegisterOpenVerb "ico"
  !insertmacro GenOfficeRegisterOpenVerb "avif"
  !insertmacro GenOfficeRegisterOpenVerb "mp3"
  !insertmacro GenOfficeRegisterOpenVerb "wav"
  !insertmacro GenOfficeRegisterOpenVerb "m4a"
  !insertmacro GenOfficeRegisterOpenVerb "aac"
  !insertmacro GenOfficeRegisterOpenVerb "ogg"
  !insertmacro GenOfficeRegisterOpenVerb "flac"
  !insertmacro GenOfficeRegisterOpenVerb "opus"
  !insertmacro GenOfficeRegisterOpenVerb "mp4"
  !insertmacro GenOfficeRegisterOpenVerb "webm"
  !insertmacro GenOfficeRegisterOpenVerb "mov"
  !insertmacro GenOfficeRegisterOpenVerb "m4v"
  !insertmacro GenOfficeRegisterOpenVerb "mkv"
!macroend

!macro GenOfficeUnregisterOpenVerbs
  !insertmacro GenOfficeUnregisterOpenVerb "docx"
  !insertmacro GenOfficeUnregisterOpenVerb "xlsx"
  !insertmacro GenOfficeUnregisterOpenVerb "xlsm"
  !insertmacro GenOfficeUnregisterOpenVerb "pptx"
  !insertmacro GenOfficeUnregisterOpenVerb "xls"
  !insertmacro GenOfficeUnregisterOpenVerb "csv"
  !insertmacro GenOfficeUnregisterOpenVerb "tsv"
  !insertmacro GenOfficeUnregisterOpenVerb "ods"
  !insertmacro GenOfficeUnregisterOpenVerb "ots"
  !insertmacro GenOfficeUnregisterOpenVerb "odt"
  !insertmacro GenOfficeUnregisterOpenVerb "ott"
  !insertmacro GenOfficeUnregisterOpenVerb "odp"
  !insertmacro GenOfficeUnregisterOpenVerb "otp"
  !insertmacro GenOfficeUnregisterOpenVerb "pdf"
  !insertmacro GenOfficeUnregisterOpenVerb "md"
  !insertmacro GenOfficeUnregisterOpenVerb "markdown"
  !insertmacro GenOfficeUnregisterOpenVerb "txt"
  !insertmacro GenOfficeUnregisterOpenVerb "json"
  !insertmacro GenOfficeUnregisterOpenVerb "log"
  !insertmacro GenOfficeUnregisterOpenVerb "yaml"
  !insertmacro GenOfficeUnregisterOpenVerb "yml"
  !insertmacro GenOfficeUnregisterOpenVerb "xml"
  !insertmacro GenOfficeUnregisterOpenVerb "ini"
  !insertmacro GenOfficeUnregisterOpenVerb "toml"
  !insertmacro GenOfficeUnregisterOpenVerb "py"
  !insertmacro GenOfficeUnregisterOpenVerb "ts"
  !insertmacro GenOfficeUnregisterOpenVerb "tsx"
  !insertmacro GenOfficeUnregisterOpenVerb "js"
  !insertmacro GenOfficeUnregisterOpenVerb "jsx"
  !insertmacro GenOfficeUnregisterOpenVerb "css"
  !insertmacro GenOfficeUnregisterOpenVerb "sql"
  !insertmacro GenOfficeUnregisterOpenVerb "sh"
  !insertmacro GenOfficeUnregisterOpenVerb "bat"
  !insertmacro GenOfficeUnregisterOpenVerb "html"
  !insertmacro GenOfficeUnregisterOpenVerb "htm"
  !insertmacro GenOfficeUnregisterOpenVerb "png"
  !insertmacro GenOfficeUnregisterOpenVerb "jpg"
  !insertmacro GenOfficeUnregisterOpenVerb "jpeg"
  !insertmacro GenOfficeUnregisterOpenVerb "webp"
  !insertmacro GenOfficeUnregisterOpenVerb "gif"
  !insertmacro GenOfficeUnregisterOpenVerb "svg"
  !insertmacro GenOfficeUnregisterOpenVerb "bmp"
  !insertmacro GenOfficeUnregisterOpenVerb "ico"
  !insertmacro GenOfficeUnregisterOpenVerb "avif"
  !insertmacro GenOfficeUnregisterOpenVerb "mp3"
  !insertmacro GenOfficeUnregisterOpenVerb "wav"
  !insertmacro GenOfficeUnregisterOpenVerb "m4a"
  !insertmacro GenOfficeUnregisterOpenVerb "aac"
  !insertmacro GenOfficeUnregisterOpenVerb "ogg"
  !insertmacro GenOfficeUnregisterOpenVerb "flac"
  !insertmacro GenOfficeUnregisterOpenVerb "opus"
  !insertmacro GenOfficeUnregisterOpenVerb "mp4"
  !insertmacro GenOfficeUnregisterOpenVerb "webm"
  !insertmacro GenOfficeUnregisterOpenVerb "mov"
  !insertmacro GenOfficeUnregisterOpenVerb "m4v"
  !insertmacro GenOfficeUnregisterOpenVerb "mkv"
!macroend

; Windows 10/11 Default Programs registration so all supported file types appear
; together under Windows Settings -> Default Apps -> GenOffice.
!macro GenOfficeRegisterCapability EXT PROGID
  WriteRegStr SHELL_CONTEXT "Software\GenOffice\Capabilities\FileAssociations" ".${EXT}" "${PROGID}"
!macroend

!macro GenOfficeRegisterCapabilities
  WriteRegStr SHELL_CONTEXT "Software\GenOffice\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\GenOffice\Capabilities" "ApplicationDescription" "GenOffice AI-native office suite, document editor, and media player"
  WriteRegStr SHELL_CONTEXT "Software\GenOffice\Capabilities" "ApplicationIcon" "$INSTDIR\GenOffice.exe,0"
  WriteRegStr SHELL_CONTEXT "Software\GenOffice\Capabilities\URLAssociations" "genoffice" "genoffice"
  !insertmacro GenOfficeRegisterCapability "docx" "Word Document"
  !insertmacro GenOfficeRegisterCapability "xlsx" "Excel Workbook"
  !insertmacro GenOfficeRegisterCapability "xlsm" "Excel Macro-Enabled Workbook"
  !insertmacro GenOfficeRegisterCapability "pptx" "PowerPoint Presentation"
  !insertmacro GenOfficeRegisterCapability "xls" "Excel 97-2003 Workbook"
  !insertmacro GenOfficeRegisterCapability "csv" "CSV Document"
  !insertmacro GenOfficeRegisterCapability "tsv" "TSV Document"
  !insertmacro GenOfficeRegisterCapability "ods" "OpenDocument Spreadsheet"
  !insertmacro GenOfficeRegisterCapability "ots" "OpenDocument Spreadsheet Template"
  !insertmacro GenOfficeRegisterCapability "odt" "OpenDocument Text"
  !insertmacro GenOfficeRegisterCapability "ott" "OpenDocument Text Template"
  !insertmacro GenOfficeRegisterCapability "odp" "OpenDocument Presentation"
  !insertmacro GenOfficeRegisterCapability "otp" "OpenDocument Presentation Template"
  !insertmacro GenOfficeRegisterCapability "pdf" "PDF Document"
  !insertmacro GenOfficeRegisterCapability "md" "Markdown Document"
  !insertmacro GenOfficeRegisterCapability "markdown" "Markdown Document"
  !insertmacro GenOfficeRegisterCapability "txt" "Text Document"
  !insertmacro GenOfficeRegisterCapability "json" "JSON Document"
  !insertmacro GenOfficeRegisterCapability "log" "Log File"
  !insertmacro GenOfficeRegisterCapability "yaml" "YAML Document"
  !insertmacro GenOfficeRegisterCapability "yml" "YAML Document"
  !insertmacro GenOfficeRegisterCapability "xml" "XML Document"
  !insertmacro GenOfficeRegisterCapability "ini" "INI Configuration"
  !insertmacro GenOfficeRegisterCapability "toml" "TOML Document"
  !insertmacro GenOfficeRegisterCapability "py" "Python Script"
  !insertmacro GenOfficeRegisterCapability "ts" "TypeScript File"
  !insertmacro GenOfficeRegisterCapability "tsx" "TypeScript JSX File"
  !insertmacro GenOfficeRegisterCapability "js" "JavaScript File"
  !insertmacro GenOfficeRegisterCapability "jsx" "JavaScript JSX File"
  !insertmacro GenOfficeRegisterCapability "css" "CSS Stylesheet"
  !insertmacro GenOfficeRegisterCapability "sql" "SQL Script"
  !insertmacro GenOfficeRegisterCapability "sh" "Shell Script"
  !insertmacro GenOfficeRegisterCapability "html" "HTML Document"
  !insertmacro GenOfficeRegisterCapability "htm" "HTML Document"
  !insertmacro GenOfficeRegisterCapability "png" "PNG Image"
  !insertmacro GenOfficeRegisterCapability "jpg" "JPEG Image"
  !insertmacro GenOfficeRegisterCapability "jpeg" "JPEG Image"
  !insertmacro GenOfficeRegisterCapability "webp" "WebP Image"
  !insertmacro GenOfficeRegisterCapability "gif" "GIF Image"
  !insertmacro GenOfficeRegisterCapability "svg" "SVG Vector Image"
  !insertmacro GenOfficeRegisterCapability "bmp" "Bitmap Image"
  !insertmacro GenOfficeRegisterCapability "ico" "Icon File"
  !insertmacro GenOfficeRegisterCapability "avif" "AVIF Image"
  !insertmacro GenOfficeRegisterCapability "mp3" "MP3 Audio"
  !insertmacro GenOfficeRegisterCapability "wav" "WAV Audio"
  !insertmacro GenOfficeRegisterCapability "m4a" "MPEG-4 Audio"
  !insertmacro GenOfficeRegisterCapability "aac" "AAC Audio"
  !insertmacro GenOfficeRegisterCapability "ogg" "Ogg Audio"
  !insertmacro GenOfficeRegisterCapability "flac" "FLAC Audio"
  !insertmacro GenOfficeRegisterCapability "opus" "Opus Audio"
  !insertmacro GenOfficeRegisterCapability "mp4" "MP4 Video"
  !insertmacro GenOfficeRegisterCapability "webm" "WebM Video"
  !insertmacro GenOfficeRegisterCapability "mov" "QuickTime Video"
  !insertmacro GenOfficeRegisterCapability "m4v" "M4V Video"
  !insertmacro GenOfficeRegisterCapability "mkv" "Matroska Video"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "GenOffice" "Software\GenOffice\Capabilities"
!macroend

!macro GenOfficeUnregisterCapabilities
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "GenOffice"
  DeleteRegKey SHELL_CONTEXT "Software\GenOffice\Capabilities"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\GenOffice"
!macroend

!macro customInstall
  Push "$INSTDIR\resources\cli"
  Call GenOfficeAddToUserPath
  !insertmacro GenOfficeRegisterShellNew "docx" "Word Document"
  !insertmacro GenOfficeRegisterShellNew "xlsx" "Excel Workbook"
  !insertmacro GenOfficeRegisterShellNew "pptx" "PowerPoint Presentation"
  !insertmacro GenOfficeRegisterOpenVerbs
  !insertmacro GenOfficeRegisterCapabilities
  !insertmacro UPDATEFILEASSOC
!macroend

!macro customUnInstall
  Push "$INSTDIR\resources\cli"
  Call un.GenOfficeRemoveFromUserPath
  Push $0
  !insertmacro GenOfficeUnregisterShellNew "docx" "Word Document"
  !insertmacro GenOfficeUnregisterShellNew "xlsx" "Excel Workbook"
  !insertmacro GenOfficeUnregisterShellNew "pptx" "PowerPoint Presentation"
  Pop $0
  !insertmacro GenOfficeUnregisterOpenVerbs
  !insertmacro GenOfficeUnregisterCapabilities
  !insertmacro UPDATEFILEASSOC
!macroend

!ifndef BUILD_UNINSTALLER
${StrStr}

Function GenOfficeAddToUserPath
  Exch $0 ; directory
  Push $1
  Push $2
  Push $3
  ReadRegStr $1 HKCU "Environment" "Path"
  StrLen $2 $1
  ; leave an already oversized PATH alone rather than truncate it
  IntCmp $2 ${GENOFFICE_PATH_MAX} done 0 done
  ${StrStr} $3 ";$1;" ";$0;"
  StrCmp $3 "" 0 done
  StrCmp $1 "" 0 +3
    StrCpy $1 "$0"
    Goto write
  StrCpy $1 "$1;$0"
write:
  WriteRegExpandStr HKCU "Environment" "Path" $1
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif

!ifdef BUILD_UNINSTALLER
${UnStrStr}
${UnStrRep}

Function un.GenOfficeRemoveFromUserPath
  Exch $0 ; directory
  Push $1
  Push $2
  ReadRegStr $1 HKCU "Environment" "Path"
  StrCmp $1 "" done
  ${UnStrStr} $2 ";$1;" ";$0;"
  StrCmp $2 "" done
  StrCpy $1 ";$1;"
  ${UnStrRep} $1 $1 ";$0;" ";"
  ; strip the sentinels added above
  StrCpy $1 $1 -1
  StrCpy $1 $1 "" 1
  WriteRegExpandStr HKCU "Environment" "Path" $1
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif
