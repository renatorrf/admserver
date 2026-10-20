import nodemailer from 'nodemailer';
import type { MailConfig } from '../../config/env';

export interface ScheduledMailer {
  send(message: { id: string; to: string; subject: string; text: string }): Promise<void>;
}

export class SmtpScheduledMailer implements ScheduledMailer {
  private readonly transport;
  constructor(private readonly config: MailConfig) {
    this.transport = nodemailer.createTransport({
      host: config.host, port: config.port, secure: config.secure, requireTLS: !config.secure,
      auth: { user: config.user, pass: config.password }, connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 8_000,
      disableFileAccess: true, disableUrlAccess: true,
    });
  }
  async send(message: { id: string; to: string; subject: string; text: string }): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.transport.sendMail({
        from: { name: 'ADM Taxi', address: this.config.from }, to: { name: '', address: message.to },
        subject: message.subject, text: message.text,
        messageId: `<agendamento-${message.id}@${this.config.from.split('@')[1]}>`,
      }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('SMTP_TIMEOUT')), 9_000); })]);
    } finally { clearTimeout(timer); }
  }
}
