import { useCallback, useEffect, useRef, useState } from 'react';
import type { TrackingFrame } from '../types';
import { advance } from './timeline';

export function usePlayback(frames: TrackingFrame[]) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [pausedAtBreak, setPausedAtBreak] = useState(false);
  const current = useRef(0);
  const running = useRef(false);
  const seek = useCallback((next: number) => {
    running.current = false;
    setPlaying(false);
    setPausedAtBreak(false);
    current.current = Math.max(0, Math.min(frames.length - 1, next));
    setIndex(current.current);
  }, [frames.length]);
  const pause = useCallback(() => { running.current = false; setPlaying(false); }, []);
  const toggle = useCallback(() => {
    setPausedAtBreak(false);
    if (running.current) { pause(); return; }
    if (current.current === frames.length - 1) { current.current = 0; setIndex(0); }
    running.current = true;
    setPlaying(true);
  }, [frames.length, pause]);
  useEffect(() => {
    if (!playing) return;
    const origin = frames[current.current].elapsed_s;
    const start = performance.now();
    let animation = 0;
    const tick = (now: number) => {
      if (!running.current) return;
      const next = advance(frames, current.current, origin + (now - start) / 1000 * speed);
      if (current.current !== next.index) { current.current = next.index; setIndex(next.index); }
      if (next.stoppedAtBreak || next.ended) {
        running.current = false;
        setPlaying(false);
        setPausedAtBreak(next.stoppedAtBreak);
        return;
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [frames, playing, speed]);
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [pause]);
  return { index, playing, speed, setSpeed, seek, toggle, pause, pausedAtBreak };
}
