import { readFileSync } from 'node:fs';
import ts from 'typescript';

const files = ['ListRow', 'PersonRow', 'PersonChoice', 'ChoiceGroup', 'UIStates', 'PaginationFooter', 'AttachmentPicker', 'AttachmentRow', 'MediaPreviewFrame', 'OverflowMenu', 'AppLogo', 'ResendControls', 'FallbackTabLayout', 'BillSummary', 'FloatingActionContainer', 'FieldDialog'];
const programs = [...files, 'SignInMethods'].map(name => {
  const source = ts.createSourceFile(name + '.tsx', readFileSync(new URL(`../src/${name}.tsx`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const statements = source.statements.filter(n => !ts.isImportDeclaration(n) && !ts.isExportDeclaration(n) && (name !== 'SignInMethods' || ts.isFunctionDeclaration(n) && n.name?.text === 'ConnectedProviderRow'));
  const names = statements.flatMap(n => ts.isFunctionDeclaration(n) && n.name ? [n.name.text] : ts.isVariableStatement(n) ? n.declarationList.declarations.filter(d => ts.isIdentifier(d.name)).map(d => d.name.getText(source)) : []);
  const body = statements.map(n => n.getText(source).replace(/^export (?:default )?/, '')).join('\n');
  return { names, build: new Function('env', `with(env){${ts.transpile(body, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React })};return {${names.join(',')}};}`) };
});

// The existing screen tests substitute native hosts. Resolve extracted production
// components through the same host/hook environment instead of copying their JSX.
export function withSharedUI<T extends Record<string, any>>(input: T): T & Record<string, any> {
  if (input) (input as Record<string, any>).startLoading ??= () => () => {};
  if (!input?.React?.createElement || input.__sharedUI) return input;
  const env: Record<string, any> = input; env.__sharedUI = true;
  for (const name of ['RowGroup', 'PeopleSheet', 'View', 'Text', 'Switch', 'Button', 'ErrorText', 'Avatar', 'Icon', 'TextField', 'EmailField', 'RadioChoice', 'SectionHeading', 'DialogScrollBody', 'CancelDialogActions', 'BottomSafeArea', 'ScrollBottomInset', 'ActivityIndicator']) env[name] ??= name;
  if (env.TextField === 'TextField' && input.TextInput) env.TextField = input.TextInput;
  env.useLoading ??= () => () => {}; env.startLoading ??= () => () => {}; env.LoadingOverlay ??= 'LoadingOverlay';
  env.useRowDivider ??= (divider?: boolean) => divider ?? true; env.animateLayout ??= () => {};
  env.StyleSheet ??= { hairlineWidth: 1, create: (value: any) => value };
  env.pageWidthStyle ??= {}; env.radii ??= { control: 12, surface: 16 }; env.Platform ??= { OS: 'native' };
  const shared = new Set<Function>(), original = input.React.createElement;
  env.React = { ...input.React, Fragment: input.React.Fragment ?? 'Fragment', createElement(type: any, props: any, ...children: any[]) {
    if (type === env.React.Fragment) return children.flat(Infinity);
    if (!children.length && props?.children !== undefined) children = [props.children];
    return shared.has(type) ? type({ ...props, children: children.length > 1 ? children : children[0] }) : original(type, type === env.ErrorText ? { accessibilityRole: 'alert', ...props } : props, ...children);
  } };
  const readUI = input.useUI ?? (() => ({}));
  env.useUI = () => { const value = readUI(); return { ...value, ui: { input: {}, ...value.ui }, palette: { ...value.palette } }; };
  Object.assign(env, { PersonDetailsFields: ({ name, email }: any) => env.React.createElement(env.React.Fragment, {}, env.React.createElement(env.TextField, name), env.React.createElement(env.EmailField, email)), UPIAddressField: (props: any) => env.React.createElement(env.TextField, { autoCorrect: false, autoCapitalize: 'none', autoComplete: 'off', keyboardType: 'email-address', maxLength: 254, ...props }) });
  shared.add(env.PersonDetailsFields); shared.add(env.UPIAddressField);
  if (!env.CloseDialogActions) { env.CloseDialogActions = ({ onClose, title = 'Done', ...props }: any) => env.React.createElement(env.Dialog?.Actions ?? 'Dialog.Actions', {}, env.React.createElement(env.Button, { title, ...props, onPress: onClose })); shared.add(env.CloseDialogActions); }
  for (const { build } of programs) {
    for (const [name, value] of Object.entries(build(env))) if (!(name in env)) { env[name] = value; if (typeof value === 'function') shared.add(value as Function); }
  }
  return env as T & Record<string, any>;
}
