/**
 * Publish failure codes → user-readable messages (no secrets).
 */
export const PUBLISH_ERROR_MESSAGES: Record<string, string> = {
  QUOTA_EXCEEDED: 'YouTube 配额已用尽，请明日再试或申请提额。',
  AUTH_REQUIRED: '需要重新授权该平台。',
  '2190005': '抖音：文件过大（上限 128MB），请压缩后再试。',
  '2114006': '抖音：视频时长超过 15 分钟。',
  DOUYIN_PERSONAL_UNSUPPORTED: '抖音开放平台仅支持企业/机构主体网站应用，个人主体不可用。',
  XHS_MANUAL_ONLY: '小红书无公开发布 API，请下载导出包后人工上传。',
  STEAM_STEAMCMD_MISSING: '未找到 steamcmd，请先在终端执行 steamcmd +login，或改用 WE 编辑器导入 local 包。',
  TELEGRAM_TOO_LARGE: 'Telegram 视频超过 50MB，请先压缩。',
  DISCORD_TOO_LARGE: 'Discord Webhook 附件超过 25MB。',
  WE_PREVIEW_TOO_LARGE: 'Wallpaper Engine 预览图不能超过 1MB。',
  LOGIN_METHOD_DEPRECATED: '账号密码登录已弃用，请使用浏览器授权或粘贴 refresh_token。',
};

export function humanizePublishError(codeOrMessage: string): string {
  if (!codeOrMessage) return '发布失败';
  if (PUBLISH_ERROR_MESSAGES[codeOrMessage]) return PUBLISH_ERROR_MESSAGES[codeOrMessage];
  for (const [code, msg] of Object.entries(PUBLISH_ERROR_MESSAGES)) {
    if (codeOrMessage.includes(code) || codeOrMessage.includes(code.replace(/_/g, ' '))) {
      return msg;
    }
  }
  return codeOrMessage;
}
