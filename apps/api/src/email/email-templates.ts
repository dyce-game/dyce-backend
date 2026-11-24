/**
 * The sign-in email. One purpose, one code, no links (nothing to phish, nothing for a spam filter to dislike).
 * Plain text and HTML carry the same words. The code is digits only, but is escaped anyway.
 */
export type OtpEmailInput = {
  code: string;
  ttlMinutes: number;
  /** "signin" = sign up or log in; "link" = adding this address to an account that is already signed in. */
  purpose: 'signin' | 'link';
};

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function otpEmail({ code, ttlMinutes, purpose }: OtpEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `${code} is your Dyce code`;
  const lead =
    purpose === 'link'
      ? 'Use this code to add this email address to your Dyce account.'
      : 'Use this code to sign in to Dyce, or to create your account if you are new.';
  const expires = `It expires in ${ttlMinutes} ${ttlMinutes === 1 ? 'minute' : 'minutes'}.`;
  const safety =
    "Never share this code. Dyce will never ask you for it. If you didn't ask for it, you can ignore this email: nothing happens unless the code is used.";

  const text = [
    `Your Dyce code: ${code}`,
    '',
    lead,
    expires,
    '',
    safety,
    '',
    'Dyce · Game night lives in your chats.',
  ].join('\n');

  const c = escapeHtml(code);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#FBF8F3;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your Dyce code is ${c}. ${escapeHtml(expires)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F3;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#FFFFFF;border:1px solid #E6DDD0;border-radius:22px;">
      <tr><td style="padding:28px 28px 8px;font:800 22px/1.2 Arial,Helvetica,sans-serif;color:#1B140F;">
        <span style="display:inline-block;width:14px;height:14px;border-radius:5px;background:#C93E1C;margin-right:8px;vertical-align:-1px;"></span>dyce
      </td></tr>
      <tr><td style="padding:8px 28px 0;font:400 16px/1.5 Arial,Helvetica,sans-serif;color:#1B140F;">${escapeHtml(lead)}</td></tr>
      <tr><td align="center" style="padding:20px 28px;">
        <div style="font:800 36px/1 'Courier New',Courier,monospace;letter-spacing:8px;color:#B33416;background:#FBE7DF;border-radius:16px;padding:18px 12px;">${c}</div>
      </td></tr>
      <tr><td style="padding:0 28px 8px;font:400 14px/1.5 Arial,Helvetica,sans-serif;color:#6F655B;">${escapeHtml(expires)}</td></tr>
      <tr><td style="padding:0 28px 28px;font:400 13px/1.5 Arial,Helvetica,sans-serif;color:#6F655B;">${escapeHtml(safety)}</td></tr>
    </table>
    <div style="max-width:440px;padding:16px 8px 0;font:400 12px/1.5 Arial,Helvetica,sans-serif;color:#6F655B;">Dyce · Game night lives in your chats.</div>
  </td></tr>
</table>
</body>
</html>`;
  return { subject, text, html };
}
