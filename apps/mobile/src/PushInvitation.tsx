import { useLoading } from './LoadingOverlay';
import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, TextInput } from 'react-native';
import { Text } from 'react-native-paper';
import { hasOpenDialogs } from './DialogFocus';
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
      if (hasOpenDialogs() || Keyboard.isVisible() || TextInput.State.currentlyFocusedInput()) return;
      void request<{ expense_updates: boolean }>(session, '/me/notifications/preferences', 'GET', undefined, 'json', controller.signal).then(async preferences => {
        if (stopped || preferences.expense_updates !== true || hasOpenDialogs() || Keyboard.isVisible() || TextInput.State.currentlyFocusedInput()) return;
        const first = await claimPushInvitation(owner);
        if (!stopped) { offered.current = true; if (first) setVisible(true); }
      }).catch(() => {});
    }, 1000);
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [allowed, owner, session.token, session.baseUrl]);
  const show = allowed && visible;
  useEffect(() => { onVisibility(show); return () => onVisibility(false); }, [show, onVisibility]);
  const [enabling, setEnabling] = useState(false);
  useLoading(enabling);
  async function enable() {
    if (!mounted.current || !show || requesting.current) return;
    requesting.current = true; setEnabling(true); setVisible(false);
    try { if (!await push.enable() && mounted.current) toast('Notifications are off. You can turn them on in Me → Notifications.'); }
    catch { if (mounted.current) toast('Could not enable notifications. Try again in Me → Notifications.'); }
    finally { requesting.current = false; if (mounted.current) setEnabling(false); }
  }
  return <KeyboardDialog label="Push notifications" visible={show} onDismiss={() => setVisible(false)}>
    <Dialog.Title>Get notified about shared bills?</Dialog.Title>
    <Dialog.Content><Text style={ui.body}>Get alerts when someone adds a shared bill or sends you a message.</Text></Dialog.Content>
    <Dialog.Actions style={{ flexWrap: 'wrap' }}><Button title="Not now" kind="text" onPress={() => setVisible(false)} /><Button title="Turn on notifications" kind="primary" style={{ flexShrink: 1 }} onPress={() => { void enable(); }} /></Dialog.Actions>
  </KeyboardDialog>;
}
