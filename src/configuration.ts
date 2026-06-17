import * as vscode from 'vscode';
import { NapConfigurationSnapshot, NapSecurityMode } from './shared/protocol';
import { DEFAULT_NAP_CONFIGURATION } from './shared/defaultConfiguration';

export { DEFAULT_NAP_CONFIGURATION };

export function getNapConfiguration(): NapConfigurationSnapshot {
  const config = vscode.workspace.getConfiguration('nap');
  const securityMode = config.get<NapSecurityMode>('securityMode', DEFAULT_NAP_CONFIGURATION.securityMode);

  return {
    cliPath: coerceNonEmptyString(config.get<string>('cliPath'), DEFAULT_NAP_CONFIGURATION.cliPath),
    accentColor: coerceNonEmptyString(config.get<string>('accentColor'), DEFAULT_NAP_CONFIGURATION.accentColor),
    defaultModel: coerceNonEmptyString(config.get<string>('defaultModel'), DEFAULT_NAP_CONFIGURATION.defaultModel),
    debugMode: config.get<boolean>('debugMode', DEFAULT_NAP_CONFIGURATION.debugMode),
    securityMode: securityMode === 'strict' ? 'strict' : 'standard'
  };
}

function coerceNonEmptyString(value: string | undefined, fallback: string): string {
  return value?.trim() ? value.trim() : fallback;
}
