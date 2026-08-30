import packageMetadata from "../package.json";
import type { DeliveryConfig } from "./app-config.js";
import { sendEmail } from "./email.js";
import {
  EMAIL_WIDTH,
  renderSharedEmailFooter,
  renderSharedEmailHeader,
  SHARED_EMAIL_STYLES
} from "./email-layout.js";

type Env = Record<string, string | undefined>;

export type MaintenanceReason = "workflow-permission" | "rebase-conflict" | "push-failed" | "test";

export type MaintenanceNotice = {
  reason: MaintenanceReason;
  repository: string;
  details: string;
  runUrl: string;
};

type NoticeContent = {
  eyebrow: string;
  title: string;
  titleZh: string;
  introduction: string;
  introductionZh: string;
  steps: Array<{ en: string; zh: string }>;
};

const UPSTREAM_URL = packageMetadata.homepage;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function requireReason(value: string | undefined): MaintenanceReason {
  if (["workflow-permission", "rebase-conflict", "push-failed", "test"].includes(value ?? "")) {
    return value as MaintenanceReason;
  }
  throw new Error(`Unknown maintenance reason: ${value ?? ""}.`);
}

function repositoryUrl(repository: string, path = ""): string {
  return `https://github.com/${repository}${path}`;
}

function noticeContent(notice: MaintenanceNotice): NoticeContent {
  const workflowUrl = repositoryUrl(notice.repository, "/actions/workflows/maintenance.yml");

  switch (notice.reason) {
    case "workflow-permission":
      return {
        eyebrow: "Repository Maintenance",
        title: "Maintenance action required",
        titleZh: "需要手动完成更新",
        introduction: "An update is available, but it changes GitHub workflow files. GitHub requires a one-time token before the fork can apply it automatically.",
        introductionZh: "检测到新版本，但更新包含 GitHub 工作流文件。GitHub 要求先完成一次 token 配置，fork 才能自动应用更新。",
        steps: [
          {
            en: `Open the <a href="https://github.com/settings/personal-access-tokens/new">fine-grained token page</a> and select only <strong>${escapeHtml(notice.repository)}</strong>.`,
            zh: `打开 <a href="https://github.com/settings/personal-access-tokens/new">fine-grained token 页面</a>，并且只选择仓库 <strong>${escapeHtml(notice.repository)}</strong>。`
          },
          {
            en: "Grant repository permissions <strong>Contents: Read and write</strong> and <strong>Workflows: Read and write</strong>, then create and copy the token.",
            zh: "将仓库权限 <strong>Contents</strong> 和 <strong>Workflows</strong> 都设为 <strong>Read and write</strong>，然后创建并复制 token。"
          },
          {
            en: `Open <a href="${escapeHtml(repositoryUrl(notice.repository, "/settings/secrets/actions/new"))}">New Actions secret</a>, name it <strong>MAINTENANCE_SYNC_TOKEN</strong>, paste the token, and save.`,
            zh: `打开<a href="${escapeHtml(repositoryUrl(notice.repository, "/settings/secrets/actions/new"))}">新建 Actions secret</a> 页面，名称填写 <strong>MAINTENANCE_SYNC_TOKEN</strong>，粘贴 token 并保存。`
          },
          {
            en: `Open <a href="${escapeHtml(workflowUrl)}">Repository maintenance</a> and click <strong>Run workflow</strong>.`,
            zh: `打开 <a href="${escapeHtml(workflowUrl)}">Repository maintenance</a>，点击 <strong>Run workflow</strong>。`
          }
        ]
      };
    case "rebase-conflict":
      return {
        eyebrow: "Repository Maintenance",
        title: "Maintenance action required",
        titleZh: "需要手动完成更新",
        introduction: "An update is available, but custom commits in this fork conflict with the latest upstream version. No partial update was pushed.",
        introductionZh: "检测到新版本，但 fork 中的自定义提交与最新上游版本冲突。系统没有推送不完整的更新。",
        steps: [
          {
            en: `Open the fork's <a href="${escapeHtml(repositoryUrl(notice.repository, "/branches"))}">branches page</a> and keep custom work on a separate branch.`,
            zh: `打开 fork 的<a href="${escapeHtml(repositoryUrl(notice.repository, "/branches"))}">分支页面</a>，把自定义内容保留在单独分支。`
          },
          {
            en: "Resolve the files listed below against the latest upstream main branch.",
            zh: "参照最新的上游 main 分支，解决下方列出的冲突文件。"
          },
          {
            en: `Rerun <a href="${escapeHtml(workflowUrl)}">Repository maintenance</a>, then test the daily feed.`,
            zh: `重新运行 <a href="${escapeHtml(workflowUrl)}">Repository maintenance</a>，然后测试每日论文推送。`
          }
        ]
      };
    case "push-failed":
      return {
        eyebrow: "Repository Maintenance",
        title: "Maintenance action required",
        titleZh: "需要手动完成更新",
        introduction: "The update was prepared, but GitHub rejected the push. Branch protection or a concurrent change is the most likely cause.",
        introductionZh: "更新已经准备完成，但 GitHub 拒绝了推送。最可能的原因是分支保护或同时发生了其他修改。",
        steps: [
          {
            en: `Open <a href="${escapeHtml(repositoryUrl(notice.repository, "/settings/branches"))}">branch settings</a> and inspect the rule for <strong>main</strong>.`,
            zh: `打开<a href="${escapeHtml(repositoryUrl(notice.repository, "/settings/branches"))}">分支设置</a>，检查 <strong>main</strong> 的规则。`
          },
          {
            en: "For a feed-only fork, allow force pushes on main or remove its protection. Keep personal work on a separate branch.",
            zh: "如果该 fork 只用于论文推送，请允许向 main 强制推送或移除其保护；个人修改请保存在单独分支。"
          },
          {
            en: `Rerun <a href="${escapeHtml(workflowUrl)}">Repository maintenance</a>.`,
            zh: `重新运行 <a href="${escapeHtml(workflowUrl)}">Repository maintenance</a>。`
          }
        ]
      };
    case "test":
      return {
        eyebrow: "Repository Maintenance",
        title: "Maintenance email test",
        titleZh: "维护邮件测试",
        introduction: "This test confirms that paper-daily-feed can deliver maintenance guidance using the SMTP settings stored in GitHub Actions.",
        introductionZh: "这封测试邮件用于确认 paper-daily-feed 可以使用 GitHub Actions 中保存的 SMTP 设置发送维护指引。",
        steps: [
          {
            en: `Open <a href="${escapeHtml(notice.runUrl)}">the workflow run</a> to verify the test completed.`,
            zh: `打开<a href="${escapeHtml(notice.runUrl)}">工作流运行页面</a>，确认测试已经完成。`
          },
          {
            en: "No repository change or manual maintenance action is required.",
            zh: "本次测试没有修改仓库，也不需要执行维护操作。"
          }
        ]
      };
  }
}

