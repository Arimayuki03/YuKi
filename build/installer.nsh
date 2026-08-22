; installer.nsh — YuKi 自定义 NSIS 安装脚本
;
; 目标：在 Windows 安装过程中提供「安装内置播放器 (mpv)」可选项（默认勾选）。
; 由于 electron-builder 的 extraResources 会无条件把 vendor/ 复制进安装目录，
; 这里的做法是：始终复制，然后在 customInstall 阶段——若用户取消勾选——删除
; 安装目录下的 resources\vendor\mpv 目录。用户可日后在「设置 → 扩展」里一键补装。
;
; 用到的宏钩子（electron-builder 会在存在时自动 !insertmacro 调用）：
;   customPageAfterChangeDir : 在「选择安装目录」页之后插入自定义 nsDialogs 页
;   customInstall            : 安装文件复制完成后执行（据勾选状态删除 mpv）
;   customUnInstall          : 卸载时兜底清理可能残留的 mpv 目录

; nsDialogs / LogicLib：绘制复选框页并读取状态
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; 复选框状态变量（1=安装内置播放器，0=跳过）；默认安装。
Var YukiMpvCheckbox
Var YukiInstallMpv

; ---------------------------------------------------------------- 自定义页面
; electron-builder 的 assisted 安装器（oneClick:false）在 allowToChangeInstallationDirectory
; 为 true 时会有目录选择页，本宏把自定义页插在其后。
!macro customPageAfterChangeDir
  Page custom yukiMpvPageCreate yukiMpvPageLeave
!macroend

Function yukiMpvPageCreate
  ; 默认勾选（首次进入页面时初始化为安装）
  ${If} $YukiInstallMpv == ""
    StrCpy $YukiInstallMpv "1"
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "选择要一并安装的可选组件。内置播放器（mpv）用于视频播放；若你已在系统中安装 mpv，或希望日后再装，可取消勾选。"
  Pop $0

  ${NSD_CreateCheckbox} 0 40u 100% 12u "安装内置播放器 (mpv)"
  Pop $YukiMpvCheckbox
  ; 依据当前状态回填勾选框
  ${If} $YukiInstallMpv == "1"
    ${NSD_Check} $YukiMpvCheckbox
  ${EndIf}

  ${NSD_CreateLabel} 0 60u 100% 24u "提示：取消勾选后仍可在应用内「设置 → 扩展」点击「下载内置播放器」一键补装，或指定本机已安装的 mpv.exe 路径。"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function yukiMpvPageLeave
  ; 读取复选框状态存入变量，供 customInstall 判定
  ${NSD_GetState} $YukiMpvCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $YukiInstallMpv "1"
  ${Else}
    StrCpy $YukiInstallMpv "0"
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- 安装钩子
; extraResources 已把 vendor/ 复制到 $INSTDIR\resources\vendor；
; 用户未勾选内置播放器时，删除其中的 mpv 子目录（其余组件保留）。
!macro customInstall
  ${If} $YukiInstallMpv == "0"
    DetailPrint "跳过内置播放器：正在移除 mpv..."
    RMDir /r "$INSTDIR\resources\vendor\mpv"
  ${Else}
    DetailPrint "已包含内置播放器 (mpv)。"
  ${EndIf}
!macroend

; ---------------------------------------------------------------- 卸载钩子
; 兜底清理：应用内一键补装的 mpv 存放在 userData（非 $INSTDIR），这里仅清理
; 安装目录内可能残留的 mpv 目录，避免卸载后残留文件。
!macro customUnInstall
  RMDir /r "$INSTDIR\resources\vendor\mpv"
!macroend
