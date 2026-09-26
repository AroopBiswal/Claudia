// The /a/<token> push action routes (docs/tools.md "GET/POST /a/<token>",
// docs/PLAN.md "Reminders"): the link a push's Done / +1 hour / Tomorrow
// button opens. GET shows a small confirm page (used for link previews too,
// so it must never change anything); POST performs the action once, guarded
// by the link's single-use nonce.

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { LinkAction } from '../notify/links.ts';
import { verifyActionLink } from '../notify/links.ts';
import type { ClaudiaContext } from '../services/context.ts';
import { applyLinkAction, type UpdateResult } from '../services/update.ts';
import { formatClock } from '../time/format.ts';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function actionLabel(action: LinkAction): string {
  switch (action) {
    case 'done':
      return 'Mark done';
    case 'snooze1h':
      return 'Snooze 1 hour';
    case 'tomorrow':
      return 'Remind me tomorrow';
  }
}

const PAGE_STYLE =
  'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;' +
  'margin:48px auto;padding:0 20px;color:#111;background:#fff}' +
  'p{line-height:1.5;font-size:1.05em}' +
  'button{font-size:1.05em;padding:12px 22px;border-radius:8px;border:none;' +
  'background:#2563eb;color:#fff;cursor:pointer}' +
  'button:active{background:#1d4ed8}';

function page(title: string, body: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>` +
    `<body>${body}</body></html>`
  );
}

function messagePage(title: string, message: string): string {
  return page(title, `<p>${escapeHtml(message)}</p>`);
}

function confirmPage(text: string, action: LinkAction): string {
  const body =
    `<p>${escapeHtml(text)}</p>` +
    `<form method="post"><button type="submit">${escapeHtml(actionLabel(action))}</button></form>`;
  return page('Claudia', body);
}

function setSecurityHeaders(res: Response): void {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  );
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

/** Later of an item's reminder and snoozed_until, as ItemView carries them (lexicographic compare). */
function effectiveLocal(item: {
  reminder: string | null;
  snoozed_until: string | null;
}): string | null {
  const { reminder, snoozed_until: snooze } = item;
  if (reminder === null && snooze === null) return null;
  if (snooze === null) return reminder;
  if (reminder === null) return snooze;
  return snooze > reminder ? snooze : reminder;
}

/** The short confirmation shown/returned after a successful action. */
function confirmationText(action: LinkAction, result: UpdateResult): string {
  if (result.message === 'Already done.') return 'Already done ✓';
  if (action === 'done') return 'Done ✓';

  const local = result.item ? effectiveLocal(result.item) : null;
  const clock = local ? formatClock(local.slice(11)) : null;

  if (action === 'snooze1h') return clock ? `Snoozed until ${clock}` : 'Snoozed.';
  return clock ? `Tomorrow at ${clock}` : 'Snoozed.';
}

function errorPage(reason: 'malformed' | 'bad_signature' | 'expired' | 'unsupported'): {
  status: number;
  title: string;
  message: string;
} {
  if (reason === 'expired') {
    return { status: 410, title: 'Link expired', message: 'This link has expired.' };
  }
  return { status: 400, title: 'Invalid link', message: 'This link is not valid.' };
}

function wantsJson(req: Request): boolean {
  const accept = req.headers.accept ?? '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

/** Builds the `/a` router (docs/tools.md): mounted by the caller at `/a`. */
export function createActionsRouter(ctx: ClaudiaContext): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));

  router.get('/:token', (req: Request, res: Response) => {
    setSecurityHeaders(res);
    const verified = verifyActionLink(ctx.actionKey, String(req.params.token ?? ''), {
      now: ctx.clock.now(),
    });

    if (!verified.ok) {
      const { status, title, message } = errorPage(verified.reason);
      res.status(status).type('html').send(messagePage(title, message));
      return;
    }

    // GET never mutates: no nonce check, no applyLinkAction call.
    const item = ctx.index.getItem(verified.payload.id);
    const text = item ? item.text : 'This item is no longer available.';
    res.status(200).type('html').send(confirmPage(text, verified.payload.a));
  });

  router.post('/:token', (req: Request, res: Response, next: NextFunction) => {
    setSecurityHeaders(res);
    const verified = verifyActionLink(ctx.actionKey, String(req.params.token ?? ''), {
      now: ctx.clock.now(),
    });
    const asJson = wantsJson(req);

    if (!verified.ok) {
      const { status, title, message } = errorPage(verified.reason);
      if (asJson) {
        res.status(status).json({ ok: false, message });
      } else {
        res.status(status).type('html').send(messagePage(title, message));
      }
      return;
    }

    if (!ctx.state.useNonce(verified.payload.n)) {
      const message = 'This link was already used.';
      if (asJson) {
        res.status(410).json({ ok: false, message });
      } else {
        res.status(410).type('html').send(messagePage('Already used', message));
      }
      return;
    }

    const { a: action, id } = verified.payload;
    applyLinkAction(ctx, action, id)
      .then((result) => {
        if (result.status === 'not_found') {
          if (asJson) {
            res.status(404).json({ ok: false, message: result.message });
          } else {
            res.status(404).type('html').send(messagePage('Not found', result.message));
          }
          return;
        }

        const message = confirmationText(action, result);
        if (asJson) {
          res.status(200).json({ ok: true, message });
        } else {
          res.status(200).type('html').send(messagePage('Claudia', message));
        }
      })
      .catch(next);
  });

  return router;
}
