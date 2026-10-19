// The bookmarklet, before it's minified into a `javascript:` URL by the
// build. `__BASE_URL__` is replaced with where toolbox.js is served from.
//
// - Toolbox already on the page: toggle it, never load a second copy.
// - Script tag already there (still loading): do nothing.
// - Otherwise add one script tag, and explain if it fails (usually the
//   page's Content Security Policy refusing outside scripts).
(() => {
  const w = window;
  if (w.__prototypeToolbox) {
    w.__prototypeToolbox.toggle();
    return;
  }
  if (
    w.__prototypeToolboxLoading ||
    document.querySelector('script[data-prototype-toolbox-script]')
  )
    return;
  w.__prototypeToolboxLoading = true;
  let script;
  let timer;
  const fail = (why) => {
    clearTimeout(timer);
    w.__prototypeToolboxLoading = false;
    if (script) script.remove();
    alert(`Prototype toolbox couldn't load on this page. ${why}`);
  };
  const blocked =
    "This site's Content Security Policy probably blocks scripts from other sites.";
  try {
    script = document.createElement('script');
    script.setAttribute('data-prototype-toolbox-script', '');
    script.onerror = () => fail(blocked);
    script.onload = () => {
      clearTimeout(timer);
      if (!w.__prototypeToolbox) fail(blocked);
    };
    timer = setTimeout(() => {
      if (!w.__prototypeToolbox) fail('It took too long to load.');
    }, 15000);
    // Cache-busted hourly, so a deploy reaches everyone within the hour.
    script.src = `${__BASE_URL__}/toolbox.js?h=${Math.floor(Date.now() / 36e5)}`;
    (document.head || document.documentElement).append(script);
  } catch (error) {
    fail(error && error.name === 'TypeError' ? blocked : String(error));
  }
})();
