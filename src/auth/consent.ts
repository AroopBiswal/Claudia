/** Plain-HTML approval and error pages for the OAuth authorize flow. No external assets. */

export interface ConsentPageOptions {
  clientName: string;
  redirectHost: string;
  email: string;
  approveAction: string;
  signedRequest: string;
}

const PAGE_STYLE = `
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  .client { font-weight: 600; }
  button { font-size: 1rem; padding: 0.6rem 1.2rem; border-radius: 0.4rem; border: 1px solid #ccc; cursor: pointer; margin-right: 0.5rem; }
  button[value="approve"] { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  button[value="deny"] { background: #fff; }
`;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderConsentPage(opts: ConsentPageOptions): string {
  const clientName = escapeHtml(opts.clientName);
  const redirectHost = escapeHtml(opts.redirectHost);
  const email = escapeHtml(opts.email);
  const approveAction = escapeHtml(opts.approveAction);
  const signedRequest = escapeHtml(opts.signedRequest);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Claudia</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>Connect to Claudia</h1>
<p><span class="client">${clientName}</span> wants to access your Claudia assistant.</p>
<p>You will be sent back to <strong>${redirectHost}</strong> after you decide.</p>
<p>Signed in as ${email}.</p>
<form method="post" action="${approveAction}">
<input type="hidden" name="request" value="${signedRequest}">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
</main>
</body>
</html>
`;
}

export function renderErrorPage(title: string, message: string): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>${safeTitle}</h1>
<p>${safeMessage}</p>
</main>
</body>
</html>
`;
}
