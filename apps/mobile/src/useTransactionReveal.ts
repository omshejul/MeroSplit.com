import { useEffect, useRef, useState } from 'react';
import type { FlatList } from 'react-native';
import type { GroupTransaction } from './types';
import { transactionLiftTiming } from './motionShared';

// FlatList can only center a measured cell. For a distant record, approach its
// estimated position first, then center the actual cell once it is mounted.
export function useTransactionReveal(list: React.RefObject<FlatList<GroupTransaction> | null>, key: string | undefined, index: number, ready: boolean, animated: boolean, request = key) {
  const [highlight, setHighlight] = useState('');
  const failed = useRef<(average: number) => void>(() => {});
  const stop = useRef(() => {});
  const settled = useRef(() => {});
  const visible = useRef<string[]>([]);
  const completed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!key || index < 0 || !ready || completed.current === request) return;
    let scrolling = false;
    let timer: ReturnType<typeof setTimeout>;
    const cancel = () => {
      clearTimeout(timer);
      scrolling = false;
      completed.current = request;
    };
    const finish = () => {
      if (!scrolling || !visible.current.includes(key)) return;
      cancel();
      setHighlight(key);
      const { rise, hold, return: settle } = transactionLiftTiming;
      timer = setTimeout(() => setHighlight(''), rise + hold + settle);
    };
    settled.current = () => {
      if (!scrolling) return;
      clearTimeout(timer);
      timer = setTimeout(() => visible.current.includes(key) ? finish() : center(), 160);
    };
    const center = () => {
      scrolling = true;
      timer = setTimeout(() => visible.current.includes(key) ? finish() : center(), 750);
      list.current?.scrollToIndex({ index, viewPosition: 0.5, animated });
    };
    failed.current = average => {
      clearTimeout(timer);
      scrolling = false;
      list.current?.scrollToOffset({ offset: Math.max(0, average * index), animated });
      timer = setTimeout(center, animated ? 650 : 80);
    };
    stop.current = () => { cancel(); setHighlight(''); };
    timer = setTimeout(center, animated ? 350 : 30);
    return () => {
      clearTimeout(timer);
      stop.current = settled.current = failed.current = () => {};
      setHighlight('');
    };
  }, [list, key, index, ready, animated, request]);
  return { highlight, visible, scrolled: () => settled.current(), cancel: () => stop.current(), failed: (info: { averageItemLength: number }) => failed.current(info.averageItemLength) };
}
