Unicode true

!include "MUI2.nsh"
!include "x64.nsh"

!define APP_NAME "Calendar MCP Server"
!define APP_VERSION "0.1.0"
!define APP_EXE "calendar-mcp.exe"
!define APP_PUBLISHER "Chat AI Tools"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\CalendarMCP"

VIProductVersion "0.1.0.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "CalDAV Calendar MCP Server installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "${APP_PUBLISHER}"

Name "${APP_NAME}"
OutFile "calendar-mcp-setup.exe"
InstallDir "$LOCALAPPDATA\ChatAITools\CalendarMCP"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
XPStyle on
ManifestDPIAware true
BrandingText "Chat AI Tools"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "This installer requires 64-bit Windows."
    Abort
  ${EndIf}
FunctionEnd

Section "Calendar MCP Server" SEC_MAIN
  SetShellVarContext current
  SetOutPath "$INSTDIR"

  File "calendar-mcp.exe"
  File "calendar.json.example"
  File "start-calendar-mcp.cmd"
  File "installer-readme.txt"

  CreateDirectory "$SMPROGRAMS\Calendar MCP Server"
  CreateShortCut "$SMPROGRAMS\Calendar MCP Server\Start Calendar MCP Server.lnk" \
    "$INSTDIR\start-calendar-mcp.cmd" "" "$INSTDIR\${APP_EXE}" 0 SW_SHOWNORMAL
  CreateShortCut "$SMPROGRAMS\Calendar MCP Server\Calendar Config Folder.lnk" \
    "$INSTDIR" "" "$INSTDIR" 0 SW_SHOWNORMAL
  CreateShortCut "$SMPROGRAMS\Calendar MCP Server\Uninstall Calendar MCP Server.lnk" \
    "$INSTDIR\uninstall.exe"

  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current

  Delete "$SMPROGRAMS\Calendar MCP Server\Start Calendar MCP Server.lnk"
  Delete "$SMPROGRAMS\Calendar MCP Server\Calendar Config Folder.lnk"
  Delete "$SMPROGRAMS\Calendar MCP Server\Uninstall Calendar MCP Server.lnk"
  RMDir "$SMPROGRAMS\Calendar MCP Server"

  Delete "$INSTDIR\calendar-mcp.exe"
  Delete "$INSTDIR\calendar.json.example"
  Delete "$INSTDIR\calendar.json"
  Delete "$INSTDIR\start-calendar-mcp.cmd"
  Delete "$INSTDIR\installer-readme.txt"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
