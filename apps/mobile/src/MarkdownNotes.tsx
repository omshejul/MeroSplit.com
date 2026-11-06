import React, { useMemo, useState } from 'react';
import { Linking, Platform, ScrollView, View, useWindowDimensions } from 'react-native';
import { Text } from 'react-native-paper';
import type { Token, Tokens } from 'marked';
import { markdownText, noteLink, parseNotes } from './markdown';
import { ErrorText, useUI } from './ui';

export default function MarkdownNotes({ source }: { source: string }) {
  const { ui, palette } = useUI(), { fontScale } = useWindowDimensions();
  const tokens = useMemo(() => parseNotes(source), [source]);
  const [error, setError] = useState('');
  const codeStyle = { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', backgroundColor: palette.soft };
  async function open(href: string) {
    setError('');
    try { await Linking.openURL(href); } catch { setError('Could not open this link. Try again.'); }
  }
  function inline(values: Token[] = []): React.ReactNode {
    return values.map((token, key) => {
      const children = 'tokens' in token && token.tokens ? inline(token.tokens) : token.type === 'text' ? markdownText(token.raw) : 'text' in token ? token.text : '';
      switch (token.type) {
        case 'strong': return <Text key={key} style={{ fontWeight: '600' }}>{children}</Text>;
        case 'em': return <Text key={key} style={{ fontStyle: 'italic' }}>{children}</Text>;
        case 'del': return <Text key={key} style={{ textDecorationLine: 'line-through' }}>{children}</Text>;
        case 'codespan': return <Text key={key} style={codeStyle}>{token.text}</Text>;
        case 'br': return '\n';
        case 'link': {
          const href = noteLink(token.href);
          return href ? <Text key={key} accessibilityRole="link" accessibilityLabel={`${markdownText(token.text)}, ${href}`} onPress={() => void open(href)} style={{ color: palette.accent, textDecorationLine: 'underline' }}>{children}</Text> : <Text key={key}>{children}</Text>;
        }
        // Notes never load external images or execute embedded HTML.
        case 'html': return <Text key={key}>{token.raw}</Text>;
        case 'image': return <Text key={key}>{markdownText(token.text) || 'Image'}</Text>;
        default: return <Text key={key}>{children}</Text>;
      }
    });
  }
  function table(token: Tokens.Table, key: number) {
    const rows = [token.header, ...token.rows];
    const widths = token.header.map((_, column) => Math.min(240, Math.max(110, ...rows.map(row => row[column].text.length * 8 + 24))) * fontScale);
    return <ScrollView key={key} horizontal accessibilityLabel="Notes table, scroll horizontally for more columns" showsHorizontalScrollIndicator persistentScrollbar>
      <View role="table" style={{ borderWidth: 1, borderColor: palette.outline, borderRadius: 10, overflow: 'hidden' }}>
        {rows.map((row, r) => <View key={r} role="row" style={{ flexDirection: 'row', backgroundColor: r === 0 ? palette.soft : undefined }}>
          {row.map((cell, c) => <View key={c} role={r === 0 ? 'columnheader' : 'cell'} style={{ width: widths[c], padding: 10, borderTopWidth: r ? 1 : 0, borderLeftWidth: c ? 1 : 0, borderColor: palette.outline }}>
            <Text selectable style={[ui.body, { textAlign: token.align[c] ?? 'left', fontWeight: r === 0 ? '600' : '400' }]}>{inline(cell.tokens)}</Text>
          </View>)}
        </View>)}
      </View>
    </ScrollView>;
  }
  function blocks(values: Token[] = []): React.ReactNode {
    return values.map((token, key) => {
      switch (token.type) {
        case 'space': case 'def': case 'checkbox': return null;
        case 'heading': return <Text key={key} selectable accessibilityRole="header" aria-level={token.depth} style={[ui.body, { fontWeight: '600', fontSize: Math.max(16, 26 - token.depth * 2), lineHeight: Math.max(24, 34 - token.depth * 2) }]}>{inline(token.tokens)}</Text>;
        case 'paragraph': case 'text': return <Text key={key} selectable style={ui.body}>{token.tokens ? inline(token.tokens) : markdownText(token.raw)}</Text>;
        case 'blockquote': return <View key={key} style={{ gap: 8, borderLeftWidth: 3, borderColor: palette.outline, paddingLeft: 12 }}>{blocks(token.tokens)}</View>;
        case 'list': return <View key={key} style={{ gap: 6 }}>{token.items.map((item: Tokens.ListItem, i: number) => <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
          <Text style={ui.body} accessibilityLabel={item.task ? item.checked ? 'Completed' : 'Not completed' : undefined}>{item.task ? item.checked ? '☑' : '☐' : token.ordered ? `${Number(token.start) + i}.` : '•'}</Text>
          <View style={{ flex: 1, minWidth: 0, gap: 6 }}>{blocks(item.tokens)}</View>
        </View>)}</View>;
        case 'table': return table(token as Tokens.Table, key);
        case 'code': return <ScrollView key={key} horizontal accessibilityLabel="Code block"><Text selectable style={[ui.body, codeStyle, { padding: 12 }]}>{token.text}</Text></ScrollView>;
        case 'hr': return <View key={key} style={{ height: 1, backgroundColor: palette.outline }} />;
        default: return <Text key={key} selectable style={ui.body}>{token.raw}</Text>;
      }
    });
  }
  return <View style={{ gap: 10, minWidth: 0 }}>{blocks(tokens)}{!!error && <ErrorText live>{error}</ErrorText>}</View>;
}
