// Synthetic native UI check. Never imported by the production entry.
import React, {useState} from 'react';
import {registerRootComponent} from 'expo';
import {Linking,ScrollView,View} from 'react-native';
import {Text} from 'react-native-paper';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {UIProvider,Button,SettingsRow,useUI} from '../../src/ui';
import {AppFrame,ScreenHeader} from '../../src/AppNavigation';
import {LoadingProvider,useLoading} from '../../src/LoadingOverlay';
import ReviewRequest,{RateMeroSplit} from '../../src/ReviewRequest';
import {nativeReviewModule} from '../../src/storeReviewPlatform';
import {notifyReviewAction,initialReviewState,reviewDay} from '../../src/reviewPolicy';
import {updateReviewPreferences} from '../../src/reviewPreferences';
let opened:string[]=[];let fail=false;
Linking.openURL=async url=>{opened.push(url);if(fail)throw Error('Synthetic store error');};
function Probe(){const {ui,changeColorFamily,changeAppearance}=useUI();const[loading,setLoading]=useState(false),[result,setResult]=useState('Ready');useLoading(loading);
 async function legacy(){
  if(nativeReviewModule())throw Error('This fixture expects build 32');
  opened=[];const realNow=Date.now;const now=realNow();
  await updateReviewPreferences(state=>Object.assign(state,{...initialReviewState(now-8*reviewDay),sessions:3,settlement:true}));
  Date.now=()=>realNow()+35_000;
  notifyReviewAction('synthetic-review-qa',{group_id:'fixture',command_id:'review-fixture',method:'POST',path:'/groups/fixture/expenses',body:{id:'one'},state:'pending',error:null});
  setTimeout(()=>{void updateReviewPreferences(state=>{if(state.attempts.length||opened.length)throw Error('Legacy build consumed review quota or opened a store');}).then(()=>setResult('Legacy review safety passed'),cause=>setResult(String(cause))).finally(()=>{Date.now=realNow;});},3000);
 }
 return <AppFrame><ScreenHeader title="Me" busy={false}/><ScrollView contentContainerStyle={{padding:16,gap:12}}><SettingsRow icon="edit" label="Name" value="Om Shejul" onPress={()=>{}}/><RateMeroSplit disabled={false}/><SettingsRow external icon="privacy" label="Privacy" onPress={()=>{}}/>
 <Text style={ui.caption}>{result}</Text><Button title="Show loading" onPress={()=>{setLoading(true);setTimeout(()=>setLoading(false),4000);}}/>
 <Button title="Check opened store" onPress={()=>setResult(opened.length===1&&opened[0]==='market://details?id=com.omshejul.splitdumb&showAllReviews=true'?'Review link passed':JSON.stringify(opened))}/>
 <Button title="Simulate store failure" onPress={()=>{fail=true;opened=[];setResult('Failure enabled');}}/><Button title="Restore store" onPress={()=>{fail=false;opened=[];setResult('Store restored');}}/>
 <Button title="Verify legacy review safety" onPress={()=>void legacy().catch(cause=>setResult(String(cause)))}/>
 <Button title="Use light" onPress={()=>{void changeColorFamily('basic');void changeAppearance('light');}}/><Button title="Use dark" onPress={()=>{void changeColorFamily('obsidian');void changeAppearance('dark');}}/>
 </ScrollView><ReviewRequest owner="synthetic-review-qa" groupId="fixture" foreground eligible/></AppFrame>;
}
registerRootComponent(()=><SafeAreaProvider><UIProvider><LoadingProvider><Probe/></LoadingProvider></UIProvider></SafeAreaProvider>);
