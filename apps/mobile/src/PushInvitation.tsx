import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, TextInput } from 'react-native';
import { Text } from 'react-native-paper';
import { claimPushInvitation } from './native';
import { request } from './api';
import type { Session } from './types';
import type { PushControls } from './PushSettings';
import KeyboardDialog from './KeyboardDialog';
import { Dialog } from './DialogParts';
import { Button, useUI } from './ui';
import { useToast } from './Toast';

export default function PushInvitation({ owner, session, eligible, push, onVisibility }: {
  owner: string; session: Session; eligible: boolean; push: PushControls; onVisibility: (visible: boolean) => void;
}) {
  const { ui } = useUI(), toast = useToast();
  const [visible, setVisible] = useState(false), [keyboard, setKeyboard] = useState(() => Keyboard.isVisible());
  const requesting = useRef(false), mounted = useRef(true), offered = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setKeyboard(true));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboard(false));
    return () => { shown.remove(); hidden.remove(); };
  }, []);
  const allowed = Platform.OS !== 'web' && eligible && !keyboard && push.state.ready && !push.state.enabled
    && !push.state.optedIn && !push.state.pendingOff && !push.state.working && push.state.permission !== 'denied';
  useEffect(() => {
    if (!allowed) { setVisible(false); return; }
    if (offered.current) return;
    let stopped = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (Keyboard.isVisible() || TextInput.State.currentlyFocusedInput()) return;
      void request<{ expense_updates: boolean }>(session, '/me/notifications/preferences', 'GET', undefined, 'json', controller.signal).then(async preferences => {
        if (stopped || preferences.expense_updates !== true || Keyboard.isVisible() || TextInput.State.currentlyFocusedInput()) return;
        const first = await claimPushInvitation(owner);
        if (!stopped) { offered.current = true; if (first) setVisible(true); }
      }).catch(() => {});
    }, 400);
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [allowed, owner, session.token, session.baseUrl]);
  const show = allowed && visible;
  useEffect(() => { onVisibility(show); return () => onVisibility(false); }, [show, onVisibility]);
  async function enable() {
    if (!mounted.current || !show || requesting.current) return;
    requesting.current = true; setVisible(false);
    try { await push.enable(); }
    catch { if (mounted.current) toast('Could not enable notifications. Try again in Me → Notifications.'); }
    finally { requesting.current = false; }
  }
  return <KeyboardDialog visible={show} onDismiss={() => setVisible(false)}>
    <Dialog.Title>Stay updated on shared bills?</Dialog.Title>
    <Dialog.Content><Text style={ui.body}>Get notified when someone adds a shared bill or messages you.</Text></Dialog.Content>
    <Dialog.Actions style={{ flexWrap: 'wrap' }}><Button title="Not now" kind="text" onPress={() => setVisible(false)} /><Button title="Turn on notifications" kind="primary" style={{ flexShrink: 1 }} onPress={() => { void enable(); }} /></Dialog.Actions>
  </KeyboardDialog>;
}
