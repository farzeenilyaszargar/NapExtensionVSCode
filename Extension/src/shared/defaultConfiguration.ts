import { NAP_DEFAULT_ACCENT, NapConfigurationSnapshot } from './protocol';

export const DEFAULT_NAP_CONFIGURATION: NapConfigurationSnapshot = {
  cliPath: 'nap',
  accentColor: NAP_DEFAULT_ACCENT,
  defaultModel: 'gpt-5.4-mini',
  debugMode: false,
  securityMode: 'standard'
};
