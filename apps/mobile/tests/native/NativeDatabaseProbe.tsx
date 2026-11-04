// Synthetic native storage verification. Never imported by the production app.
import React, { useEffect, useState } from 'react';
import { registerRootComponent } from 'expo';
import * as SQLite from 'expo-sqlite';
import * as SplashScreen from 'expo-splash-screen';
import { File, Paths } from 'expo-file-system';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { UIProvider, useUI, Button } from '../../src/ui';
import { getDatabase } from '../../src/native';
import { saveDraft, readDraft } from '../../src/storage';
const owner = 'synthetic-native-database-lock-qa';
function check(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function Probe() {
  const { ui, palette } = useUI(), [status, setStatus] = useState('Ready'), [restored, setRestored] = useState('');
  useEffect(() => { void SplashScreen.hideAsync(); void restore(); }, []);
  async function restore() {
    const db = await getDatabase(), saved = await readDraft<{ writes: number }>(db, owner, 'persisted');
    setRestored(saved?.writes === 81 ? 'Saved work restored' : 'No prior test save');
  }
  async function run() {
    setStatus('Checking storage…');
    let control: SQLite.SQLiteDatabase | undefined, external: SQLite.SQLiteDatabase | undefined;
    try {
      control = await SQLite.openDatabaseAsync('merosplit-lock-control.db', { useNewConnection: true });
      await control.execAsync('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS control(n INTEGER);');
      let enter!: () => void, release!: () => void;
      const started = new Promise<void>(done => { enter = done; }), held = new Promise<void>(done => { release = done; });
      const locked = control.withExclusiveTransactionAsync(async tx => { await tx.runAsync('INSERT INTO control VALUES(1)'); enter(); await held; });
      await started;
      const oldError = await control.runAsync('INSERT INTO control VALUES(2)').then(() => '', error => String(error.message));
      release(); await locked;
      check(/database is locked|Error code 5/i.test(oldError), 'Old native collision was not reproduced');
      await control.closeAsync(); control = undefined;
      const db = await getDatabase(), key = String(Date.now());
      let enterSave!: () => void, releaseSave!: () => void;
      const saving = new Promise<void>(done => { enterSave = done; }), pause = new Promise<void>(done => { releaseSave = done; });
      const rolledBack = db.withExclusiveTransactionAsync(async tx => { await saveDraft(tx, owner, key + '-inside', {}); enterSave(); await pause; throw Error('Synthetic rollback'); }).catch(error => error);
      await saving;
      const outside = saveDraft(db, owner, key + '-outside', { kept: true });
      await delay(20); releaseSave(); await rolledBack; await outside;
      check(await readDraft(db, owner, key + '-inside') === null, 'Rolled back draft leaked');
      check((await readDraft<{ kept: boolean }>(db, owner, key + '-outside'))?.kept, 'Concurrent draft was lost');
      await db.execAsync('CREATE TABLE IF NOT EXISTS native_lock_qa(id TEXT PRIMARY KEY,n INTEGER NOT NULL)');
      await db.runAsync('INSERT INTO native_lock_qa VALUES(?,0)', key);
      let callbacks = 0;
      await Promise.all(Array.from({ length: 80 }, (_, i) => i % 2 ? db.runAsync('UPDATE native_lock_qa SET n=n+1 WHERE id=?', key) : db.withExclusiveTransactionAsync(async tx => { callbacks++; await tx.runAsync('UPDATE native_lock_qa SET n=n+1 WHERE id=?', key); await delay(2); })));
      external = await SQLite.openDatabaseAsync('splitdumb.db', { useNewConnection: true });
      await external.execAsync('BEGIN IMMEDIATE');
      const commit = new Promise<void>((done, fail) => { setTimeout(() => { void external!.execAsync('COMMIT').then(done, fail); }, 100); });
      await db.runAsync('UPDATE native_lock_qa SET n=n+1 WHERE id=?', key); await commit;
      const writes = (await db.getFirstAsync<{ n: number }>('SELECT n FROM native_lock_qa WHERE id=?', key))?.n;
      check(writes === 81 && callbacks === 40, 'Writes or callbacks were duplicated');
      await saveDraft(db, owner, 'persisted', { writes });
      new File(Paths.document, 'native-database-lock-results.json').write(JSON.stringify({ originalNativeCollisionReproduced: true, concurrentSavePreserved: true, rollbackIsolated: true, writes, callbacks, transientExternalLockRecovered: true }));
      await restore(); setStatus('Storage checks passed');
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { await control?.closeAsync(); await external?.closeAsync(); }
  }
  return <View style={{ flex: 1, padding: 24, paddingTop: 90, gap: 20, backgroundColor: palette.background }}><Text style={ui.section}>Native database checks</Text><Button title="Run storage checks" onPress={() => void run()} /><Text accessibilityRole="alert" style={ui.body}>{status}</Text><Text style={ui.caption}>{restored}</Text><Button title="Check saved work" onPress={() => void restore()} /></View>;
}
registerRootComponent(() => <SafeAreaProvider initialMetrics={initialWindowMetrics}><UIProvider><Probe /></UIProvider></SafeAreaProvider>);
