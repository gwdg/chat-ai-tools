Unicode true

!include "MUI2.nsh"
!include "x64.nsh"

!define APP_NAME "Chromium MCP Browser Control"
!define APP_VERSION "0.1.0"
!define APP_EXE "chromium-mcp.exe"
!define APP_PUBLISHER "Chat AI Tools"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChromiumMCP"

VIProductVersion "0.1.0.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "Chromium MCP relay installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "${APP_PUBLISHER}"

Name "${APP_NAME}"
OutFile "chromium-mcp-setup.exe"
InstallDir "$LOCALAPPDATA\ChatAITools\ChromiumMCP"
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

Section "Chromium MCP Relay" SEC_MAIN
  SetShellVarContext current
  SetOutPath "$INSTDIR"

  File "chromium-mcp.exe"
  File "installer-readme.txt"
  SetOutPath "$INSTDIR\extension"
  File /r "extension\*.*"
  SetOutPath "$INSTDIR"

  CreateDirectory "$SMPROGRAMS\Chromium MCP Browser Control"
  CreateShortCut "$SMPROGRAMS\Chromium MCP Browser Control\Start Chromium MCP Relay.lnk" \
    "$INSTDIR\${APP_EXE}" "--http" "$INSTDIR\${APP_EXE}" 0 SW_SHOWNORMAL
  CreateShortCut "$SMPROGRAMS\Chromium MCP Browser Control\Browser Extension Folder.lnk" \
    "$INSTDIR\extension" "" "$INSTDIR\extension" 0 SW_SHOWNORMAL
  CreateShortCut "$SMPROGRAMS\Chromium MCP Browser Control\Uninstall.lnk" \
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

  Delete "$SMPROGRAMS\Chromium MCP Browser Control\Start Chromium MCP Relay.lnk"
  Delete "$SMPROGRAMS\Chromium MCP Browser Control\Browser Extension Folder.lnk"
  Delete "$SMPROGRAMS\Chromium MCP Browser Control\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Chromium MCP Browser Control"

  Delete "$INSTDIR\chromium-mcp.exe"
  Delete "$INSTDIR\installer-readme.txt"
  RMDir /r "$INSTDIR\extension"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
