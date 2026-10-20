import { afterEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { SmtpScheduledMailer } from '../src/modules/corridas/scheduled-mailer';

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
const config = { host: 'smtp.example.test', port: 587, secure: false, user: 'user', password: 'synthetic',
  from: 'avisos@example.test', resetUrl: 'https://app.example.test/redefinir-senha', resetTtlMinutes: 15 };
const message = { id: 'unique-test', to: 'passageiro@example.test', subject: 'Agendamento', text: 'Conteudo individual' };
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('SmtpScheduledMailer', () => {
  it('sends privately with stable message id, TLS and bounded network timeouts', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const mailer = new SmtpScheduledMailer(config);
    await mailer.send(message);
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true,
      disableFileAccess: true, disableUrlAccess: true, socketTimeout: 8000, connectionTimeout: 8000 }));
    expect(sendMail).toHaveBeenCalledWith({ from: { name: 'ADM Taxi', address: config.from },
      to: { name: '', address: message.to }, subject: message.subject, text: message.text,
      messageId: '<agendamento-unique-test@example.test>' });
  });
  it('ends the attempt after nine seconds if transport hangs', async () => {
    vi.useFakeTimers();
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail: () => new Promise(() => undefined) } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const pending = expect(new SmtpScheduledMailer(config).send(message)).rejects.toThrow('SMTP_TIMEOUT');
    await vi.advanceTimersByTimeAsync(9000); await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('propagates SMTP rejection so the queue can retry', async () => {
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail: () => Promise.reject(new Error('SMTP unavailable')) } as unknown as ReturnType<typeof nodemailer.createTransport>);
    await expect(new SmtpScheduledMailer(config).send(message)).rejects.toThrow('SMTP unavailable');
  });
});
