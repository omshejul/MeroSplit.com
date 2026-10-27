import React, { useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import { Text } from 'react-native-paper';
import type { PickedMedia } from './media';
import { mediaSize } from './media';
import { localMediaUrl, clearLocalMediaUrl, openLocalMedia } from './mediaPlatform';
import { Button, Icon, useUI } from './ui';

// The same private, local preview is used by bill drafts and pending uploads.
export default function LocalAttachment({ file, disabled, onError }: { file: PickedMedia; disabled: boolean; onError: (message: string) => void }) {
  const { ui, palette } = useUI(), [uri, setUri] = useState('');
  useEffect(() => {
    let active = true, resolved = '';
    setUri('');
    void localMediaUrl(file).then(value => { resolved = value; if (active) setUri(value); else clearLocalMediaUrl(value); }).catch(() => { if (active) onError('Could not load the saved file.'); });
    return () => { active = false; if (resolved) clearLocalMediaUrl(resolved); };
  }, [file.uri]);
  const pdf = file.type === 'application/pdf';
  return <Button kind="plain" accessibilityRole="button" accessibilityLabel={`Preview ${file.name}`} disabled={disabled || !uri} onPress={() => void openLocalMedia(file, uri).catch(() => onError('Could not preview this file. Try again.'))} style={[ui.row, { gap: 12 }]}>
    {uri && !pdf ? <Image source={{ uri }} style={{ width: 56, height: 56, borderRadius: 8 }} accessibilityLabel={file.name} onError={() => onError('Could not load the photo preview.')} />
      : <View style={{ width: 56, height: 56, backgroundColor: palette.soft, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }}><Icon name="bill" /><Text style={ui.caption}>{pdf ? 'PDF' : 'Photo'}</Text></View>}
    <View style={ui.rowBody}><Text style={ui.body} numberOfLines={1}>{file.name}</Text><Text style={ui.caption}>{mediaSize(file.size)} · Tap to preview</Text></View><Icon name="next" size={18} />
  </Button>;
}
