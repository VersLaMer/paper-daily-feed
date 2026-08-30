import { beforeEach, describe, expect, it, mock } from "bun:test";
import packageMetadata from "../package.json";

import { renderMaintenanceEmail, sendMaintenanceNotification } from "../src/maintenance.js";

const sendEmail = mock(async () => ({ messageId: "maintenance-message" }));

describe("renderMaintenanceEmail", () => {
  it("renders workflow-token instructions and repository links in the recommendation email style", () => {
    const html = renderMaintenanceEmail({
      reason: "workflow-permission",
      repository: "reader/paper-daily-feed",
      details: ".github/workflows/daily.yml",
      runUrl: "https://github.com/reader/paper-daily-feed/actions/runs/42"
    });

    expect(html).toContain("Maintenance action required");
    expect(html).toContain("需要手动完成更新");
    expect(html).toContain("检测到新版本");
    expect(html).not.toContain("#e8f4ff");
    expect(html).toContain('width="600"');
    expect(html).toContain('src="cid:paper-daily-feed-icon"');
    expect(html).toContain("border-bottom: 1px solid #d2d2d7");
    expect(html).toContain("font-size: 14px; font-weight: 400; letter-spacing: 0.06em;");
    expect(html).not.toContain("border: 1px solid #d9ebff");
    expect(html).toContain('class="maintenance-main"');
    expect(html).toContain("https://github.com/settings/personal-access-tokens/new");
    expect(html).toContain("https://github.com/reader/paper-daily-feed/settings/secrets/actions/new");
    expect(html).toContain("MAINTENANCE_SYNC_TOKEN");
    expect(html).toContain("Contents");
    expect(html).toContain("Workflows");
    expect(html).toContain(".github/workflows/daily.yml");
    expect(html).toContain("https://github.com/reader/paper-daily-feed/actions/runs/42");
    expect(html).toContain(packageMetadata.homepage);
    expect(html).toContain("by <a href=\"https://nehsgnail.github.io/\"");
    expect(html).toContain('text-decoration: none;">paper-daily-feed</a>');
    expect(html).toContain('text-decoration: none;">nehSgnaiL</a>');
    expect(html).toContain(">Manage settings</a>");
    expect(html).toContain('style="color: inherit; text-decoration: underline;">Manage settings</a>');
    expect(html).toContain(`${packageMetadata.homepage}#customization`);
    expect(html).not.toContain("Unsubscribe");
    expect(html).toContain(".header-meta { display: none !important; }");
    expect(html).toContain(".action-link { text-decoration: underline !important; }");
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain(
      "Maintenance action required: An update is available, but it changes GitHub workflow files."
    );
  });

  it("escapes repository-provided details", () => {
    const html = renderMaintenanceEmail({
      reason: "rebase-conflict",
      repository: "reader/paper-daily-feed",
      details: "<script>alert('x')</script>",
      runUrl: "https://github.com/reader/paper-daily-feed/actions/runs/42"
    });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("branches");
  });
});

describe("sendMaintenanceNotification", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    sendEmail.mockResolvedValue({ messageId: "maintenance-message" });
  });

  it("uses workflow SMTP secrets without requiring APP_CONFIG", async () => {
    await sendMaintenanceNotification(
      {
        MAINTENANCE_REASON: "test",
        MAINTENANCE_REPOSITORY: "nehSgnaiL/paper-daily-feed",
        MAINTENANCE_RUN_URL: "https://github.com/nehSgnaiL/paper-daily-feed/actions/runs/42",
        SENDER: "sender@example.test",
        SENDER_PASSWORD: "app-password",
        RECEIVER: "receiver@example.test",
        SMTP_SERVER: "smtp.example.test",
        SMTP_PORT: "465"
      },
      sendEmail
    );

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "sender@example.test",
        to: "receiver@example.test",
        smtpHost: "smtp.example.test",
        smtpPort: 465,
        smtpPassword: "app-password"
      }),
      expect.stringContaining("Maintenance email test"),
      "[Test] Paper Daily Feed maintenance notification / 维护通知测试"
    );
  });

  it("rejects unknown maintenance reasons", async () => {
    await expect(sendMaintenanceNotification({ MAINTENANCE_REASON: "unknown" })).rejects.toThrow(
      "Unknown maintenance reason: unknown."
    );
  });
});
