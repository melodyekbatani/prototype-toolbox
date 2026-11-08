import React from 'react';
import { writeClipboard } from './dom';

export function useClipboard() {
  const [status, setStatus] = React.useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const timer = React.useRef<ReturnType<typeof setTimeout>>();
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (text: string) => {
    clearTimeout(timer.current);
    setStatus('copying');
    const ok = await writeClipboard(text);
    setStatus(ok ? 'copied' : 'failed');
    if (ok) timer.current = setTimeout(() => setStatus('idle'), 2000);
    return ok;
  };
  return { copy, label: (idle: string) => ({ idle, copying: 'Copying…', copied: 'Copied', failed: 'Copy failed · retry' })[status] };
}
