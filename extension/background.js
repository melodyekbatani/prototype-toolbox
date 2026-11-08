// activeTab grants access after a toolbar click or shortcut. All code is local.
const busy = new Set();
async function toggle(tab) {
  if (tab?.id === undefined || busy.has(tab.id)) return;
  busy.add(tab.id);
  try {
    if (!/^(https?|file):/.test(tab.url ?? '')) {
      throw new Error('Open a regular website first. Browser settings, the new-tab page, and other protected pages cannot be edited.');
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['toolbox.js'], world: 'ISOLATED' });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'ISOLATED',
      func: () => {
        const api = window.__prototypeToolbox;
        if (!api?.host?.isConnected) throw new Error('The toolbox did not mount. Reload this page and try again.');
        return api.isOpen();
      },
    });
    await chrome.action.setPopup({ tabId: tab.id, popup: '' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: result ? 'ON' : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#11664f' });
    await chrome.action.setTitle({ tabId: tab.id, title: result ? 'Hide Prototype Toolbox' : 'Open Prototype Toolbox' });
  } catch (error) {
    const raw = String(error?.message ?? error);
    const message = /Cannot access|extensions gallery|Missing host permission/i.test(raw)
      ? 'This page is protected by the browser or your organization. Try a regular website. For local files, enable “Allow access to file URLs” in extension settings.' : raw;
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#a52a2a' });
    await chrome.action.setTitle({ tabId: tab.id, title: message });
    await chrome.action.setPopup({ tabId: tab.id, popup: 'error.html' });
    await chrome.action.openPopup().catch(() => {});
  } finally { busy.delete(tab.id); }
}
chrome.action.onClicked.addListener(toggle);
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') {
    chrome.action.setBadgeText({ tabId, text: '' });
    chrome.action.setPopup({ tabId, popup: '' });
    chrome.action.setTitle({ tabId, title: 'Open Prototype Toolbox' });
  }
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.url !== chrome.runtime.getURL('error.html') || message?.type !== 'retry') return;
  chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => { await toggle(tab); respond({ done: true }); });
  return true;
});
