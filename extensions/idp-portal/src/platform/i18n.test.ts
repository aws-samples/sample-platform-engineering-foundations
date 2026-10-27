import { describe, expect, it } from 'vitest';
import { translate } from './i18n';

describe('Agent Platform i18n', () => {
  it('uses pt-BR translations by default contract', () => {
    expect(translate('Overview', 'pt-BR')).toBe('Visão geral');
    expect(translate('Help', 'pt-BR')).toBe('Ajuda');
    expect(translate('Provision', 'pt-BR')).toBe('Provisionar');
  });

  it('uses en-US source strings as secondary locale', () => {
    expect(translate('Overview', 'en-US')).toBe('Overview');
    expect(translate('Help', 'en-US')).toBe('Help');
  });

  it('preserves technical terms without a translation', () => {
    expect(translate('ResourceGraphDefinition', 'pt-BR')).toBe('ResourceGraphDefinition');
  });
});
