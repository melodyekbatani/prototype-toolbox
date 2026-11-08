/**
 * Names for page elements, for the tools' lists and their copied output.
 */

/**
 * The nearest React component that rendered the element, when the host page
 * is a React app (read from React's own fiber on the DOM node). Null on any
 * other page.
 */
export function componentName(el: Element) {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fiber = key ? (el as any)[key] : null;
  while (fiber) {
    const type = fiber.type;
    const name =
      typeof type === 'function'
        ? type.displayName || type.name
        : type && typeof type === 'object'
          ? type.displayName || type.render?.name
          : undefined;
    // Past Motion's own wrappers, to the component that drew it.
    if (name && !/^Motion/.test(name)) return name as string;
    fiber = fiber.return;
  }
  return null;
}

/** tag#id.class.class "text", keeping readable classes and skipping utility soup. */
export function describe(el: Element) {
  const classes = [...el.classList]
    .filter((c) => !/[:[\]/]/.test(c))
    .slice(0, 3);
  const id = el.id && /^[A-Za-z][\w-]*$/.test(el.id) ? `#${el.id}` : '';
  const full = el.textContent?.trim().replace(/\s+/g, ' ') ?? '';
  const text = full.slice(0, 32);
  return `${el.tagName.toLowerCase()}${id}${classes.map((c) => `.${c}`).join('')}${text ? ` "${text}${full.length > 32 ? '…' : ''}"` : ''}`;
}

/** A CSS selector for the element by position, from the nearest plain id. */
export function pathTo(element: Element): string {
  const root = element.getRootNode();
  if (root instanceof ShadowRoot) {
    const steps: string[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.id) { steps.unshift(`#${CSS.escape(node.id)}`); break; }
      const siblings = node.parentElement?.children ?? root.children;
      steps.unshift(`:nth-child(${[...siblings].indexOf(node) + 1})`);
    }
    return `${pathTo(root.host)} >>> ${steps.join(' > ')}`;
  }
  const steps: string[] = [];
  let node: Element | null = element;
  while (node && node !== document.body) {
    // Generated ids change between loads, so only plain ones anchor.
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
      steps.unshift(`#${node.id}`);
      return steps.join(' > ');
    }
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    steps.unshift(`:nth-child(${[...parent.children].indexOf(node) + 1})`);
    node = parent;
  }
  return ['body', ...steps].join(' > ');
}

/** >>> marks an open shadow-root boundary in exported selectors. */
export function resolvePath(selector: string): Element | null {
  let root: Document | ShadowRoot = document;
  const parts = selector.split(' >>> ');
  for (let i = 0; i < parts.length; i++) {
    const element: Element | null = root.querySelector(parts[i]);
    if (!element) return null;
    if (i === parts.length - 1) return element;
    if (!element.shadowRoot) return null;
    root = element.shadowRoot;
  }
  return null;
}
