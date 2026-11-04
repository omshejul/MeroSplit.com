import React, { useEffect, useRef, useState } from 'react';
import { AppState, Keyboard, Platform, TextInput } from 'react-native';
import { hasOpenDialogs } from './DialogFocus';
import { subscribeReviewActions, successfulReviewAction } from './reviewPolicy';
import { beginReviewSession, claimReviewRequest, updateReviewPreferences } from './reviewPreferences';
import { nativeReviewModule, openStoreReview } from './storeReviewPlatform';
import { ErrorText, SettingsRow } from './ui';

export default function ReviewRequest({ owner, groupId, foreground, eligible, interaction }: { interaction?: React.RefObject<number>; owner: string; groupId: string | null; foreground: boolean; eligible: boolean }) {
  const [opportunity, setOpportunity] = useState(''), sessionStart = useRef(Date.now()), current = useRef({ owner, groupId, foreground, eligible });
  current.current = { owner, groupId, foreground, eligible };
  useEffect(() => {
    if (Platform.OS === 'web' || !owner || !foreground) return;
    sessionStart.current = Date.now();
    void beginReviewSession().catch(() => {});
  }, [owner, foreground]);
  useEffect(() => {
    if (Platform.OS === 'web' || !owner) return;
    return subscribeReviewActions((account, command) => {
      if (account !== owner) return;
      const kind = successfulReviewAction(command);
      void updateReviewPreferences(state => {
        if (kind === 'settlement') state.settlement = true;
        else if (kind === 'expense' && state.expenses.length < 5) {
          const id = `${command.group_id}/${command.body.id}`;
          if (!state.expenses.includes(id)) state.expenses.push(id);
        }
      }).then(() => { if (current.current.owner === account && current.current.foreground) setOpportunity(command.group_id); }).catch(() => {});
    });
  }, [owner]);
  useEffect(() => {
    if (Platform.OS === 'web' || !eligible || !foreground || !opportunity || opportunity !== groupId) return;
    let stopped = false;
    const activity = interaction?.current;
    const safe = () => !stopped && interaction?.current === activity && current.current.owner === owner && current.current.groupId === groupId && current.current.eligible && current.current.foreground
      && AppState.currentState === 'active' && Date.now() - sessionStart.current >= 30_000 && !hasOpenDialogs() && !Keyboard.isVisible() && !TextInput.State.currentlyFocusedInput();
    const timer = setTimeout(() => {
      void (async () => {
        if (!safe()) return;
        const native = nativeReviewModule();
        if (!native || !await native.isAvailableAsync() || !safe()) return;
        if (!await claimReviewRequest() || !safe()) return;
        setOpportunity('');
        await native.requestReview();
        // The stores do not report whether a dialog appeared or a review was submitted.
      })().catch(() => {});
    }, 2000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [owner, groupId, eligible, foreground, opportunity]);
  return null;
}

export function RateMeroSplit({ disabled }: { disabled: boolean }) {
  const [opening, setOpening] = useState(false), [error, setError] = useState(''), inFlight = useRef(false);
  if (Platform.OS === 'web') return null;
  async function open() {
    if (disabled || inFlight.current) return;
    inFlight.current = true; setOpening(true); setError('');
    try { await claimReviewRequest(true).catch(() => {}); await openStoreReview(); }
    catch { setError("Couldn't open the store. Try again."); }
    finally { inFlight.current = false; setOpening(false); }
  }
  return <><SettingsRow external label="Rate MeroSplit" icon="thumbsUp" value={opening ? 'Opening…' : undefined} disabled={disabled || opening} onPress={() => void open()} />{error && <ErrorText live>{error}</ErrorText>}</>;
}
