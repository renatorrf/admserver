import nodemailer from 'nodemailer';
import type { MailConfig } from '../../config/env';

export interface PasswordMailer {
  send(to: string, resetUrl: string, minutes: number): Promise<void>;
}

export class SmtpPasswordMailer implements PasswordMailer {
  private readonly transport;
  constructor(private readonly config: MailConfig) {
    this.transport = nodemailer.createTransport({
      host: config.host, port: config.port, secure: config.secure,
      requireTLS: !config.secure, auth: { user: config.user, pass: config.password },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000,
      disableFileAccess: true, disableUrlAccess: true,
    });
  }

  async send(to: string, resetUrl: string, minutes: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.transport.sendMail({
      from: { name: 'ADM Taxi', address: this.config.from }, to: { address: to, name: '' },
      subject: 'Redefinicao de senha - ADM Taxi',
      text: `Recebemos uma solicitacao para redefinir sua senha no ADM Taxi.\n\n${resetUrl}\n\nEste link pode ser utilizado uma unica vez e expira em ${minutes} minutos.\nSe voce nao solicitou a troca, ignore este email. Sua senha permanece inalterada.`,
    }), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('SMTP deadline exceeded')), 9_000);
    })]); } finally { clearTimeout(timer); }
  }
}
