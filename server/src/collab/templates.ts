// French e-mail templates (HTML + plain text), sober and branded "Oriel".
import type { MailMessage } from './mailer.js';

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface LayoutOptions {
  to: string;
  subject: string;
  /** Short hidden preview line shown by mail clients. */
  preheader: string;
  title: string;
  /** Paragraphs of plain text (escaped in HTML). */
  paragraphs: string[];
  /** Optional quoted excerpt. */
  quote?: string;
  button?: { label: string; url: string };
  /** Extra HTML block (already safe) and its text counterpart, e.g. a list of notifications. */
  extra?: { html: string; text: string };
  footer: string;
}

function layout(o: LayoutOptions): MailMessage {
  const p = o.paragraphs.map((t) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#37352f">${escapeHtml(t)}</p>`).join('');
  const quote = o.quote
    ? `<blockquote style="margin:0 0 18px;padding:10px 14px;border-left:3px solid #d0d7de;background:#f6f8fa;color:#57606a;font-size:14px;line-height:1.5;white-space:pre-wrap">${escapeHtml(o.quote)}</blockquote>`
    : '';
  const button = o.button
    ? `<p style="margin:22px 0 8px"><a href="${escapeHtml(o.button.url)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#2f6fde;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px">${escapeHtml(o.button.label)}</a></p>
<p style="margin:0 0 6px;font-size:12px;color:#8c959f;word-break:break-all">${escapeHtml(o.button.url)}</p>`
    : '';
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(o.subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(o.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;border:1px solid #e6e8eb">
<tr><td style="padding:22px 28px 0;font-size:15px;font-weight:700;color:#1f2328;letter-spacing:.2px">❄︎ Oriel</td></tr>
<tr><td style="padding:18px 28px 26px">
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#1f2328">${escapeHtml(o.title)}</h1>
${p}${quote}${o.extra?.html ?? ''}${button}
</td></tr>
</table>
<p style="max-width:560px;margin:14px auto 0;font-size:12px;line-height:1.5;color:#8c959f">${escapeHtml(o.footer)}</p>
</td></tr></table>
</body></html>`;
  const text = [
    'Oriel',
    '',
    o.title,
    '',
    ...o.paragraphs.flatMap((t) => [t, '']),
    ...(o.quote ? [o.quote.split('\n').map((l) => `> ${l}`).join('\n'), ''] : []),
    ...(o.extra ? [o.extra.text, ''] : []),
    ...(o.button ? [`${o.button.label} : ${o.button.url}`, ''] : []),
    '--',
    o.footer,
  ].join('\n');
  return { to: o.to, subject: o.subject, text, html };
}

const NOTIF_FOOTER = 'Vous recevez cet e-mail car vous êtes membre d’un espace Oriel. Réglez la fréquence des e-mails dans Réglages › Notifications.';

export function passwordResetMail(o: { to: string; name: string; url: string; minutes: number; byAdmin?: boolean }): MailMessage {
  return layout({
    to: o.to,
    subject: 'Réinitialisation de votre mot de passe Oriel',
    preheader: 'Choisissez un nouveau mot de passe.',
    title: 'Réinitialiser votre mot de passe',
    paragraphs: [
      `Bonjour ${o.name},`,
      o.byAdmin
        ? 'Un administrateur de votre instance Oriel a créé un lien pour réinitialiser votre mot de passe.'
        : 'Nous avons reçu une demande de réinitialisation du mot de passe de votre compte Oriel.',
      `Ce lien est valable ${o.minutes >= 120 ? `${Math.round(o.minutes / 60)} heures` : o.minutes >= 60 ? '1 heure' : `${o.minutes} minutes`} et ne peut servir qu’une seule fois. Toutes vos sessions ouvertes seront fermées.`,
    ],
    button: { label: 'Choisir un nouveau mot de passe', url: o.url },
    footer: 'Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail : votre mot de passe reste inchangé.',
  });
}

export function inviteMail(o: { to: string; inviter: string; workspace: string; role: string; url: string; expiresAt: number }): MailMessage {
  const until = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' }).format(new Date(o.expiresAt));
  return layout({
    to: o.to,
    subject: `${o.inviter} vous invite à rejoindre « ${o.workspace} » sur Oriel`,
    preheader: `Rejoignez l’espace « ${o.workspace} ».`,
    title: `Rejoignez « ${o.workspace} »`,
    paragraphs: [
      `${o.inviter} vous invite à rejoindre l’espace de travail « ${o.workspace} » sur Oriel (rôle : ${o.role.toLowerCase()}).`,
      `Le lien d’invitation est valable jusqu’au ${until}.`,
    ],
    button: { label: 'Accepter l’invitation', url: o.url },
    footer: 'Si vous ne connaissez pas l’expéditeur, vous pouvez ignorer cet e-mail.',
  });
}

export function testMail(o: { to: string; name: string; from: string }): MailMessage {
  return layout({
    to: o.to,
    subject: 'E-mail de test Oriel',
    preheader: 'L’envoi d’e-mails fonctionne.',
    title: 'L’envoi d’e-mails fonctionne',
    paragraphs: [`Bonjour ${o.name},`, `Cet e-mail de test confirme que votre instance Oriel peut envoyer des e-mails (expéditeur : ${o.from}).`],
    footer: 'E-mail envoyé depuis Réglages › Notifications.',
  });
}

export interface NotificationMailItem {
  /** e.g. « Alice vous a mentionné dans Projet X ». */
  title: string;
  excerpt: string;
  url: string;
}

export function notificationMail(o: { to: string; workspace: string; item: NotificationMailItem }): MailMessage {
  return layout({
    to: o.to,
    subject: o.item.title,
    preheader: o.item.excerpt || o.item.title,
    title: o.item.title,
    paragraphs: [`Espace « ${o.workspace} ».`],
    quote: o.item.excerpt || undefined,
    button: { label: 'Ouvrir dans Oriel', url: o.item.url },
    footer: NOTIF_FOOTER,
  });
}

export function digestMail(o: { to: string; name: string; groups: Array<{ workspace: string; items: NotificationMailItem[] }>; inboxUrl: string }): MailMessage {
  const count = o.groups.reduce((n, g) => n + g.items.length, 0);
  const html = o.groups
    .map(
      (g) => `<h2 style="margin:18px 0 8px;font-size:14px;color:#57606a;text-transform:uppercase;letter-spacing:.4px">${escapeHtml(g.workspace)}</h2>
<ul style="margin:0 0 8px;padding:0;list-style:none">${g.items
        .map(
          (i) => `<li style="margin:0 0 10px;padding:10px 12px;border:1px solid #e6e8eb;border-radius:6px">
<a href="${escapeHtml(i.url)}" style="color:#1f2328;font-weight:600;text-decoration:none;font-size:14px">${escapeHtml(i.title)}</a>${
            i.excerpt ? `<div style="margin-top:4px;color:#57606a;font-size:13px;line-height:1.45">${escapeHtml(i.excerpt)}</div>` : ''
          }</li>`,
        )
        .join('')}</ul>`,
    )
    .join('');
  const text = o.groups
    .map((g) => [`== ${g.workspace} ==`, ...g.items.map((i) => `- ${i.title}${i.excerpt ? `\n  ${i.excerpt}` : ''}\n  ${i.url}`)].join('\n'))
    .join('\n\n');
  return layout({
    to: o.to,
    subject: count > 1 ? `Oriel : ${count} nouvelles notifications` : 'Oriel : 1 nouvelle notification',
    preheader: o.groups[0]?.items[0]?.title ?? 'Vos notifications du jour',
    title: 'Votre résumé du jour',
    paragraphs: [`Bonjour ${o.name}, voici ce que vous avez manqué.`],
    extra: { html, text },
    button: { label: 'Ouvrir la boîte de réception', url: o.inboxUrl },
    footer: NOTIF_FOOTER,
  });
}
