Unicode true

!include "MUI2.nsh"
!include "x64.nsh"

!define APP_NAME "Browser MCP Server"
!define APP_VERSION "0.1.0"
!define APP_EXE "browser-mcp.exe"
!define APP_PUBLISHER "Chat AI Tools"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\BrowserMCP"

VIProductVersion "0.1.0.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "Browser MCP Server installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "${APP_PUBLISHER}"

Name "${APP_NAME}"
OutFile "browser-mcp-setup.exe"
InstallDir "$LOCALAPPDATA\ChatAITools\BrowserMCP"
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

Section "Browser MCP Server" SEC_MAIN
  SetShellVarContext current
  SetOutPath "$INSTDIR"

  File "browser-mcp.exe"
  File "installer-readme.txt"

  CreateDirectory "$SMPROGRAMS\Browser MCP Server"
  CreateShortCut "$SMPROGRAMS\Browser MCP Server\Start Browser MCP Server.lnk" \
    "$INSTDIR\${APP_EXE}" "--http" "$INSTDIR\${APP_EXE}" 0 SW_SHOWNORMAL
  CreateShortCut "$SMPROGRAMS\Browser MCP Server\Uninstall Browser MCP Server.lnk" \
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

  Delete "$SMPROGRAMS\Browser MCP Server\Start Browser MCP Server.lnk"
  Delete "$SMPROGRAMS\Browser MCP Server\Uninstall Browser MCP Server.lnk"
  RMDir "$SMPROGRAMS\Browser MCP Server"

  Delete "$INSTDIR\browser-mcp.exe"
  Delete "$INSTDIR\installer-readme.txt"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
