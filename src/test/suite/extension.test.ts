import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('Nap extension', () => {
  test('activates and exposes expected commands', async () => {
    const extension = vscode.extensions.getExtension('NapCode.nap');
    assert.ok(extension, 'Nap extension should be discoverable by id.');
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nap.openChat'));
    assert.ok(commands.includes('nap.moveChatToRight'));
    assert.ok(commands.includes('nap.newChat'));
    assert.ok(commands.includes('nap.clearChat'));
    assert.ok(commands.includes('nap.openAccounts'));
    assert.ok(commands.includes('nap.openSettings'));
    assert.ok(!commands.includes('nap.maximizeChat'));
    assert.ok(!commands.includes('nap.closeChat'));
  });

  test('contributes Nap chat view and configuration defaults', async () => {
    const extension = vscode.extensions.getExtension('NapCode.nap');
    assert.ok(extension, 'Nap extension should be discoverable by id.');

    const packageJson = extension.packageJSON;
    assert.equal(packageJson.contributes.views.nap[0].id, 'nap.chatView');
    assert.equal(packageJson.contributes.viewsContainers.activitybar[0].id, 'nap');

    const config = vscode.workspace.getConfiguration('nap');
    assert.equal(config.get('cliPath'), 'nap');
    assert.equal(config.get('defaultModel'), 'auto');
    assert.equal(config.get('debugMode'), false);
    assert.equal(config.get('securityMode'), 'standard');
  });
});
