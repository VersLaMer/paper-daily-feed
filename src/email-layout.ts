import packageMetadata from "../package.json";

export const EMAIL_ICON_CID = "paper-daily-feed-icon";
export const EMAIL_WIDTH = 600;

export const SHARED_EMAIL_STYLES = `
      :root { color-scheme: light dark; supported-color-schemes: light dark; }
      @media only screen and (max-width: 420px) {
        .header-meta { display: none !important; }
      }
      @media (prefers-color-scheme: dark) {
        .email-body, .page { background: #000000 !important; }
        .paper-card, .code-block { background: #1c1c1e !important; }
        .border-color, .paper-card { border-color: #30363d !important; }
        .text-primary { color: #c9d1d9 !important; }
        .text-secondary { color: #8b949e !important; }
        .text-tertiary { color: #7d8590 !important; }
        .accent { color: #0a84ff !important; }
        .small-accent, .action-link { color: #0a84ff !important; }
        .muted-link { color: #8e8e93 !important; }
      }
      [data-ogsc] .email-body, [data-ogsc] .page { background: #000000 !important; }
      [data-ogsc] .paper-card, [data-ogsc] .code-block { background: #1c1c1e !important; }
      [data-ogsc] .border-color, [data-ogsc] .paper-card { border-color: #30363d !important; }
      [data-ogsc] .text-primary { color: #c9d1d9 !important; }
      [data-ogsc] .text-secondary { color: #8b949e !important; }
      [data-ogsc] .text-tertiary { color: #7d8590 !important; }
      [data-ogsc] .accent { color: #0a84ff !important; }
      [data-ogsc] .small-accent, [data-ogsc] .action-link { color: #0a84ff !important; }
      [data-ogsc] .muted-link { color: #8e8e93 !important; }
      .action-link { text-decoration: underline !important; }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderSharedEmailHeader(endLabel: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="header-rule border-color" style="border-bottom: 1px solid #d2d2d7;">
                    <tr>
                      <td valign="middle" style="padding-bottom: 14px;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                          <tr>
                            <td width="44" valign="middle">
                              <img src="cid:${EMAIL_ICON_CID}" width="40" height="40" alt="" style="display: block; width: 40px; height: 40px; border: 0; border-radius: 12px;">
                            </td>
                            <td valign="middle" style="padding-left: 10px; color: #007aff; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; white-space: nowrap;" class="accent">Daily Paper Feeds</td>
                          </tr>
                        </table>
                      </td>
                      <td valign="middle" align="right" style="padding-bottom: 14px; color: #6e6e73; font-size: 14px; font-weight: 400; letter-spacing: 0.06em; white-space: nowrap;" class="header-meta text-tertiary">${escapeHtml(endLabel)}</td>
                    </tr>
                  </table>`;
}

export function renderSharedEmailFooter(): string {
  return `<table role="presentation" width="40" cellpadding="0" cellspacing="0" border="0" style="width: 40px; margin: 0 0 15px 0;">
                  <tr>
                    <td class="border-color" style="border-top: 1px solid #e5e5e7; font-size: 0; line-height: 0;">&nbsp;</td>
                  </tr>
                </table>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%;">
                  <tr>
                    <td align="left" valign="middle" class="footer-credit text-tertiary" style="padding: 0; color: #86868b; font-size: 14px; line-height: 1.5; text-align: left;">Built with <a href="${packageMetadata.homepage}" class="accent" style="color: #007aff; font-weight: 700; text-decoration: none;">paper-daily-feed</a> by <a href="https://nehsgnail.github.io/" class="accent" style="color: #007aff; font-weight: 700; text-decoration: none;">nehSgnaiL</a>.</td>
                  </tr>
                  <tr>
                    <td align="left" valign="middle" class="footer-action text-tertiary" style="padding: 6px 0 0 0; color: #86868b; font-size: 14px; line-height: 1.5; text-align: left;"><a href="${packageMetadata.homepage}#customization" class="muted-link" style="color: #aeaeb2; text-decoration: underline;">Manage settings</a></td>
                  </tr>
                </table>`;
}
