document.getElementById("open").addEventListener("click", () => {
  const url = chrome.runtime.getURL("editor.html");
  chrome.tabs.create({ url });
  window.close();
});
