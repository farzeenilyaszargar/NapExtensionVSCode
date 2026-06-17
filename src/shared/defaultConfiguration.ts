import { NAP_DEFAULT_ACCENT, NapConfigurationSnapshot } from './protocol';

export const DEFAULT_NAP_CONFIGURATION: NapConfigurationSnapshot = {
  cliPath: 'gemini',
  accentColor: NAP_DEFAULT_ACCENT,
  defaultModel: 'auto',
  debugMode: false,
  securityMode: 'standard'
};
