import React, { useEffect, useRef, useState } from 'react';
import { Text, useWindowDimensions } from 'react-native';
import KeyboardDialog from './KeyboardDialog';
import { Dialog, DialogScrollBody } from './DialogParts';
import { Button, ErrorText, useUI } from './ui';
import type { PickedMedia } from './media';

export function cropBounds(width: number, height: number, zoom: number, x: number, y: number) {
  const edge = Math.min(width, height) / zoom;
  return { edge, x: (width - edge) * (Math.max(-1, Math.min(1, x)) + 1) / 2, y: (height - edge) * (Math.max(-1, Math.min(1, y)) + 1) / 2 };
}
export default function ProfilePhotoCrop({ file, onDone }: { file: PickedMedia; onDone: (file: PickedMedia | null) => void }) {
  const { height } = useWindowDimensions();
  const { ui, palette } = useUI(), canvas = useRef<HTMLCanvasElement>(null), image = useRef<HTMLImageElement | null>(null), pointer = useRef<{ x: number; y: number } | null>(null), alive = useRef(true);
  const [ready, setReady] = useState(false), [error, setError] = useState(''), [working, setWorking] = useState(false), [position, setPosition] = useState({ x: 0, y: 0, zoom: 1 });
  useEffect(() => {
    alive.current = true; const selected = new window.Image();
    selected.onload = () => { if (alive.current) { image.current = selected; setReady(true); } };
    selected.onerror = () => { if (alive.current) setError('Could not read this photo. Cancel and choose another.'); }; selected.src = file.uri;
    return () => { alive.current = false; image.current = null; selected.onload = null; selected.onerror = null; };
  }, [file.uri]);
  useEffect(() => {
    const photo = image.current, context = canvas.current?.getContext('2d'); if (!photo || !context || !ready) return;
    const crop = cropBounds(photo.naturalWidth, photo.naturalHeight, position.zoom, position.x, position.y);
    context.fillStyle = '#fff'; context.fillRect(0, 0, 512, 512); context.drawImage(photo, crop.x, crop.y, crop.edge, crop.edge, 0, 0, 512, 512);
  }, [ready, position]);
  function save() {
    if (working || !ready || !canvas.current) return; setWorking(true); setError('');
    canvas.current.toBlob(blob => {
      if (!alive.current) return;
      if (!blob) { setWorking(false); setError('Could not prepare this photo. Try again.'); return; }
      onDone({ uri: URL.createObjectURL(blob), name: 'Profile photo.jpg', type: 'image/jpeg', size: blob.size });
    }, 'image/jpeg', 0.85);
  }
  return <KeyboardDialog visible onDismiss={() => onDone(null)} dismissable={!working}>
    <Dialog.Title>Crop photo</Dialog.Title>
    <DialogScrollBody maxHeight={Math.max(120, height - 240)} gap={12}>
      <canvas ref={canvas} width={512} height={512} role="img" tabIndex={0} aria-label="Photo crop preview. Drag to reposition, or use the arrow keys."
        style={{ width: 'min(100%, 300px)', alignSelf: 'center', aspectRatio: '1', objectFit: 'contain', background: palette.soft, touchAction: 'none', borderRadius: '33.333%' }}
        onPointerDown={event => { if (!ready || working) return; pointer.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); }}
        onPointerUp={() => { pointer.current = null; }} onPointerCancel={() => { pointer.current = null; }}
        onPointerMove={event => {
          const previous = pointer.current, photo = image.current; if (!previous || !photo || working) return;
          const rect = event.currentTarget.getBoundingClientRect(), edge = Math.min(photo.naturalWidth, photo.naturalHeight) / position.zoom;
          const dx = (event.clientX - previous.x) / rect.width * edge, dy = (event.clientY - previous.y) / rect.height * edge;
          pointer.current = { x: event.clientX, y: event.clientY };
          setPosition(value => ({ ...value, x: photo.naturalWidth > edge ? Math.max(-1, Math.min(1, value.x - dx * 2 / (photo.naturalWidth - edge))) : 0, y: photo.naturalHeight > edge ? Math.max(-1, Math.min(1, value.y - dy * 2 / (photo.naturalHeight - edge))) : 0 }));
        }}
        onKeyDown={event => { if (working || !ready || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); setPosition(value => ({ ...value, x: Math.max(-1, Math.min(1, value.x + (event.key === 'ArrowLeft' ? -0.1 : event.key === 'ArrowRight' ? 0.1 : 0))), y: Math.max(-1, Math.min(1, value.y + (event.key === 'ArrowUp' ? -0.1 : event.key === 'ArrowDown' ? 0.1 : 0))) })); }} />
      <Text style={ui.caption}>{ready ? 'Drag to position your photo.' : 'Opening photo…'}</Text>
      <label style={{ color: palette.text, fontFamily: 'inherit' }}>Zoom<input aria-label="Photo zoom" type="range" min={1} max={3} step={0.05} value={position.zoom} disabled={!ready || working} onChange={event => setPosition(value => ({ ...value, zoom: Number(event.target.value) }))} style={{ width: '100%', accentColor: palette.accent }} /></label>
      {!!error && <ErrorText>{error}</ErrorText>}
    </DialogScrollBody>
    <Dialog.Actions><Button title="Cancel" kind="text" disabled={working} onPress={() => onDone(null)} /><Button title={working ? 'Preparing photo…' : 'Use photo'} kind="primary" disabled={!ready || working} onPress={save} /></Dialog.Actions>
  </KeyboardDialog>;
}
