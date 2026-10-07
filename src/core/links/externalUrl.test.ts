import { isWebUrl } from './externalUrl';

describe('isWebUrl', () => {
  it('accepts plain web addresses', () => {
    expect(isWebUrl('https://www.sentiersdelestrie.qc.ca')).toBe(true);
    expect(isWebUrl('https://example.org/')).toBe(true);
    expect(isWebUrl('http://example.org/a/b?c=1#d')).toBe(true);
    expect(isWebUrl('HTTPS://EXAMPLE.ORG')).toBe(true);
    expect(isWebUrl('https://example.org:8443/x')).toBe(true);
    expect(isWebUrl('https://example.org?q=1')).toBe(true);
  });

  it('refuses every other scheme a tag or index could carry', () => {
    expect(isWebUrl('inukshuk://settings')).toBe(false);
    expect(isWebUrl('intent://scan/#Intent;scheme=zxing;end')).toBe(false);
    expect(isWebUrl('tel:+15555550100')).toBe(false);
    expect(isWebUrl('sms:+15555550100')).toBe(false);
    expect(isWebUrl('market://details?id=x')).toBe(false);
    expect(isWebUrl('file:///etc/hosts')).toBe(false);
    expect(isWebUrl('content://downloads/1')).toBe(false);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isWebUrl('www.example.org')).toBe(false);
    expect(isWebUrl('//example.org')).toBe(false);
  });

  it('refuses malformed or deceptive web addresses', () => {
    expect(isWebUrl('')).toBe(false);
    expect(isWebUrl('https://')).toBe(false);
    expect(isWebUrl('https:///path')).toBe(false);
    expect(isWebUrl(' https://example.org')).toBe(false);
    expect(isWebUrl('https://exa mple.org')).toBe(false);
    expect(isWebUrl('https://example.org/\nmore')).toBe(false);
    expect(isWebUrl('https://bank.example@evil.example/')).toBe(false);
    expect(isWebUrl('https://evil.example\\@bank.example')).toBe(false);
    expect(isWebUrl(`https://example.org/${'a'.repeat(2048)}`)).toBe(false);
  });
});
