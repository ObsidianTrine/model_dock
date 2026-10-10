; ModelDock Windows 安装向导（Inno Setup 6）
; AppVersion 由 CI 传入：ISCC /DAppVersion=x.y.z scripts/installer.iss
; 相对路径以本 .iss 所在目录（scripts/）为基准解析，产物实际在仓库根 release/，故用 ..\ 前缀。
; 用户级安装（不需要管理员权限）：默认 %LOCALAPPDATA%\Programs\ModelDock，可自选路径；
; 写入用户 PATH、开始菜单/桌面快捷方式；卸载时先跑 modeldock uninstall --yes --purge 还原客户端并彻底清理（含配置与密钥）。
; 界面语言跟随系统显示语言：中文 Windows 显示简体中文，其余回退英文。
; 简体中文包内置在 scripts/inno/lang/（Inno 默认发行不含中文）；来源为 Inno Setup 官方仓库
; issrc 的 Files/Languages/ChineseSimplified.isl（目标 Inno 6.5.0+，维护者 Kira），
; 升级 Inno 或需更新译文时从官方仓库同步覆盖该文件。

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{7E11C1BA-8F6E-4B44-9A0C-3F5B30D6B001}
AppName=ModelDock
AppVersion={#AppVersion}
AppPublisher=ModelDock
DefaultDirName={localappdata}\Programs\ModelDock
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
OutputDir=..\release
OutputBaseFilename=modeldock-{#AppVersion}-win32-x64-setup
SetupIconFile=..\release\modeldock.ico
UninstallDisplayIcon={app}\modeldock.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
; 不弹语言选择框：按系统 UI 语言自动选择（中文系统 → 简体中文；无匹配 → [Languages] 第一项英文）
ShowLanguageDialog=no

[Languages]
Name: "english";           MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "inno\lang\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\release\modeldock-win32-x64.exe"; DestDir: "{app}"; DestName: "modeldock.exe"; Flags: ignoreversion
; 右下角托盘（csc 编译产物；构建侧编译失败时不存在该文件，跳过不报错）
Source: "..\release\ModelDockTray.exe"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist

[Icons]
; 快捷方式指向托盘程序（GUI 子系统，无黑窗）：双击 = 确保网关拉起 + 弹控制台 + 常驻托盘
Name: "{autoprograms}\ModelDock"; Filename: "{app}\ModelDockTray.exe"
Name: "{autodesktop}\ModelDock"; Filename: "{app}\ModelDockTray.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\ModelDockTray.exe"; Description: "{cm:LaunchProgram,ModelDock}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\modeldock.exe"; Parameters: "uninstall --yes --purge"; RunOnceId: "ModelDockUninstall"; Flags: runhidden

[Code]
const
  WM_SETTINGCHANGE = $001A;
  HWND_BROADCAST_WIN = $FFFF;  // Inno 6.4+ 预定义了 HWND_BROADCAST，此处换名避免冲突
  SMTO_ABORTIFHUNG = $0002;

// Inno 不预定义 SendMessageTimeout，显式从 user32 声明；换名避免与未来内置版本冲突。
// Unicode Inno 中 string 参数按 PWideChar 传入， lParam 直接声明为 string。
function SendMessageTimeoutW(hWnd: DWORD; Msg: DWORD; wParam: DWORD; lParam: string; fuFlags: DWORD; uTimeout: DWORD; var lpdwResult: DWORD): DWORD;
  external 'SendMessageTimeoutW@user32.dll stdcall';

procedure BroadcastEnvChange();
var
  Dummy: DWord;
begin
  SendMessageTimeoutW(HWND_BROADCAST_WIN, WM_SETTINGCHANGE, 0, 'Environment', SMTO_ABORTIFHUNG, 5000, Dummy);
end;

function GetUserPath(): String;
var
  Path: String;
begin
  if RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Path) then
    Result := Path
  else
    Result := '';
end;

procedure SetUserPath(Value: String);
begin
  if Value <> '' then
    RegWriteStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Value);
  BroadcastEnvChange();
end;

// 安装完成：把安装目录追加进用户 PATH（已存在则不动）
procedure CurStepChanged(CurStep: TSetupStep);
var
  Path, AppDir: String;
begin
  if CurStep <> ssPostInstall then Exit;
  AppDir := ExpandConstant('{app}');
  Path := GetUserPath();
  if Pos(';' + Uppercase(AppDir) + ';', ';' + Uppercase(Path) + ';') > 0 then Exit;
  if Path <> '' then
    Path := Path + ';' + AppDir
  else
    Path := AppDir;
  SetUserPath(Path);
end;

// 卸载：从用户 PATH 里摘掉安装目录（modeldock uninstall --yes --purge 已在 UninstallRun 还原客户端并彻底清理配置）
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Path, NewPath, Part, AppDir: String;
  I, Start: Integer;
begin
  if CurUninstallStep <> usUninstall then Exit;
  AppDir := ExpandConstant('{app}');
  Path := GetUserPath();
  if Path = '' then Exit;
  NewPath := '';
  Start := 1;
  for I := 1 to Length(Path) + 1 do
  begin
    if (I > Length(Path)) or (Path[I] = ';') then
    begin
      Part := Copy(Path, Start, I - Start);
      if (Part <> '') and (Uppercase(Part) <> Uppercase(AppDir)) then
      begin
        if NewPath = '' then
          NewPath := Part
        else
          NewPath := NewPath + ';' + Part;
      end;
      Start := I + 1;
    end;
  end;
  if NewPath <> Path then
    SetUserPath(NewPath);
end;
