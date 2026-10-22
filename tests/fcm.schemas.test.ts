import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { nativeBindingSchema, nativeDeviceSchema } from '../src/modules/notificacoes/fcm.service';
import { getFcmWorkerConfig } from '../src/config/env';

describe('Native FCM request boundaries', () => {
  const device = { token: 'valid_synthetic_fcm_token:123', instalacaoId: randomUUID(), vinculoId: randomUUID() };
  it('accepts only native registration fields', () => {
    expect(nativeDeviceSchema.parse(device)).toEqual(device);
    for (const key of ['empresaId', 'usuarioId', 'perfil', 'senhaVersao']) {
      expect(nativeDeviceSchema.safeParse({ ...device, [key]: randomUUID() }).success).toBe(false);
    }
  });
  it('rejects malformed tokens and identifiers', () => {
    for (const token of ['', 'short', 'a'.repeat(4097), 'https://untrusted.example/token']) {
      expect(nativeDeviceSchema.safeParse({ ...device, token }).success).toBe(false);
    }
    expect(nativeDeviceSchema.safeParse({ ...device, vinculoId: '../other' }).success).toBe(false);
  });
  it('status/revoke accept only the opaque binding', () => {
    expect(nativeBindingSchema.parse({ vinculoId: device.vinculoId })).toEqual({ vinculoId: device.vinculoId });
    expect(nativeBindingSchema.safeParse({ vinculoId: device.vinculoId, token: device.token }).success).toBe(false);
  });
  it('the worker needs no JWT, SMTP or provisioning credentials', () => {
    const env = { NODE_ENV: 'production', DATABASE_URL: 'postgres://synthetic.test/db', FCM_PROJECT_ID: 'admbrasil-taxi' };
    expect(getFcmWorkerConfig(env).fcmProjectId).toBe('admbrasil-taxi');
    expect(() => getFcmWorkerConfig({ ...env, FCM_PROJECT_ID: '' })).toThrow(/FCM_PROJECT_ID/);
    expect(() => getFcmWorkerConfig({ ...env, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });
});
