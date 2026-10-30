import { describe, it, expect } from 'vitest';
import { whatsappPhone } from '../src/modules/requisicoes/requisition-access';
import { installationInstructions } from '../src/modules/requisicoes/access-instructions';

describe('WhatsApp first access',()=>{
  it('normalizes Brazilian contacts without duplicating the country code',()=>{
    expect(whatsappPhone('(34) 99888-2222')).toBe('5534998882222');
    expect(whatsappPhone('+55 (34) 99888-2222')).toBe('5534998882222');
    expect(whatsappPhone('(55) 3222-1111')).toBe('555532221111');
    for(const value of [null,'','12345','+1 212 555 01000000','034998882222'])expect(whatsappPhone(value)).toBeNull();
  });
  it('uses the configured application origin and includes Android/iOS instructions',()=>{
    const text=installationInstructions('https://app.example.test/redefinir-senha');
    expect(text).toContain('https://app.example.test/login');expect(text).toContain('Android:');
    expect(text).toContain('iPhone:');expect(text).toContain('Minha conta');
  });
});
