// Shared dark-theme tooltip primitive used across dashboard panels.

import { useEffect, useRef, useState } from 'react';

export function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  const [touched, setTouched] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'top' | 'bottom' }>({ top: 0, left: 0, placement: 'top' });

  const updatePos = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const tooltipW = 256;
      const tooltipHEstimate = 80;
      let left = rect.left + rect.width / 2;
      left = Math.max(tooltipW / 2 + 8, Math.min(left, window.innerWidth - tooltipW / 2 - 8));
      const placement: 'top' | 'bottom' = rect.top - tooltipHEstimate - 8 < 0 ? 'bottom' : 'top';
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
          className={`fixed -translate-x-1/2 ${pos.placement === 'top' ? '-translate-y-full' : ''} px-3 py-2 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-300 whitespace-normal break-words w-64 z-[100] shadow-lg pointer-events-none`}
          style={{
            top: pos.top,
            left: pos.left,
            textTransform: 'none',
            textAlign: 'center',
            letterSpacing: 'normal',
            fontWeight: 'normal',
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
