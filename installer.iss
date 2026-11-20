; MeshCord — Inno Setup installer script
; Build:  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer.iss
; Produces installer_output\MeshCord-Setup.exe — a real, non-portable
; installer: Program Files install, Start Menu entry, uninstaller, registry.

#define MyAppName      "MeshCord"
#define MyAppVersion   GetFileVersion("build\\bin\\MeshCord.exe")
#if MyAppVersion == ""
  #define MyAppVersion "1.0.0"
#endif
#define MyAppPublisher "MeshCord"
#define MyAppURL       "https://meshcordapp.xyz"
#define MyAppExeName   "MeshCord.exe"

[Setup]
AppId={{B3E1A8F2-7C4D-4E9A-9F1D-2D8C6A5E4B70}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
; Standard per-machine install — requires admin so all users see the app.
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
OutputDir=installer_output
OutputBaseFilename=MeshCord-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
; Icon shown in Apps & Features and the installer wizard.
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoProductName={#MyAppName}
SetupIconFile=
CloseApplications=force
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked
Name: "startmenu";   Description: "Create a &Start Menu shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "build\bin\MeshCord.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}";      Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Per-user app data (%APPDATA%\MeshCord) is intentionally preserved on
; uninstall so reinstalling keeps the user's session-free preferences.
