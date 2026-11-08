const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
if (tab?.id !== undefined) document.querySelector('#reason').textContent = await chrome.action.getTitle({ tabId: tab.id });
document.querySelector('#retry').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'retry' });
  window.close();
});
