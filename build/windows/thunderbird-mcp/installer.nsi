Unicode true

!include "MUI2.nsh"
!include "x64.nsh"

!define APP_NAME "Thunderbird MCP Server"
!define APP_VERSION "1.0.0"
!define APP_EXE "thunderbird-mcp.exe"
!define APP_PUBLISHER "Chat AI Tools"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ThunderbirdMCP"

VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "Thunderbird MCP Server installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "${APP_PUBLISHER}"

Name "${APP_NAME}"
OutFile "thunderbird-mcp-setup.exe"
InstallDir "$LOCALAPPDATA\ChatAITools\ThunderbirdMCP"
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

Section "Thunderbird MCP Server" SEC_MAIN
  SetShellVarContext current
  SetOutPath "$INSTDIR"

  File "thunderbird-mcp.exe"
  File "thunderbird-mcp-extension.xpi"
  File "start-thunderbird-mcp.cmd"
  File "installer-readme.txt"
  SetOutPath "$INSTDIR\extension"
  File /r "extension\*.*"
  SetOutPath "$INSTDIR"

  CreateDirectory "$SMPROGRAMS\Thunderbird MCP Server"
  CreateShortCut "$SMPROGRAMS\Thunderbird MCP Server\Start Thunderbird MCP Server.lnk" \
    "$INSTDIR\start-thunderbird-mcp.cmd" "" "$INSTDIR\${APP_EXE}" 0 SW_SHOWNORMAL
  CreateShortCut "$SMPROGRAMS\Thunderbird MCP Server\Thunderbird Extension Folder.lnk" \
    "$INSTDIR\extension" "" "$INSTDIR\extension" 0 SW_SHOWNORMAL
  CreateShortCut "$SMPROGRAMS\Thunderbird MCP Server\Uninstall Thunderbird MCP Server.lnk" \
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

  Delete "$SMPROGRAMS\Thunderbird MCP Server\Start Thunderbird MCP Server.lnk"
  Delete "$SMPROGRAMS\Thunderbird MCP Server\Thunderbird Extension Folder.lnk"
  Delete "$SMPROGRAMS\Thunderbird MCP Server\Uninstall Thunderbird MCP Server.lnk"
  RMDir "$SMPROGRAMS\Thunderbird MCP Server"

  Delete "$INSTDIR\token.txt"
  Delete "$INSTDIR\thunderbird-mcp.exe"
  Delete "$INSTDIR\thunderbird-mcp-extension.xpi"
  Delete "$INSTDIR\start-thunderbird-mcp.cmd"
  Delete "$INSTDIR\installer-readme.txt"
  RMDir /r "$INSTDIR\extension"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
