// Outgoing e-mail (SMTP via nodemailer). Configured from the environment:
//   SMTP_URL                      e.g. smtps://user:pass@smtp.example.com:465
//   or SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_SECURE
//   MAIL_FROM                     e.g. "Oriel <oriel@example.com>"
// Special values for development and tests: SMTP_URL=json (nothing is sent: messages are printed
// in the server output and kept in memory), SMTP_URL=json:quiet (memory only) or SMTP_URL=stream.
// Without configuration every send is a no-op returning false: callers degrade gracefully.
import nodemailer, { type Transporter } from 'nodemailer';
import type { AppContext } from '../context.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface SentMail extends MailMessage {
  from: string;
  at: number;
}

export interface MailerConfig {
  /** nodemailer transport options or connection URL; null = not configured. */
  transport: string | Record<string, unknown> | null;
  from: string;
  /** Kept in memory (json/stream transports): useful for tests and local development. */
  capture: boolean;
  /** Print captured messages to the server output (SMTP_URL=json). */
  print?: boolean;
}

/** Last sent messages (json/stream transports only; newest last). */
export const mailOutbox: SentMail[] = [];
const OUTBOX_MAX = 200;

const truthy = (v: string | undefined) => !!v && !['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase());

export function mailerConfigFromEnv(env: NodeJS.ProcessEnv = process.env, publicUrl = ''): MailerConfig {
  const url = (env.SMTP_URL ?? '').trim();
  const host = (env.SMTP_HOST ?? '').trim();
  let transport: MailerConfig['transport'] = null;
  let capture = false;
  let print = false;
  if (url === 'json' || url === 'json:' || url === 'json:quiet') {
    transport = { jsonTransport: true };
    capture = true;
    print = url !== 'json:quiet';
  } else if (url === 'stream' || url === 'stream:') {
    transport = { streamTransport: true, buffer: true, newline: 'unix' };
    capture = true;
  } else if (url) {
    transport = url;
  } else if (host) {
    const port = Number(env.SMTP_PORT) || 587;
    const user = (env.SMTP_USER ?? '').trim();
    transport = {
      host,
      port,
      secure: env.SMTP_SECURE !== undefined && env.SMTP_SECURE !== '' ? truthy(env.SMTP_SECURE) : port === 465,
      ...(user ? { auth: { user, pass: env.SMTP_PASS ?? '' } } : {}),
    };
  }
  let domain = 'localhost';
  try {
    if (publicUrl) domain = new URL(publicUrl).hostname;
  } catch {
    /* keep localhost */
  }
  const from = (env.MAIL_FROM ?? '').trim() || `Oriel <no-reply@${domain}>`;
  return { transport, from, capture, print };
}

export class Mailer {
  private transporter: Transporter | null = null;

  constructor(readonly config: MailerConfig) {
    if (config.transport) this.transporter = nodemailer.createTransport(config.transport as never);
  }

  get enabled(): boolean {
    return this.transporter !== null;
  }

  /** Sends a message; resolves false (never throws) when not configured or on failure. */
  async send(msg: MailMessage, log?: (msg: string, err?: unknown) => void): Promise<boolean> {
    if (!this.transporter) return false;
    try {
      await this.transporter.sendMail({ from: this.config.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
      if (this.config.capture) {
        if (this.config.print) console.log(`[e-mail non envoyé — SMTP_URL=json] À : ${msg.to}\nObjet : ${msg.subject}\n\n${msg.text}\n`);
        mailOutbox.push({ ...msg, from: this.config.from, at: Date.now() });
        if (mailOutbox.length > OUTBOX_MAX) mailOutbox.splice(0, mailOutbox.length - OUTBOX_MAX);
      }
      return true;
    } catch (err) {
      log?.(`envoi d'e-mail impossible (${msg.subject})`, err);
      return false;
    }
  }

  close(): void {
    this.transporter?.close();
    this.transporter = null;
  }
}

const mailers = new WeakMap<AppContext, Mailer>();

/** The mailer of a server instance (configuration read from the environment on first use). */
export function getMailer(ctx: AppContext): Mailer {
  let mailer = mailers.get(ctx);
  if (!mailer) {
    mailer = new Mailer(mailerConfigFromEnv(process.env, ctx.config.publicUrl));
    mailers.set(ctx, mailer);
  }
  return mailer;
}

/** Replaces the mailer of a server instance (tests). */
export function setMailer(ctx: AppContext, mailer: Mailer): void {
  mailers.get(ctx)?.close();
  mailers.set(ctx, mailer);
}

// --- absolute links -----------------------------------------------------------------

const origins = new WeakMap<AppContext, string>();

/**
 * Remembers the origin of the last browser request of an instance administrator (absolute links
 * when PUBLIC_URL is not set). Callers must never pass the origin of another account's request:
 * every e-mail, including other users' password resets, uses it (Host header poisoning).
 */
export function rememberOrigin(ctx: AppContext, origin: string): void {
  if (!ctx.config.publicUrl && origin) origins.set(ctx, origin);
}

/** Base URL for links in e-mails: PUBLIC_URL, else the last seen request origin. */
export function baseUrl(ctx: AppContext): string {
  return ctx.config.publicUrl || origins.get(ctx) || `http://localhost:${ctx.config.port}`;
}
