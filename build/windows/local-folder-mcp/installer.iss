#define MyAppName "Local Folder MCP Server"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "Chat AI Tools"
#define MyAppExeName "local-folder-mcp.exe"

[Setup]
AppId={{FE95B4B6-5971-4991-AE48-AA8FFC32BA18}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\ChatAITools\LocalFolderMCP
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=out
OutputBaseFilename=local-folder-mcp-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64

[Files]
Source: "out\local-folder-mcp.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "installer-readme.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Local Folder MCP Server"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--http"; WorkingDir: "{app}"
Name: "{group}\Uninstall Local Folder MCP Server"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--http"; Description: "Start the local folder MCP server"; Flags: postinstall nowait skipifsilent
