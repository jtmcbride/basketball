import { useCallback, useEffect, useRef, useState } from "react";
import { advanceComparison } from "./analysis";
export function useComparison(start: number, end: number, barriers: number[]) {
  const [time, setTime] = useState(start),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1),
    [pausedAtBreak, setPausedAtBreak] = useState(false);
  const current = useRef(start),
    running = useRef(false);
  const pause = useCallback(() => {
    running.current = false;
    setPlaying(false);
  }, []);
  const seek = useCallback(
    (value: number) => {
      pause();
      setPausedAtBreak(false);
      current.current = Math.max(start, Math.min(end, value));
      setTime(current.current);
    },
    [start, end, pause],
  );
  const toggle = () => {
    if (running.current) {
      pause();
      return;
    }
    if (current.current >= end) {
      current.current = start;
      setTime(start);
    }
    setPausedAtBreak(false);
    running.current = true;
    setPlaying(true);
  };
  useEffect(() => {
    if (!playing) return;
    const origin = current.current,
      wall = performance.now();
    let animation = 0;
    const tick = (now: number) => {
      if (!running.current) return;
      const next = advanceComparison(
        current.current,
        origin + (now - wall) * speed,
        barriers,
        end,
      );
      current.current = next.time;
      setTime(next.time);
      if (next.pausedAtBreak || next.ended) {
        pause();
        setPausedAtBreak(next.pausedAtBreak);
        return;
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing, speed, barriers, end, pause]);
  useEffect(() => {
    const hide = () => {
      if (document.hidden) pause();
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [pause]);
  return { time, playing, speed, setSpeed, toggle, pause, seek, pausedAtBreak };
}
