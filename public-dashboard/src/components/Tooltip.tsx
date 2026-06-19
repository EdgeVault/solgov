// Shared dark-theme tooltip primitive used across dashboard panels.

import { useEffect, useRef, useState } from 'react';

export function Tooltip({ text, children, align = 'center' }: { text: string; children: React.ReactNode; align?: 'center' | 'left' }) {
  const [show, setShow] = useState(false);
  const [touched, setTouched] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'top' | 'bottom' }>({ top: 0, left: 0, placement: 'top' });

  const updatePos = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const tooltipW = 256;
      // Estimate height from the line count so tall multi-line tooltips (e.g. the per-multisig
      // benchmark) flip below instead of overflowing the top of the viewport.
      const lineCount = (text.match(/\n/g)?.length ?? 0) + 1;
      const tooltipHEstimate = Math.max(80, lineCount * 20 + 24);
      let left = rect.left + rect.width / 2;
      left = Math.max(tooltipW / 2 + 8, Math.min(left, window.innerWidth - tooltipW / 2 - 8));
      const spaceAbove = rect.top - 8;
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      // Prefer above when it fits; otherwise use whichever side has more room.
      const placement: 'top' | 'bottom' = spaceAbove >= tooltipHEstimate ? 'top' : (spaceBelow >= spaceAbove ? 'bottom' : 'top');
      const top = placement === 'top' ? rect.top - 8 : rect.bottom + 8;
      setPos({ top, left, placement });
    }
  };

  useEffect(() => {
    if (!touched || !show) return;
    const handler = (e: TouchEvent | MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setShow(false);
        setTouched(false);
      }
    };
    document.addEventListener('touchstart', handler);
    document.addEventListener('mousedown', handler);
    return () => {
      document.removeEventListener('touchstart', handler);
      document.removeEventListener('mousedown', handler);
    };
  }, [touched, show]);

  return (
    <span
      ref={ref}
      className="inline-flex items-center"
      onMouseEnter={() => { if (!touched) { updatePos(); setShow(true); } }}
      onMouseLeave={() => { if (!touched) setShow(false); }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a, button')) return;
        e.stopPropagation(); e.preventDefault(); updatePos(); setTouched(true); setShow(s => !s);
      }}
      onTouchEnd={(e) => {
        if ((e.target as HTMLElement).closest('a, button')) return;
        e.stopPropagation(); e.preventDefault(); updatePos(); setTouched(true); setShow(s => !s);
      }}
    >
      {children}
      {show && (
        <span
          className={`fixed -translate-x-1/2 ${pos.placement === 'top' ? '-translate-y-full' : ''} px-3 py-2 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-300 whitespace-pre-line break-words w-64 z-[100] shadow-lg pointer-events-none`}
          style={{
            top: pos.top,
            left: pos.left,
            textTransform: 'none',
            textAlign: align,
            letterSpacing: 'normal',
            fontWeight: 'normal',
            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
            overflowWrap: 'anywhere',
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

export function InfoIcon() {
  return <span className="ml-1 text-gray-600 cursor-help text-[10px]">&#9432;</span>;
}