function renderSteps(steps: Array<{ en: string; zh: string }>): string {
  return steps
    .map(
      (step, index) => `<tr>
                        <td valign="top" class="small-accent" style="width: 28px; padding: 0 10px 18px 0; color: #007aff; font-size: 14px; font-weight: 700; line-height: 1.5;">${index + 1}.</td>
                        <td class="maintenance-copy text-primary" style="padding: 0 0 18px 0; color: #1d1d1f; font-size: 17px; line-height: 1.5;">${step.en}<span lang="zh-CN" class="text-secondary" style="display: block; margin-top: 6px; color: #6e6e73;">${step.zh}</span></td>
                      </tr>`
    )
    .join("\n");
}

export function renderMaintenanceEmail(notice: MaintenanceNotice): string {
  const content = noticeContent(notice);
  const preheader = truncateText(`${content.title}: ${content.introduction}`, 150);
  const details = notice.details.trim()
    ? `<p class="text-primary" style="margin: 10px 0 8px 0; color: #1d1d1f; font-size: 14px; font-weight: 700;">Affected files or details / 受影响文件或详情</p>
                  <pre class="code-block text-secondary border-color" style="margin: 0; padding: 14px; overflow-wrap: anywhere; white-space: pre-wrap; background: #f5f5f7; border: 1px solid #e5e5e7; border-radius: 8px; color: #424245; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5;">${escapeHtml(notice.details.trim())}</pre>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
    <title>${content.title}</title>
    <style>
      ${SHARED_EMAIL_STYLES}
      .maintenance-main a { color: #007aff !important; text-decoration: underline !important; }
      @media only screen and (max-width: 680px) {
        .page-pad { padding: 24px 10px !important; }
        .email-shell { width: 100% !important; max-width: 100% !important; table-layout: fixed !important; }
        .header-pad, .maintenance-main, .maintenance-footer { padding-left: 18px !important; padding-right: 18px !important; }
        .maintenance-title { font-size: 28px !important; }
      }
      @media only screen and (min-width: 600px) {
        .maintenance-copy { font-size: 18px !important; }
      }
      @media (prefers-color-scheme: dark) {
        .maintenance-main a { color: #0a84ff !important; }
      }
      [data-ogsc] .maintenance-main a { color: #0a84ff !important; }
    </style>
  </head>
  <body class="email-body" style="margin: 0; padding: 0;">
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent; mso-hide: all;">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="page" style="width: 100%; border-collapse: collapse;">
      <tr>
        <td align="center" class="page-pad" style="padding: 34px 16px; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #1d1d1f;">
          <table role="presentation" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" align="center" class="email-shell" style="width: 100%; max-width: ${EMAIL_WIDTH}px; table-layout: fixed; border-collapse: collapse;">
            <tr>
              <td class="header-pad" style="padding: 10px 20px 26px 20px;">
                ${renderSharedEmailHeader("MAINTENANCE")}
              </td>
            </tr>
            <tr>
              <td class="maintenance-main" style="padding: 0 20px 32px 20px; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
                <p class="small-accent" style="margin: 0 0 8px 0; color: #007aff; font-size: 14px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">${content.eyebrow}</p>
                <h1 class="maintenance-title text-primary" style="margin: 0; color: #1d1d1f; font-size: 30px; line-height: 1.14; font-weight: 700; letter-spacing: -0.025em;">${content.title}</h1>
                <p lang="zh-CN" class="accent" style="margin: 7px 0 0 0; color: #007aff; font-size: 20px; font-weight: 700; line-height: 1.3;">${content.titleZh}</p>
                <p class="maintenance-copy text-secondary" style="margin: 16px 0 0 0; color: #424245; font-size: 17px; line-height: 1.5;">${content.introduction}</p>
                <p lang="zh-CN" class="maintenance-copy text-secondary" style="margin: 8px 0 0 0; color: #6e6e73; font-size: 17px; line-height: 1.5;">${content.introductionZh}</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; margin-top: 28px; border-collapse: collapse;">
                  ${renderSteps(content.steps)}
                </table>
                ${details}
                <p class="text-tertiary" style="margin: 20px 0 0 0; color: #6e6e73; font-size: 14px; line-height: 1.5;">Repository / 仓库: ${escapeHtml(notice.repository)} · <a href="${escapeHtml(notice.runUrl)}" class="accent" style="color: #007aff;">View workflow run / 查看工作流</a></p>
              </td>
            </tr>
            <tr>
              <td align="left" class="maintenance-footer text-tertiary" style="padding: 10px 20px 4px 20px; text-align: left; color: #86868b; font-size: 14px; line-height: 1.5;">
                ${renderSharedEmailFooter()}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function deliveryFromEnv(env: Env): DeliveryConfig {
  return {
    mode: "smtp",
    from: env.SENDER ?? "",
    to: env.RECEIVER ?? "",
    smtpHost: env.SMTP_SERVER ?? "",
    smtpPort: Number(env.SMTP_PORT ?? 465),
    smtpPassword: env.SENDER_PASSWORD ?? ""
  };
}

export async function sendMaintenanceNotification(
  env: Env = process.env,
  deliver: typeof sendEmail = sendEmail
): Promise<unknown> {
  const reason = requireReason(env.MAINTENANCE_REASON);
  const notice: MaintenanceNotice = {
    reason,
    repository: env.MAINTENANCE_REPOSITORY?.trim() || "nehSgnaiL/paper-daily-feed",
    details: env.MAINTENANCE_DETAILS ?? "",
    runUrl: env.MAINTENANCE_RUN_URL?.trim() || UPSTREAM_URL
  };
  const subject = reason === "test"
    ? "[Test] Paper Daily Feed maintenance notification / 维护通知测试"
    : "Action required: update Paper Daily Feed / 需要手动更新";

  return deliver(deliveryFromEnv(env), renderMaintenanceEmail(notice), subject);
}
