import { describe, expect, it } from 'vitest';
import { DEFAULT_NAP_CONFIGURATION } from './shared/defaultConfiguration';
import packageJson from '../package.json';

describe('Nap configuration defaults', () => {
  it('matches package contribution defaults', () => {
    const properties = packageJson.contributes.configuration.properties;

    expect(properties['nap.cliPath'].default).toBe(DEFAULT_NAP_CONFIGURATION.cliPath);
    expect(properties['nap.accentColor'].default).toBe(DEFAULT_NAP_CONFIGURATION.accentColor);
    expect(properties['nap.defaultModel'].default).toBe(DEFAULT_NAP_CONFIGURATION.defaultModel);
    expect(properties['nap.debugMode'].default).toBe(DEFAULT_NAP_CONFIGURATION.debugMode);
    expect(properties['nap.securityMode'].default).toBe(DEFAULT_NAP_CONFIGURATION.securityMode);
  });
});
