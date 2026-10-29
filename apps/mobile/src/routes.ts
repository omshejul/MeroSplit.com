export type Screen = 'savedChanges' | 'signInMethods' | 'home' | 'create' | 'group' | 'expense' | 'expenseDetail' | 'expenseIcon' | 'expenseVersions' | 'billChat' | 'settle' | 'members' | 'login' | 'review' | 'paymentDetail' | 'import' | 'sheet';
export type RouteParams = { tab?: string; groupId?: string | null; expenseId?: string | null; settlementId?: string | null; sheetId?: string; ownerKey?: string };
export type AppRoute = { key?: string; name: Screen; params?: RouteParams };
export type Routes = { [Name in Screen]: RouteParams | undefined };
export const screenNames: Screen[] = ['home', 'login', 'group', 'create', 'expense', 'expenseDetail', 'expenseIcon', 'expenseVersions', 'billChat', 'settle', 'members', 'review', 'paymentDetail', 'savedChanges', 'signInMethods', 'import', 'sheet'];
const grouped: Screen[] = ['group', 'expense', 'expenseDetail', 'expenseIcon', 'expenseVersions', 'billChat', 'settle', 'members', 'review', 'paymentDetail'];

export function contentRoute(state: { index: number; routes: readonly { key?: string; name: string; params?: object }[] }): AppRoute {
  const routes = state.routes as readonly AppRoute[];
  const top = routes[state.index];
  return top.name === 'sheet' ? routes.slice(0, state.index).findLast(route => route.key === top.params?.ownerKey) ?? routes[state.index - 1] ?? top : top;
}

export function destination(current: AppRoute, name: Screen, params: RouteParams = {}): AppRoute {
  const previous = current.params ?? {};
  return { name, params: { tab: params.tab ?? previous.tab ?? 'Groups', ...(grouped.includes(name) ? {
    groupId: params.groupId ?? previous.groupId,
    ...(['expense', 'expenseDetail', 'expenseIcon', 'expenseVersions', 'billChat'].includes(name) ? { expenseId: params.expenseId === undefined ? previous.expenseId : params.expenseId } : {}),
    ...(name === 'paymentDetail' ? { settlementId: params.settlementId ?? previous.settlementId } : {}),
  } : {}) } };
}

export function sameRoute(left: AppRoute, right: AppRoute) {
  return left.name === right.name && left.params?.groupId === right.params?.groupId
    && left.params?.expenseId === right.params?.expenseId && left.params?.settlementId === right.params?.settlementId;
}

// Used only to fill missing parents on cold links. The navigator owns the live stack.
export function routeParents(route: AppRoute): AppRoute[] {
  const params = route.params ?? {}, home: AppRoute = { name: 'home', params: { tab: params.tab ?? (route.name === 'signInMethods' || route.name === 'import' ? 'Account' : 'Groups') } };
  if (route.name === 'home' || route.name === 'login') return [];
  if (!grouped.includes(route.name) || !params.groupId) return [home];
  const group = destination(route, 'group');
  if (route.name === 'group') return [home];
  if (['billChat', 'expenseVersions', 'expenseIcon'].includes(route.name) && params.expenseId) return [home, group, destination(route, 'expenseDetail')];
  return [home, group];
}

export const routePaths = {
  home: 'app', login: 'app/sign-in', group: 'app/groups/:groupId', create: 'app/new-group',
  expense: 'app/groups/:groupId/draft/:expenseId?', expenseDetail: 'app/groups/:groupId/bills/:expenseId',
  expenseIcon: 'app/groups/:groupId/bills/:expenseId/icon',
  expenseVersions: 'app/groups/:groupId/bills/:expenseId/versions', billChat: { path: 'app/chat/:groupId/:expenseId', alias: ['app/groups/:groupId/bills/:expenseId/chat'] },
  settle: 'app/groups/:groupId/payment', members: 'app/groups/:groupId/settings', review: 'app/groups/:groupId/review',
  paymentDetail: 'app/groups/:groupId/payments/:settlementId', savedChanges: 'app/saved-changes', signInMethods: 'app/sign-in-methods', import: 'app/import',
};
