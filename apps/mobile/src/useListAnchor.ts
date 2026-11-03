import {useLayoutEffect,useRef} from 'react';
import type {FlatList,View} from 'react-native';
import type React from 'react';

type Node = React.ComponentRef<typeof View>;
// Preserve a visible record across inserted rows/header height changes. Dragging
// takes control away from an animated correction; reduced motion stays immediate.
export function useListAnchor<T>(list: React.RefObject<FlatList<T> | null>, revision: unknown, active: boolean, animate: boolean, scope?: unknown) {
 const nodes=useRef(new Map<string,Node>()), visible=useRef<string[]>([]), saved=useRef<{key:string;y:number}[]>([]);
 const offset=useRef(0), restoring=useRef(false), generation=useRef(0), timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const live=useRef(active);live.current=active;
 const capture=()=>{
  if(!live.current||restoring.current)return;
  const stamp=++generation.current;saved.current=[];
  for(const key of visible.current)nodes.current.get(key)?.measureInWindow((_x,y)=>{
   if(live.current&&!restoring.current&&stamp===generation.current)saved.current.push({key,y});
  });
 };
 useLayoutEffect(()=>{saved.current=[];visible.current=[];generation.current++;restoring.current=false;if(timer.current)clearTimeout(timer.current);},[scope]);
 useLayoutEffect(()=>{
  if(!active||!saved.current.length)return;
  const anchor=saved.current.find(value=>nodes.current.has(value.key));if(!anchor)return;
  const stamp=++generation.current;restoring.current=true;
  if(timer.current)clearTimeout(timer.current);
  let frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(()=>nodes.current.get(anchor.key)?.measureInWindow((_x,y)=>{
   if(!live.current||stamp!==generation.current)return;
   if(Math.abs(y-anchor.y)<1){restoring.current=false;capture();return;}
   list.current?.scrollToOffset({offset:Math.max(0,offset.current+y-anchor.y),animated:animate});
   if(timer.current)clearTimeout(timer.current);
   timer.current=setTimeout(()=>{restoring.current=false;capture();},600);
  }));});
  return ()=>{cancelAnimationFrame(frame);generation.current++;restoring.current=false;};
 },[revision,active,scope]);
 useLayoutEffect(()=>()=>{generation.current++;if(timer.current)clearTimeout(timer.current);},[]);
 return {
  rowRef:(key:string)=>(node:Node|null)=>{if(node)nodes.current.set(key,node);else nodes.current.delete(key);},
  viewable:(keys:string[])=>{visible.current=keys;capture();},
  scrolled:(y:number)=>{if(!live.current)return;offset.current=y;capture();},
  dragging:()=>{restoring.current=false;generation.current++;if(timer.current)clearTimeout(timer.current);capture();},
 };
}
